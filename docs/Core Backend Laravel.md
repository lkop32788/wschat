# Phase 3 — Core Backend (Laravel): Technical Specification
# Enterprise Omnichannel Platform
# Status: Ready for implementation
# Audience: AI coding assistant / developer

---

## OVERVIEW

Phase 3 adalah Laravel aplikasi yang berfungsi sebagai **Message Consumer + Business Logic Engine**.

Tugasnya adalah membaca canonical message dari RabbitMQ (output Phase 2),
menjalankan seluruh logika bisnis, lalu mendistribusikan hasilnya ke:
- MongoDB     → simpan isi pesan
- SQL Server  → update header conversation
- Redis       → update state realtime
- RabbitMQ    → publish event ke Realtime Server (Socket.io)

---

## KOMPONEN YANG HARUS DIBANGUN

1. RabbitMQ Consumer (Queue Worker)
2. Identity Resolution Service
3. Conversation Orchestrator
4. Message Persistence Service
5. Failover / Channel Routing Service
6. Outbound Message Service
7. Internal REST API (untuk Gateway & Realtime Server)

---

## 1. RABBITMQ CONSUMER (Queue Worker)

### Teknologi
- Laravel Queue dengan custom connection driver untuk RabbitMQ
- Gunakan package: `vladimir-yuldashev/laravel-queue-rabbitmq`
- Atau implementasi manual dengan `php-amqplib/php-amqplib` jika butuh kontrol lebih

### Queue yang harus di-consume
```
inbound.whatsapp
inbound.line
inbound.email
inbound.telegram
inbound.sms
```

### Command yang harus dibuat
```
php artisan queue:work rabbitmq --queue=inbound.whatsapp --tries=3 --backoff=5,30,60
```

### Job Class: `ProcessInboundMessage`

**Input (dari queue payload):**
```json
{
  "event_id": "uuid-v4",
  "company_id": "uuid",
  "channel_id": "uuid",
  "channel_type": "whatsapp",
  "direction": "inbound",
  "idempotency_key": "wamid.xxx",
  "sender_external_id": "+6281234567890",
  "sender_name": "Budi Santoso",
  "sender_avatar": null,
  "content_type": "text",
  "content": { "body": "Halo, saya mau tanya soal tagihan" },
  "quoted_message_id": null,
  "conversation_ref_id": null,
  "provider_timestamp": "2024-01-15T10:30:00Z",
  "received_at": "2024-01-15T10:30:01Z",
  "raw_payload": {}
}
```

### Urutan eksekusi dalam Job (HARUS dalam urutan ini):

```
1. Idempotency check (SQL) → skip jika sudah diproses
2. Identity Resolution      → dapat atau buat contact_id
3. Conversation Lookup      → dapat atau buat conversation_id
4. Persist message          → simpan ke MongoDB
5. Update conversation      → update header di SQL
6. Trigger dispatcher       → assign agent jika pending
7. Publish realtime event   → notify frontend via broker
8. Mark idempotency         → tandai event_id sebagai selesai
```

### Retry & Dead Letter Policy
- `$tries = 3`
- `$backoff = [5, 30, 60]` (detik)
- Jika gagal 3x → masuk DLX queue `dead.letters`
- Wajib log ke tabel `failed_webhook_events` sebelum throw ke DLX

### Tabel `failed_webhook_events` yang harus ada di SQL:
```sql
CREATE TABLE failed_webhook_events (
    id          BIGINT IDENTITY PRIMARY KEY,
    event_id    UNIQUEIDENTIFIER NOT NULL,
    company_id  UNIQUEIDENTIFIER NOT NULL,
    channel_type NVARCHAR(30),
    payload     NVARCHAR(MAX),   -- JSON
    error       NVARCHAR(MAX),
    attempt     TINYINT,
    created_at  DATETIME2 DEFAULT GETUTCDATE()
);
CREATE INDEX idx_failed_events ON failed_webhook_events (company_id, created_at);
```

---

## 2. IDENTITY RESOLUTION SERVICE

### Tujuan
Menemukan atau membuat `Contact` berdasarkan `sender_external_id` + `channel_type`.

### Class: `IdentityResolutionService`

### Method utama: `resolve(string $companyId, string $channelType, string $externalId, array $profile): Contact`

### Algoritma EKSAK (ikuti urutan ini):

