# Phase 5B — Broadcast & Campaign Engine: Technical Specification
# Enterprise Omnichannel Platform
# Audience: AI coding assistant / developer

---

## OVERVIEW

Broadcast engine mengirim pesan ke banyak contact sekaligus — bisa ratusan
hingga jutaan penerima. Tantangan utamanya bukan di logika bisnis,
melainkan di tiga constraint teknis:

  1. Provider rate limit  — WhatsApp max ~80 msg/detik per WABA
  2. Reliability          — jika worker crash di tengah jalan, progress tidak hilang
  3. Observability        — admin harus bisa lihat progress real-time

Prinsip: broadcast adalah proses async yang bisa berjalan berjam-jam.
UI tidak boleh menunggu — hanya monitor progress.

---

## 1. DATA MODEL

### SQL Server — tabel `broadcast_campaigns`

```sql
CREATE TABLE broadcast_campaigns (
    id                  UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id          UNIQUEIDENTIFIER NOT NULL,
    channel_id          UNIQUEIDENTIFIER NOT NULL,     -- channel yang digunakan untuk kirim
    name                NVARCHAR(150) NOT NULL,
    status              NVARCHAR(20)  NOT NULL DEFAULT 'draft',
    -- status values: draft | scheduled | running | paused | completed | failed | cancelled

    template_id         UNIQUEIDENTIFIER NULL,         -- jika pakai WhatsApp HSM template
    message_content     NVARCHAR(MAX)  NULL,           -- JSON: { content_type, content }
    -- catatan: untuk WhatsApp, HARUS pakai template (HSM) karena policy Meta

    audience_type       NVARCHAR(20)  NOT NULL,        -- 'all' | 'tag' | 'segment' | 'upload'
    audience_config     NVARCHAR(MAX) NULL,            -- JSON config untuk filter audience
    audience_snapshot_id UNIQUEIDENTIFIER NULL,        -- FK ke tabel audience_snapshots

    scheduled_at        DATETIME2 NULL,                -- NULL = langsung saat di-trigger
    started_at          DATETIME2 NULL,
    completed_at        DATETIME2 NULL,
    paused_at           DATETIME2 NULL,

    total_recipients    INT DEFAULT 0,
    sent_count          INT DEFAULT 0,
    delivered_count     INT DEFAULT 0,
    read_count          INT DEFAULT 0,
    failed_count        INT DEFAULT 0,
    opted_out_count     INT DEFAULT 0,

    rate_limit_per_minute INT DEFAULT 60,              -- bisa di-override per campaign
    created_by          UNIQUEIDENTIFIER NULL,
    created_at          DATETIME2 DEFAULT GETUTCDATE(),
    updated_at          DATETIME2 DEFAULT GETUTCDATE(),

    CONSTRAINT fk_campaigns_company  FOREIGN KEY (company_id)  REFERENCES companies(id),
    CONSTRAINT fk_campaigns_channel  FOREIGN KEY (channel_id)  REFERENCES channels(id)
);

CREATE INDEX idx_campaigns_company_status  ON broadcast_campaigns (company_id, status);
CREATE INDEX idx_campaigns_scheduled       ON broadcast_campaigns (status, scheduled_at)
    WHERE scheduled_at IS NOT NULL;
```

### SQL Server — tabel `audience_snapshots`