```
STEP 1 — Cari di contact_channel_identities
  Query:
    SELECT contact_id FROM contact_channel_identities
    WHERE company_id     = :company_id
      AND channel_type   = :channel_type
      AND external_id    = :external_id

  → FOUND: return Contact dengan contact_id tersebut
  → NOT FOUND: lanjut ke STEP 2

STEP 2 — Coba match via email/phone (cross-channel identity merge kandidat)
  Jika channel_type = 'email':
    Cari Contact WHERE company_id = :company_id AND email = :external_id
  Jika channel_type IN ('whatsapp', 'sms'):
    Cari Contact WHERE company_id = :company_id AND phone = :external_id

  → FOUND: tambahkan identity baru ke contact yang sudah ada (STEP 2B), return Contact
  → NOT FOUND: lanjut ke STEP 3

STEP 2B — Tambah identity ke contact existing:
  INSERT INTO contact_channel_identities
    (contact_id, company_id, channel_type, external_id, display_name, ...)
  VALUES (...)

STEP 3 — Buat Contact baru + Identity baru
  Gunakan DB::transaction()
  INSERT contacts + INSERT contact_channel_identities dalam satu transaksi

  → Return Contact baru
```

### Race Condition yang HARUS di-handle:

**Skenario:** Dua pesan dari kontak yang sama masuk hampir bersamaan.
Dua worker job berjalan paralel. Keduanya sampai di STEP 3 dan mencoba
INSERT contact baru secara bersamaan.

**Solusi:** Gunakan `INSERT OR IGNORE` pattern dengan unique constraint:

```php
// contact_channel_identities sudah punya UNIQUE(company_id, channel_type, external_id)
// Gunakan try-catch untuk IntegrityConstraintViolationException:

try {
    DB::transaction(function() use (...) {
        $contact = Contact::create([...]);
        ContactChannelIdentity::create([...]);
    });
} catch (\Illuminate\Database\QueryException $e) {
    if ($e->getCode() === '23000') { // duplicate key
        // Worker lain sudah buat contact — re-query dan return
        return $this->resolve($companyId, $channelType, $externalId, $profile);
    }
    throw $e;
}
```

### Update profile (jika contact sudah ada):
Jika `sender_name` dari payload berbeda dengan `display_name` di DB:
- Update `contact_channel_identities.display_name`
- Jangan update `contacts.name` jika sudah diisi manual oleh agen
  (cek kolom `contacts.name_is_manual BOOLEAN` — tambah kolom ini)

---

## 3. CONVERSATION ORCHESTRATOR

### Tujuan
Menemukan conversation aktif yang relevan, atau membuat conversation baru.

### Class: `ConversationOrchestrator`

### Method: `findOrCreate(string $companyId, string $channelId, string $contactId, CanonicalMessage $message): Conversation`

### Algoritma EKSAK:

```
STEP 1 — Cari conversation aktif (status IN ('pending', 'open'))
  Query:
    SELECT TOP 1 id, status, assigned_agent_id
    FROM conversations
    WHERE company_id  = :company_id
      AND channel_id  = :channel_id
      AND contact_id  = :contact_id
      AND status      IN ('pending', 'open')
    ORDER BY last_message_at DESC

  → FOUND: return Conversation tersebut (UPDATE last_message_at, message_count)
  → NOT FOUND: lanjut ke STEP 2

STEP 2 — Cek apakah ada conversation 'snoozed' yang harus di-reopen
  Query:
    SELECT TOP 1 id FROM conversations
    WHERE company_id = :company_id
      AND channel_id = :channel_id
      AND contact_id = :contact_id
      AND status     = 'snoozed'
    ORDER BY last_message_at DESC

  → FOUND: UPDATE status = 'open', snoozed_until = NULL, return Conversation
  → NOT FOUND: lanjut ke STEP 3

STEP 3 — Buat conversation baru
  INSERT conversations dengan:
    status                = 'pending'
    last_message_preview  = ambil 150 char pertama dari content
    last_message_at       = NOW()
    last_message_direction = 'inbound'
    unread_count          = 1
    message_count         = 1

  → Return Conversation baru
```

### Method: `updateAfterMessage(Conversation $conv, CanonicalMessage $message): void`

Field yang harus di-UPDATE setiap ada pesan masuk:
```sql
UPDATE conversations SET
  last_message_preview   = :preview,    -- 150 char dari content
  last_message_at        = :timestamp,
  last_message_direction = 'inbound',
  message_count          = message_count + 1,
  unread_count           = unread_count + 1,
  updated_at             = GETUTCDATE()
WHERE id = :conversation_id
```

### Preview generation rules:
```
content_type = 'text'     → content.body (truncate 150 char)
content_type = 'image'    → "📷 Foto"   (jangan emoji — gunakan "[Foto]")
content_type = 'audio'    → "[Pesan suara]"
content_type = 'video'    → "[Video]"
content_type = 'file'     → "[File: {filename}]"
content_type = 'location' → "[Lokasi]"
content_type = 'sticker'  → "[Sticker]"
content_type lainnya      → "[Pesan]"
```

### Race Condition yang HARUS di-handle:

**Skenario:** Dua pesan masuk bersamaan dari kontak yang sama,
keduanya sampai di STEP 3 (create new conversation) secara bersamaan.

**Solusi:** Gunakan `updateOrCreate` dengan unique constraint
atau pessimistic locking:

```php
// Opsi 1: WITH (UPDLOCK, HOLDLOCK) hint di SQL Server
// Opsi 2: Cache lock dengan Redis sebelum query

$lock = Cache::lock("conv_create:{$companyId}:{$channelId}:{$contactId}", 5);
if ($lock->get()) {
    try {
        // Lakukan find-or-create di dalam lock
    } finally {
        $lock->release();
    }
}
```

---

## 4. MESSAGE PERSISTENCE SERVICE

### Tujuan
Menyimpan isi pesan ke MongoDB.

### Class: `MessagePersistenceService`

### Method: `persist(Conversation $conv, Contact $contact, CanonicalMessage $message): string`
Returns: MongoDB `_id` (string)

### MongoDB document yang harus dibuat:

```json
{
  "company_id": "uuid dari SQL",
  "conversation_id": "uuid dari SQL",
  "channel_id": "uuid dari SQL",
  "channel_type": "whatsapp",
  "direction": "inbound",
  "sender_type": "contact",
  "sender_id": "contact_id dari SQL",
  "content_type": "text",
  "content": {
    "body": "Halo, saya mau tanya soal tagihan"
  },
  "quoted_message_id": null,
  "status": "delivered",
  "provider_message_id": "wamid.xxx",
  "provider_timestamp": "ISODate(...)",
  "is_deleted": false,
  "is_automated": false,
  "created_at": "ISODate(...)",
  "updated_at": "ISODate(...)"
}
```

### Mapping `status` untuk inbound messages:
```
Semua inbound message = status "delivered"
(karena jika sudah ada di sistem berarti sudah terdeliver ke kita)
```

### Idempotency di level MongoDB:
Gunakan index `{ company_id, channel_type, provider_message_id }` yang sudah unique.
Jika insert duplikat → catch `BulkWriteException` dengan code 11000, return `_id` yang sudah ada.

### Koneksi MongoDB di Laravel:
- Gunakan package `mongodb/laravel-mongodb`
- Definisikan connection terpisah di `config/database.php`
- Buat Model `Message` yang extend `MongoDB\Laravel\Eloquent\Model`

---

## 5. FAILOVER / CHANNEL ROUTING SERVICE

### Tujuan
Handle pengiriman pesan outbound dengan fallback otomatis ke channel lain
jika channel utama gagal.

### Class: `ChannelRoutingService`

### Konfigurasi failover (dari kolom `channels.failover_channel_ids`):
```json
["uuid-channel-sms", "uuid-channel-email"]
```
Artinya: jika kirim via channel utama gagal, coba ke channel pertama di array,
jika masih gagal coba ke channel kedua, dst.

### Method: `send(string $conversationId, array $messagePayload): SendResult`

### Algoritma EKSAK:

```
STEP 1 — Ambil primary channel dari conversation
STEP 2 — Coba kirim via primary channel adapter
  → BERHASIL: return SendResult(success=true, channel_used=primary)
  → GAGAL: lanjut ke STEP 3

STEP 3 — Load failover_channel_ids dari primary channel
  Jika kosong → return SendResult(success=false, error="no_failover")

STEP 4 — Loop melalui failover channels secara berurutan:
  Untuk setiap failover channel:
    → Coba kirim
    → BERHASIL: catat di conversation_failover_log, return SendResult
    → GAGAL: lanjut ke failover berikutnya

STEP 5 — Semua channel gagal:
  UPDATE conversations SET status = 'failed_delivery' (tambah status ini)
  Trigger alert ke supervisor
  return SendResult(success=false, error="all_channels_failed")
```