```sql
-- Menyimpan daftar recipient yang sudah di-resolve saat campaign mulai.
-- Penting: snapshot diambil saat kampanye di-launch, bukan real-time.
-- Jika contact ditambah setelah campaign berjalan → tidak termasuk batch ini.

CREATE TABLE audience_snapshots (
    id              UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    campaign_id     UNIQUEIDENTIFIER NOT NULL,
    company_id      UNIQUEIDENTIFIER NOT NULL,
    total_count     INT NOT NULL,
    created_at      DATETIME2 DEFAULT GETUTCDATE(),

    CONSTRAINT fk_snapshot_campaign FOREIGN KEY (campaign_id)
        REFERENCES broadcast_campaigns(id)
);

CREATE TABLE audience_snapshot_recipients (
    id              BIGINT IDENTITY PRIMARY KEY,
    snapshot_id     UNIQUEIDENTIFIER NOT NULL,
    contact_id      UNIQUEIDENTIFIER NOT NULL,
    channel_identity NVARCHAR(200) NOT NULL,          -- nomor WA, email, dll
    variables       NVARCHAR(MAX)  NULL,              -- JSON: personalisasi per recipient
    status          NVARCHAR(20)   NOT NULL DEFAULT 'pending',
    -- status: pending | sent | delivered | read | failed | opted_out
    error_code      NVARCHAR(50)   NULL,
    processed_at    DATETIME2      NULL,

    CONSTRAINT fk_recipient_snapshot FOREIGN KEY (snapshot_id)
        REFERENCES audience_snapshots(id)
);

CREATE INDEX idx_recipients_snapshot_status
    ON audience_snapshot_recipients (snapshot_id, status);
CREATE INDEX idx_recipients_pending
    ON audience_snapshot_recipients (snapshot_id, status, id)
    WHERE status = 'pending';
```

### SQL Server — tabel `message_templates`

```sql
-- WhatsApp HSM (Highly Structured Message) yang sudah disetujui Meta.
-- Untuk channel lain: template bebas (tidak perlu approval).

CREATE TABLE message_templates (
    id                  UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id          UNIQUEIDENTIFIER NOT NULL,
    channel_id          UNIQUEIDENTIFIER NULL,         -- NULL = semua channel
    name                NVARCHAR(100) NOT NULL,
    channel_type        NVARCHAR(30)  NOT NULL,
    category            NVARCHAR(50)  NULL,            -- MARKETING | UTILITY | AUTHENTICATION
    language            NVARCHAR(10)  NOT NULL DEFAULT 'id',
    status              NVARCHAR(20)  NOT NULL DEFAULT 'pending',
    -- status: pending | approved | rejected | disabled

    -- Untuk WhatsApp HSM
    wa_template_name    NVARCHAR(100) NULL,            -- nama di Meta Business Manager
    wa_template_id      NVARCHAR(100) NULL,

    components          NVARCHAR(MAX) NOT NULL,        -- JSON: header, body, footer, buttons
    variables_schema    NVARCHAR(MAX) NULL,            -- JSON: definisi variable yang bisa diisi
    -- Contoh: [{ "key": "customer_name", "label": "Nama Pelanggan", "type": "text" }]

    preview_text        NVARCHAR(MAX) NULL,            -- rendered preview dengan dummy values
    rejection_reason    NVARCHAR(500) NULL,
    created_at          DATETIME2 DEFAULT GETUTCDATE(),
    updated_at          DATETIME2 DEFAULT GETUTCDATE(),

    CONSTRAINT fk_templates_company FOREIGN KEY (company_id) REFERENCES companies(id),
    CONSTRAINT uq_template_name     UNIQUE (company_id, channel_type, wa_template_name)
);
```

---

## 2. CAMPAIGN LIFECYCLE & STATE MACHINE

```
draft ──[schedule/launch]──→ scheduled ──[time reached]──→ running
                                                              │
                         ┌────────────────────────────────────┤
                         ↓                                    │
                       paused ──[resume]──────────────────→ running
                         │
                    [cancel] ↓
                        cancelled

running ──[all sent]──→ completed
running ──[fatal error]──→ failed
```

### Transisi yang memerlukan validasi sebelum diizinkan:

```
draft → scheduled/running:
  - channel.is_active = true
  - Jika WhatsApp: template.status = 'approved'
  - audience tidak kosong (minimal 1 recipient)
  - scheduled_at > now() jika di-schedule
  - company tidak melampaui quota broadcast bulanan

running → paused:
  - Bisa dilakukan kapan saja oleh admin/supervisor
  - Semua job yang sedang dalam queue harus di-drain dulu (tidak di-cancel di tengah jalan)

paused → cancelled:
  - Update semua recipient yang masih 'pending' → 'cancelled'
```