### Tabel `conversation_failover_log` yang harus dibuat:
```sql
CREATE TABLE conversation_failover_log (
    id                  BIGINT IDENTITY PRIMARY KEY,
    conversation_id     UNIQUEIDENTIFIER NOT NULL,
    company_id          UNIQUEIDENTIFIER NOT NULL,
    attempted_channel_id UNIQUEIDENTIFIER NOT NULL,
    status              NVARCHAR(20),  -- 'success' | 'failed'
    error_code          NVARCHAR(50),
    error_message       NVARCHAR(500),
    created_at          DATETIME2 DEFAULT GETUTCDATE()
);
```

### Channel Adapters yang harus dibuat (interface + implementasi):

```php
interface ChannelAdapterInterface {
    public function send(array $payload): AdapterResult;
    public function getChannelType(): string;
}

class WhatsAppCloudAdapter implements ChannelAdapterInterface { ... }
class LineAdapter implements ChannelAdapterInterface { ... }
class TwilioSmsAdapter implements ChannelAdapterInterface { ... }
class SmtpEmailAdapter implements ChannelAdapterInterface { ... }
```

Adapter di-resolve via Laravel Service Container:
```php
// AppServiceProvider:
$this->app->bind('channel.adapter.whatsapp', WhatsAppCloudAdapter::class);
$this->app->bind('channel.adapter.line',     LineAdapter::class);
// dst.
```

---

## 6. OUTBOUND MESSAGE SERVICE

### Tujuan
Memproses pesan keluar dari agen ke pelanggan.

### Class: `OutboundMessageService`

### Method: `send(string $agentId, string $conversationId, array $content): OutboundResult`

### Validasi yang HARUS dilakukan sebelum kirim:

```
1. Pastikan conversation ada dan status = 'open'
2. Pastikan agentId adalah assigned_agent_id pada conversation tersebut
   (atau user punya role supervisor/admin untuk override)
3. Cek rate limit channel (ambil dari Redis ratelimit:outbound:{company_id}:{channel_id})
4. Pastikan channel is_active = true
```

### Urutan operasi setelah validasi:

```
1. Persist ke MongoDB dulu (status = 'pending')
   → Dapat message MongoDB _id
2. Update conversation.last_message_at, last_message_preview, last_message_direction = 'outbound'
3. Kirim via ChannelRoutingService
4. Update status MongoDB message:
   → Berhasil kirim ke provider API: status = 'sent'
   → Gagal: status = 'failed'
5. Publish realtime event (untuk update UI agen)
```

### Rate Limiting:
```
Ambil config max_per_minute dari channels.settings JSON:
  settings.rate_limit.messages_per_minute (default: 30)

Gunakan Redis INCR + EXPIRE pattern (sudah ada di Phase 1 redis_key_design.js)
Jika rate limit tercapai:
  → Masukkan ke delayed queue dengan TTL sesuai sisa window
  → Jangan reject — queue untuk dikirim nanti
```

---

## 7. INTERNAL REST API

### Tujuan
Endpoint internal untuk komunikasi antar service (Gateway & Realtime Server).
BUKAN untuk akses publik — harus dilindungi dengan internal API key.

### Middleware: `InternalApiKeyMiddleware`
Header yang harus ada: `X-Internal-Key: {INTERNAL_API_KEY dari .env}`

### Endpoints yang harus dibuat:

#### POST `/internal/cache/invalidate/channel`
Dipanggil ketika admin update konfigurasi channel dari dashboard.
Body: `{ "channel_type": "whatsapp", "channel_identifier": "uuid" }`
Action: Delete Redis key `channel:meta:{type}:{identifier}`

#### POST `/internal/agent/heartbeat`
Dipanggil oleh Realtime Server setiap 60 detik per agent yang terkoneksi.
Body: `{ "company_id": "uuid", "agent_id": "uuid", "socket_id": "xxx" }`
Action:
```
HSET agent:presence:{company_id}:{agent_id}
  status         online
  socket_id      {socket_id}
  last_heartbeat {unix_timestamp}
EXPIRE agent:presence:{company_id}:{agent_id} 300

// Tambahkan agent ke skill sets di Redis
// Ambil skill_tags dari users table, lalu:
SADD agent:skill:{company_id}:{skill_tag} {agent_id}
EXPIRE agent:skill:{company_id}:{skill_tag} 300

// Pastikan ada di workload sorted set (score 0 jika belum ada)
ZADD agent:workload:{company_id} NX 0 {agent_id}
```
Response: `200 OK`