---

## 3. AUDIENCE SEGMENTATION

### Tipe audience yang harus didukung:

#### `all` — semua contact aktif company:
```sql
SELECT c.id, ci.external_id AS channel_identity
FROM contacts c
JOIN contact_channel_identities ci ON ci.contact_id = c.id
    AND ci.channel_type = :channel_type
WHERE c.company_id = :company_id
  AND c.deleted_at IS NULL
```

#### `tag` — filter berdasarkan tag contact:
```sql
-- audience_config = { "tags": ["vip", "active"] }
-- Logic: contact yang memiliki SEMUA tag yang diminta (AND logic)
SELECT c.id, ci.external_id
FROM contacts c
JOIN contact_channel_identities ci ON ...
WHERE c.company_id = :company_id
  AND c.deleted_at IS NULL
  AND (
    SELECT COUNT(DISTINCT value)
    FROM OPENJSON(c.tags)
    WHERE value IN ('vip', 'active')
  ) = 2  -- jumlah tag yang diminta
```

#### `segment` — filter dinamis berdasarkan kriteria:
```json
{
  "operator": "AND",
  "conditions": [
    { "field": "lifetime_conversation_count", "op": "gte", "value": 5 },
    { "field": "last_contacted_at", "op": "gte", "value": "2024-01-01" },
    { "field": "custom_attributes.city", "op": "eq", "value": "Jakarta" }
  ]
}
```

#### `upload` — CSV upload daftar penerima:
```
Format CSV:
  phone_number, name, [variable_1], [variable_2], ...
  +6281234567890, Budi, ORDER-001, 150000

Processing:
  1. Upload CSV ke temporary storage
  2. Parse dan validasi setiap baris
  3. Normalize phone number ke E.164
  4. Lookup contact_id dari contact_channel_identities
  5. Jika tidak ditemukan → buat contact + identity baru (atau skip, tergantung config)
  6. Simpan ke audience_snapshot_recipients
```

---

## 4. BROADCAST EXECUTION ENGINE

### Architecture: Chunked Queue Processing

```
Campaign launch
    │
    ▼
[BuildAudienceJob]          ← Query & snapshot semua recipient ke SQL
    │                         Bagi menjadi chunk 100 recipient
    ▼
[ProcessBroadcastChunkJob]  ← Satu job per chunk
    │                         Kirim ke setiap recipient di chunk
    │                         Respect rate limit
    ▼
[UpdateCampaignStatsJob]    ← Aggregate stats ke broadcast_campaigns
```

### Job: `BuildAudienceJob`

```
Input: campaign_id

1. Load campaign dari SQL
2. Resolve audience berdasarkan audience_type + audience_config
3. Buat audience_snapshot record
4. Insert semua recipient ke audience_snapshot_recipients (batch insert, 500 per batch)
5. Update broadcast_campaigns:
   total_recipients = jumlah recipient
   status = 'running'
   started_at = now()
6. Bagi recipients menjadi chunk-chunk (100 per chunk)
7. Untuk setiap chunk: dispatch ProcessBroadcastChunkJob
   - Dengan delay yang di-calculate untuk respect rate limit:
     chunk_index 0 → delay 0
     chunk_index 1 → delay = 60 / rate_per_minute * 100 detik
     dst.
   - Jangan dispatch semua sekaligus → akan overflow queue
   - Gunakan pattern: dispatch 1 chunk → di akhir job dispatch chunk berikutnya
```

### Job: `ProcessBroadcastChunkJob`

```
Input: campaign_id, snapshot_id, chunk_start_id, chunk_end_id

1. Cek campaign.status — jika 'paused' atau 'cancelled' → stop (no-op)

2. Ambil recipients untuk chunk ini:
   SELECT * FROM audience_snapshot_recipients
   WHERE snapshot_id = :id
     AND status = 'pending'
     AND id BETWEEN :start AND :end
   ORDER BY id ASC

3. Untuk setiap recipient:

   a. Rate limit check (Redis):
      Key: ratelimit:broadcast:{company_id}:{channel_id}:{minute_window}
      Jika melampaui limit → re-queue recipient ini dengan delay

   b. Load template + render pesan:
      Replace variable dari recipient.variables:
      "Halo {{customer_name}}" → "Halo Budi"

   c. Kirim via Channel Adapter

   d. Update recipient status:
      → Kirim berhasil: status = 'sent', processed_at = now()
      → Kirim gagal: status = 'failed', error_code = ...

4. Setelah semua recipient di chunk diproses:
   Dispatch UpdateCampaignStatsJob

5. Dispatch chunk berikutnya (jika ada):
   ProcessBroadcastChunkJob untuk chunk index + 1
```

### CRITICAL — Idempotency di broadcast:

```
Jika job di-retry (karena crash/timeout), recipient yang sudah 'sent'
tidak boleh dikirim ulang.

Solusi: Step 2 di atas hanya ambil status = 'pending'.
Recipient yang sudah 'sent' tidak akan diambil ulang.

Ini kenapa UPDATE status ke 'sent' harus dilakukan SETELAH kirim berhasil,
bukan sebelumnya.
```

### Job: `UpdateCampaignStatsJob`

```
1. Aggregate dari audience_snapshot_recipients:
   SELECT
     COUNT(*) FILTER (WHERE status = 'sent')       AS sent_count,
     COUNT(*) FILTER (WHERE status = 'delivered')  AS delivered_count,
     COUNT(*) FILTER (WHERE status = 'read')       AS read_count,
     COUNT(*) FILTER (WHERE status = 'failed')     AS failed_count
   WHERE snapshot_id = :id

2. UPDATE broadcast_campaigns SET
   sent_count = ..., delivered_count = ..., ...

3. Cek apakah semua recipient sudah diproses:
   Jika pending_count = 0 → UPDATE status = 'completed', completed_at = now()

4. Publish ke Redis untuk update real-time di dashboard:
   PUBLISH channel:events:{company_id} {
     type: 'BROADCAST_PROGRESS',
     payload: { campaign_id, sent, delivered, failed, total }
   }
```

---

## 5. DELIVERY STATUS UPDATE

Provider (WhatsApp) akan mengirim webhook delivery status (delivered/read/failed)
untuk setiap pesan broadcast. Webhook ini masuk ke Gateway (Phase 2) sebagai
`STATUS_UPDATE` event.

Laravel consumer harus meng-handle ini dengan cara berbeda dari pesan biasa:

```
Saat StatusUpdate event masuk:
1. Lookup provider_message_id di MongoDB messages collection
2. Cek apakah message.is_broadcast = true (tambahkan field ini)
3. Jika ya:
   a. Update status di MongoDB message
   b. Update status di audience_snapshot_recipients
      WHERE campaign_id = message.campaign_id
        AND contact_id  = message.contact_id
   c. HINCRBY di Redis broadcast stats:
      HINCRBY broadcast:{company_id}:{campaign_id}:stats delivered 1
```

---

## 6. PAUSE & RESUME

### Pause:
```
1. UPDATE broadcast_campaigns SET status = 'paused', paused_at = now()
2. Job yang sedang berjalan akan cek status di awal (Step 1 di ProcessBroadcastChunkJob)
   dan langsung stop jika 'paused'
3. Redis key untuk rate limit tetap ada — tidak perlu di-reset
4. Delayed jobs yang belum dieksekusi: Laravel Queue tidak punya built-in cancel.
   Solusi: setiap job cek campaign.status di awal. Jika bukan 'running', no-op.
```