#### POST `/internal/agent/offline`
Dipanggil Realtime Server saat agent disconnect.
Body: `{ "company_id": "uuid", "agent_id": "uuid" }`
Action:
```
DEL agent:presence:{company_id}:{agent_id}
// Hapus dari semua skill sets
SREM agent:skill:{company_id}:* {agent_id}
// Jangan hapus dari workload — biarkan decay, agen mungkin reconnect
```

#### GET `/internal/conversations/{id}/state`
Dipanggil Realtime Server untuk verify state sebelum push ke frontend.
Response: conversation header dari SQL + Redis state

---

## 8. DISPATCHER INTEGRATION

### Kapan Dispatcher dipanggil dari Laravel:

```
1. Saat conversation baru dibuat (status = 'pending')
2. Saat conversation di-reopen dari 'resolved'
3. Saat assigned agent logout / go offline (perlu reassign)
4. Saat admin trigger manual reassign
```

### Cara memanggil Dispatcher dari Laravel:

Dispatcher Engine ada di Node.js (Phase 1: `dispatcher_engine.js`).
Laravel memanggil via **Redis Pub/Sub** — publish event, Dispatcher subscribe.

```php
// Publish dispatch request ke Redis channel
Redis::publish('dispatcher:requests', json_encode([
    'action'          => 'DISPATCH',
    'company_id'      => $companyId,
    'conversation_id' => $conversationId,
    'intent_tags'     => $intentTags,
    'priority'        => $priority,
    'requested_at'    => now()->toISOString(),
]));
```

Dispatcher Node.js subscribe ke `dispatcher:requests`, proses,
lalu publish hasilnya ke `dispatcher:results`:
```json
{
  "conversation_id": "uuid",
  "agent_id": "uuid",
  "status": "assigned" | "queued"
}
```

Laravel subscribe ke `dispatcher:results` via Laravel Queue atau
background process terpisah untuk update SQL conversation.

### Alternatif (lebih sederhana):
Jika ingin single-service, implementasi dispatcher logic langsung di Laravel
menggunakan Redis commands yang sama (lihat Phase 1 redis_key_design.js).
Trade-off: lebih sederhana, tapi tidak bisa scale Dispatcher secara independen.

---

## 9. INTENT TAGGING (Simplified)

### Tujuan
Mengisi `conversations.intent_tags` untuk digunakan Dispatcher (skill matching).

### Implementasi minimalis (tanpa ML):

```php
class IntentTagger {
    private array $rules = [
        'billing'   => ['tagihan', 'bayar', 'invoice', 'cicilan', 'denda', 'billing'],
        'technical' => ['error', 'gagal', 'tidak bisa', 'rusak', 'bug', 'tidak muncul'],
        'complaint' => ['komplain', 'kecewa', 'marah', 'mengecewakan', 'buruk'],
        'general'   => [],  // fallback, selalu di-include jika tidak ada match
    ];

    public function tag(string $text): array {
        $text  = mb_strtolower($text);
        $tags  = [];

        foreach ($this->rules as $intent => $keywords) {
            if (empty($keywords)) continue;
            foreach ($keywords as $keyword) {
                if (str_contains($text, $keyword)) {
                    $tags[] = $intent;
                    break;
                }
            }
        }

        return empty($tags) ? ['general'] : array_unique($tags);
    }
}
```

Panggil ini saat conversation pertama kali dibuat,
atau saat pesan pertama setelah reopen.

Update ke SQL: `UPDATE conversations SET intent_tags = :tags WHERE id = :id`

---

## 10. EVENT PUBLISHING KE REALTIME SERVER

### Setiap ada aktivitas di conversation, publish ke Redis:

```php
// Channel: channel:events:{company_id}
// (Realtime Server subscribe ke channel ini)

Redis::publish("channel:events:{$companyId}", json_encode([
    'type'    => 'NEW_MESSAGE',
    'payload' => [
        'conversation_id'    => $conversationId,
        'message_id'         => $mongoMessageId,
        'content_type'       => $contentType,
        'preview'            => $preview,
        'direction'          => 'inbound',
        'sender_name'        => $senderName,
        'channel_type'       => $channelType,
        'timestamp'          => $timestamp,
        'assigned_agent_id'  => $assignedAgentId,
    ]
]));
```

### Event types yang harus di-publish:

| Event Type | Kapan |
|---|---|
| `NEW_MESSAGE` | Setiap pesan inbound masuk |
| `CONVERSATION_ASSIGNED` | Dispatcher selesai assign agent |
| `CONVERSATION_RESOLVED` | Agent close conversation |
| `CONVERSATION_REOPENED` | Contact kirim pesan ke resolved conv |
| `AGENT_TYPING` | Agent sedang mengetik |
| `MESSAGE_STATUS_UPDATE` | delivered / read status dari provider |

---

## 11. ENVIRONMENT VARIABLES YANG DIPERLUKAN

```env
# RabbitMQ
RABBITMQ_HOST=localhost
RABBITMQ_PORT=5672
RABBITMQ_USER=guest
RABBITMQ_PASSWORD=guest
RABBITMQ_VHOST=/

# MongoDB
MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=omnichannel_messages

# SQL Server
DB_CONNECTION=sqlsrv
DB_HOST=localhost
DB_PORT=1433
DB_DATABASE=omnichannel
DB_USERNAME=sa
DB_PASSWORD=

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Internal API
INTERNAL_API_KEY=random-256-bit-hex

# Encryption (untuk channel credentials)
APP_KEY=base64:...
CREDENTIAL_ENCRYPTION_KEY=32-byte-hex-key
```

---

## 12. LARAVEL PACKAGES YANG DIPERLUKAN

```json
{
  "require": {
    "mongodb/laravel-mongodb": "^4.0",
    "vladimir-yuldashev/laravel-queue-rabbitmq": "^13.0",
    "predis/predis": "^2.2"
  }
}
```

---

## 13. URUTAN IMPLEMENTASI YANG DISARANKAN

Implementasikan dalam urutan ini agar bisa test secara incremental:

```
1. Setup koneksi (SQL Server + MongoDB + Redis + RabbitMQ)
2. Model & Migration (jika belum ada dari Phase 1)
3. IdentityResolutionService + unit test
4. ConversationOrchestrator + unit test
5. MessagePersistenceService (MongoDB) + unit test
6. ProcessInboundMessage Job (gabungkan semua)
7. Internal API endpoints
8. ChannelAdapters (mulai dari WhatsApp saja)
9. OutboundMessageService
10. ChannelRoutingService (failover)
11. IntentTagger
12. Event publishing ke Redis
```

---

## 14. TESTING CHECKLIST

Setiap service harus punya test untuk skenario berikut:

### IdentityResolutionService:
- [ ] Contact baru dari channel baru → insert contact + identity
- [ ] Contact sudah ada di channel yang sama → return existing, tidak duplicate
- [ ] Contact sudah ada via email, masuk dari WA → add identity, return existing
- [ ] Dua job paralel untuk contact yang sama → tidak ada duplicate (race condition)

### ConversationOrchestrator:
- [ ] Conversation baru untuk contact baru
- [ ] Pesan kedua dari contact yang sama → reuse conversation yang open
- [ ] Pesan dari contact dengan conversation resolved → buat conversation baru
- [ ] Pesan dari contact dengan conversation snoozed → reopen

### MessagePersistenceService:
- [ ] Insert normal berhasil
- [ ] Insert dengan provider_message_id yang sama → tidak duplicate, return existing _id

### ChannelRoutingService:
- [ ] Kirim berhasil via primary channel
- [ ] Primary gagal → fallback ke channel pertama di failover list
- [ ] Semua channel gagal → return error, catat di log

---

## 15. CATATAN PENTING UNTUK AI IMPLEMENTOR

1. **Semua operasi yang menyentuh dua database berbeda (SQL + MongoDB)
   tidak bisa di-wrap dalam satu DB transaction.**
   Urutan yang aman: SQL dulu, MongoDB kedua.
   Jika MongoDB gagal setelah SQL sukses: retry job akan handle (idempotency).

2. **Jangan pernah UPDATE conversations tanpa WHERE company_id.**
   Selalu sertakan company_id di setiap query untuk keamanan multi-tenant.

3. **Semua credential channel di SQL tersimpan encrypted.**
   Sebelum digunakan di Channel Adapter, decrypt dulu dengan
   `Crypt::decryptString($channel->credentials_encrypted)`.

4. **Redis key naming HARUS mengikuti konvensi dari Phase 1**
   (file: `redis_key_design.js`). Jangan membuat key baru tanpa mengikuti
   format `{scope}:{company_id}:{entity}:{id}`.

5. **Jangan log raw_payload di production log.**
   raw_payload bisa berisi data PII (nama, nomor telepon, isi percakapan).
   Log hanya: event_id, company_id, channel_type, content_type.
```