### Resume:
```
1. UPDATE broadcast_campaigns SET status = 'running', paused_at = null
2. Hitung remaining recipients: SELECT COUNT(*) WHERE status = 'pending'
3. Re-dispatch ProcessBroadcastChunkJob untuk recipient yang tersisa
   (mulai dari ID terkecil yang masih 'pending')
```

---

## 7. TEMPLATE MANAGEMENT

### WhatsApp HSM Template Approval Flow:

```
Admin buat template di dashboard
    │
    ▼
POST /api/templates
  → Simpan ke message_templates (status = 'pending')
  → Submit ke Meta Business API:
    POST https://graph.facebook.com/v17.0/{phone_number_id}/message_templates
  → Simpan wa_template_id dari response

Meta review (manual, bisa 24-48 jam)
    │
    ▼
Meta kirim webhook saat status berubah:
  → Update message_templates.status (approved/rejected)
  → Jika rejected: simpan rejection_reason
  → Notify admin via email / in-app notification
```

### Variable substitution di template:

Template body: `"Halo {{1}}, pesanan {{2}} Anda sudah dikirim."`

`variables_schema` mendefinisikan mapping:
```json
[
  { "position": 1, "key": "customer_name", "label": "Nama Pelanggan" },
  { "position": 2, "key": "order_number",  "label": "Nomor Pesanan" }
]
```

Saat broadcast: `recipient.variables = { "customer_name": "Budi", "order_number": "ORD-001" }`

Render: replace `{{1}}` dengan `Budi`, `{{2}}` dengan `ORD-001`

---

## 8. BROADCAST DASHBOARD (Frontend)

### Halaman: `/broadcast`

#### Tab 1 — Campaign List:
```
Tabel: Nama | Channel | Status | Total | Sent | Delivered | Scheduled At | Aksi
Status badge: Draft(abu) | Running(hijau animasi) | Paused(kuning) | Completed(biru) | Failed(merah)
Aksi per row: View, Pause/Resume, Duplicate, Cancel
```

#### Tab 2 — Campaign Detail (saat row diklik):

```
Header: nama campaign, status, progress bar
Stats cards: Total | Sent | Delivered | Read | Failed

Progress bar:
  [████████████░░░░░░] 68% — 680 / 1000 terkirim

Real-time update via Socket.io:
  socket.on('broadcast:progress', (data) => {
    if (data.campaign_id === activeCampaignId) {
      updateStats(data);
    }
  })

Recipient table (paginated, 50 per halaman):
  Contact | Channel Identity | Status | Sent At | Error (jika failed)
  Filter by status: All | Pending | Sent | Delivered | Failed
```

#### Tab 3 — Create Campaign (wizard):

```
Step 1: Nama + pilih channel
Step 2: Pilih/buat template
Step 3: Tentukan audience (radio: All | By Tag | Segment | Upload CSV)
Step 4: Jadwal (Now atau pilih tanggal/waktu)
Step 5: Review & Launch
         - Tampilkan estimated recipient count
         - Estimated completion time berdasarkan rate limit
         - Warning jika quota hampir habis
```

---

## 9. TESTING CHECKLIST

- [ ] Campaign dengan 1000 recipient selesai tanpa duplikat kirim
- [ ] Pause di tengah kampanye → tidak ada kirim baru, yang sudah di-queue selesai
- [ ] Resume setelah pause → lanjut dari recipient yang belum terkirim
- [ ] Job crash di tengah chunk → retry hanya kirim recipient yang masih 'pending'
- [ ] Rate limit 60/menit terpenuhi — tidak melebihi
- [ ] Delivery status dari webhook update stats dengan benar
- [ ] Template variable di-render dengan benar per recipient
- [ ] CSV upload: baris invalid di-skip, baris valid tetap diproses
- [ ] Campaign dengan 0 recipient tidak bisa di-launch
- [ ] Quota bulanan terlampaui → campaign di-block saat launch
