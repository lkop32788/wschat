# Phase 5A — Human-Bot Collaboration: Technical Specification
# Enterprise Omnichannel Platform
# Audience: AI coding assistant / developer

---

## OVERVIEW & PRINSIP DESAIN

Bot di platform ini bukan pengganti agen — ia adalah filter pertama.
Tugasnya: tangani pertanyaan sederhana, kumpulkan data awal (nama, nomor order),
lalu serahkan ke agen jika sudah di luar kemampuannya.

Dua komponen utama:
  1. Flow Engine  — backend interpreter yang menjalankan bot flow
  2. Flow Builder — frontend UI untuk admin membuat/edit flow secara visual

Prinsip yang TIDAK boleh dilanggar:
  - Bot tidak boleh "tersesat" tanpa jalan keluar → selalu ada fallback ke human
  - Saat handoff terjadi, agen HARUS melihat semua yang sudah dikumpulkan bot
  - Bot mode dan human mode TIDAK boleh aktif bersamaan dalam satu conversation

---

## 1. DATA MODEL: BOT FLOW

### SQL Server — tabel `bot_flows`

```sql
CREATE TABLE bot_flows (
    id              UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id      UNIQUEIDENTIFIER NOT NULL,
    channel_id      UNIQUEIDENTIFIER NULL,       -- NULL = berlaku untuk semua channel
    name            NVARCHAR(100) NOT NULL,
    description     NVARCHAR(500) NULL,
    trigger_type    NVARCHAR(30)  NOT NULL,      -- 'all_incoming' | 'keyword' | 'outside_hours'
    trigger_config  NVARCHAR(MAX) NULL,          -- JSON: { keywords: ['halo', 'hi'] }
    flow_graph      NVARCHAR(MAX) NOT NULL,      -- JSON: seluruh graph node + edge
    is_active       BIT DEFAULT 1,
    version         INT DEFAULT 1,               -- increment setiap kali di-edit
    created_by      UNIQUEIDENTIFIER NULL,
    created_at      DATETIME2 DEFAULT GETUTCDATE(),
    updated_at      DATETIME2 DEFAULT GETUTCDATE(),

    CONSTRAINT fk_bot_flows_company FOREIGN KEY (company_id)
        REFERENCES companies(id)
);

CREATE INDEX idx_bot_flows_company_active
    ON bot_flows (company_id, is_active, trigger_type);
```

### Struktur `flow_graph` (JSON — disimpan di kolom `flow_graph`):

```json
{
  "start_node_id": "node_001",
  "nodes": {
    "node_001": {
      "id": "node_001",
      "type": "send_message",
      "config": {
        "message": "Halo! Selamat datang di layanan kami. Ada yang bisa kami bantu?",
        "quick_replies": [
          { "id": "qr_tagihan", "label": "Tagihan",   "next_node_id": "node_002" },
          { "id": "qr_teknis",  "label": "Teknikal",  "next_node_id": "node_003" },
          { "id": "qr_lainnya", "label": "Lainnya",   "next_node_id": "node_004" }
        ]
      },
      "next_node_id": "node_010",
      "timeout_seconds": 300,
      "timeout_node_id": "node_020"
    },
    "node_002": {
      "id": "node_002",
      "type": "collect_input",
      "config": {
        "message": "Silakan masukkan nomor tagihan Anda:",
        "variable_name": "invoice_number",
        "validation": {
          "type": "regex",
          "pattern": "^INV-[0-9]{6}$",
          "error_message": "Format tidak valid. Contoh: INV-123456"
        },
        "max_retries": 3,
        "retry_exceeded_node_id": "node_handoff"
      },
      "next_node_id": "node_005"
    },
    "node_003": {
      "id": "node_003",
      "type": "condition",
      "config": {
        "conditions": [
          {
            "variable": "contact.lifetime_conversation_count",
            "operator": "gte",
            "value": 3,
            "next_node_id": "node_handoff"
          }
        ],
        "default_next_node_id": "node_006"
      }
    },
    "node_handoff": {
      "id": "node_handoff",
      "type": "handoff",
      "config": {
        "message": "Menghubungkan Anda ke agen kami. Mohon tunggu...",
        "skill_tags": ["technical"],
        "priority": "high",
        "summary_template": "Pelanggan membutuhkan bantuan teknikal. Nomor invoice: {{invoice_number}}"
      }
    }
  }
}
```

### Node types yang harus didukung:

| Type | Fungsi |
|---|---|
| `send_message` | Kirim teks/template ke contact, opsional dengan quick_replies |
| `collect_input` | Tunggu jawaban contact, simpan ke variable, validasi opsional |
| `condition`     | Branching berdasarkan variable atau contact attribute |
| `set_variable`  | Set variable tanpa interaksi (misal: set tag intent) |
| `api_call`      | HTTP call ke external API, simpan respons ke variable |
| `handoff`       | Transfer ke human agent — node terminal untuk bot |
| `end`           | Akhiri flow (tanpa handoff) — node terminal |
| `jump`          | Loncat ke node lain (untuk loop atau reuse) |

---

## 2. FLOW ENGINE (Laravel Service)

### Class: `BotFlowEngine`

Ini adalah interpreter yang membaca `flow_graph` dan menjalankannya
langkah demi langkah berdasarkan input dari contact.

### State yang disimpan di MongoDB (`bot_sessions` collection):

```json
{
  "company_id": "uuid",
  "conversation_id": "uuid",
  "flow_id": "uuid",
  "flow_version": 1,
  "current_node_id": "node_002",
  "variables": {
    "invoice_number": null,
    "contact_name": "Budi",
    "selected_category": "tagihan"
  },
  "node_visit_count": { "node_002": 1 },
  "retry_count": { "node_002": 0 },
  "is_active": true,
  "started_at": "ISODate",
  "last_interaction_at": "ISODate"
}
```

### Method utama: `processMessage(string $conversationId, CanonicalMessage $message): FlowResult`

#### Algoritma eksak:

```
STEP 1 — Load session dari MongoDB
  Cari bot_sessions WHERE conversation_id = :id AND is_active = true
  Jika tidak ada → ini pesan pertama, cek apakah ada flow yang triggered

STEP 2 — Jika tidak ada session aktif: cek trigger
  Load semua bot_flows company yang is_active = true, ordered by priority
  Untuk setiap flow:
    Evaluasi trigger_type:
      'all_incoming' → selalu triggered
      'keyword'      → cek apakah pesan mengandung salah satu keyword
      'outside_hours'→ cek apakah sekarang di luar jam operasional
  Flow pertama yang match → buat session baru, mulai dari start_node_id
  Tidak ada yang match → biarkan pesan masuk ke inbox (human mode)

STEP 3 — Load node saat ini dari flow_graph
  currentNode = flow.flow_graph.nodes[session.current_node_id]

STEP 4 — Execute node berdasarkan type
  (lihat section per node type di bawah)

STEP 5 — Tentukan next_node_id
  Simpan ke session.current_node_id

STEP 6 — Jika next_node adalah 'handoff' atau 'end':
  Update session.is_active = false
  Jika 'handoff': trigger Dispatcher Engine

STEP 7 — Update session di MongoDB
  Update current_node_id, variables, last_interaction_at
```

### Eksekusi per node type:

#### `send_message`:
```
1. Format pesan (replace {{variable}} dengan nilai dari session.variables)
2. Kirim via ChannelRoutingService (Phase 3, Section 5)
3. Jika ada quick_replies:
   - WhatsApp: kirim sebagai Interactive Button Message
   - LINE: kirim sebagai Quick Reply
   - Lainnya: kirim sebagai teks biasa dengan nomor pilihan
4. next_node = node.next_node_id
5. Jika timeout_seconds ada: schedule timeout job di Laravel Queue
   (dispatch dengan delay = timeout_seconds)
```

#### `collect_input`:
```
1. Jika ini pertama kali di node ini → kirim pesan prompt ke contact
2. Jika ada input dari contact (message yang memicu step ini):
   a. Validate input sesuai config.validation
   b. VALID:
      - Simpan ke session.variables[config.variable_name]
      - next_node = node.next_node_id
   c. INVALID:
      - Increment session.retry_count[node.id]
      - Jika retry >= config.max_retries → next_node = config.retry_exceeded_node_id
      - Jika retry < max_retries → kirim error_message, tetap di node yang sama
```

#### `condition`:
```
Evaluasi setiap kondisi secara berurutan:
  - Variable diambil dari session.variables ATAU contact attributes (prefix "contact.")
  - Operator: eq, neq, gt, gte, lt, lte, contains, not_contains, is_empty, is_not_empty
  - Kondisi pertama yang TRUE → next_node = condition.next_node_id
  - Tidak ada yang TRUE → next_node = condition.default_next_node_id
```

#### `api_call`:
```
1. Build HTTP request dari config (method, url, headers, body)
   - URL dan body bisa mengandung {{variable}} placeholder
2. Execute dengan timeout 10 detik
3. Map respons ke variables sesuai config.response_mapping:
   { "order_status": "$.data.status" }  (JSONPath)
4. Jika request gagal/timeout → next_node = config.error_node_id
```

#### `handoff`:
```
1. Kirim config.message ke contact
2. Format summary untuk agen:
   - Replace {{variable}} di config.summary_template
3. Update conversation di SQL:
   - intent_tags = config.skill_tags (override)
   - priority    = config.priority
4. Set Redis flag: HSET conv:state:{cid}:{convId} is_bot_active 0
5. Publish ke Redis Pub/Sub untuk Dispatcher:
   {
     action: 'DISPATCH',
     conversation_id, company_id,
     intent_tags: config.skill_tags,
     priority: config.priority,
     bot_summary: formatted_summary
   }
6. Update MongoDB bot_session.is_active = false
```

---

## 3. HANDOFF CONTEXT — APA YANG AGEN LIHAT

Ini salah satu bagian paling penting untuk UX agen.
Saat conversation di-handoff dari bot, agen harus langsung tahu konteksnya
tanpa perlu scroll ke atas membaca semua percakapan dengan bot.

### Simpan di SQL `conversations.custom_attributes`:

```json
{
  "bot_handoff_summary": "Pelanggan butuh bantuan tagihan. Nomor invoice: INV-123456",
  "bot_collected_data": {
    "invoice_number": "INV-123456",
    "selected_category": "tagihan"
  },
  "bot_flow_name": "Onboarding Flow v2",
  "bot_handoff_at": "2024-01-15T10:30:00Z"
}
```

### Tampilan di frontend (ConversationHeader — Phase 4B):

Tampilkan banner kuning di atas chat panel saat `bot_handoff_summary` ada:

```
┌─────────────────────────────────────────────────────┐
│ [Robot icon]  Dialihkan dari bot                    │
│  Ringkasan: "Tagihan — INV-123456"                  │
│  [Lihat detail lengkap ▾]                           │
└─────────────────────────────────────────────────────┘
```

Expand "Lihat detail" → tampilkan semua `bot_collected_data` sebagai key-value.

---

## 4. BOT CONFIG STUDIO (Frontend)

### Halaman: `/admin/bot-flows`

Ini adalah visual flow builder. Tidak perlu drag-and-drop yang kompleks
untuk MVP — implementasi berbasis form yang terstruktur sudah cukup.

### Komponen yang dibutuhkan:

#### `FlowList` — daftar semua flow:
```
Tampilkan: nama, channel, trigger type, status (aktif/nonaktif), last updated
Aksi: Create New, Edit, Duplicate, Toggle Active, Delete
```

#### `FlowEditor` — editor satu flow:

Layout dua kolom:
```
┌─────────────────────────────┬──────────────────────────────┐
│  Node List (kiri)           │  Node Editor (kanan)         │
│                             │                              │
│  ● Start                    │  [Node yang dipilih]         │
│    └── node_001             │  Form edit konfigurasi node  │
│        ├── node_002 (tagihan│                              │
│        │   └── node_handoff │                              │
│        └── node_003 (teknis)│                              │
│                             │                              │
│  [+ Add Node]               │                              │
└─────────────────────────────┴──────────────────────────────┘
```

Node List ditampilkan sebagai tree (bukan canvas drag-drop).
Setiap node bisa di-expand untuk melihat child nodes.

#### Form per node type:

`send_message`:
- Textarea untuk pesan (dengan variable picker {{...}})
- Toggle "Tambah Quick Replies"
- Jika toggle on: list input untuk label quick reply + pilih next node

`collect_input`:
- Input pesan prompt
- Input nama variable (alphanumeric, underscore)
- Toggle validasi: pilih type (regex / number / length)
- Input max retries + pilih node jika retry habis

`condition`:
- List kondisi (AND logic antar kondisi dalam satu branch)
- Setiap kondisi: [pilih variable] [pilih operator] [input value] [pilih next node]
- Input default node jika tidak ada kondisi yang match

`handoff`:
- Textarea pesan ke contact
- Multi-select skill tags
- Select priority
- Textarea summary template (dengan variable picker)

### API endpoints yang dibutuhkan (Laravel):

```
GET    /api/bot-flows
POST   /api/bot-flows
GET    /api/bot-flows/{id}
PUT    /api/bot-flows/{id}
DELETE /api/bot-flows/{id}
POST   /api/bot-flows/{id}/activate
POST   /api/bot-flows/{id}/deactivate
POST   /api/bot-flows/{id}/duplicate
```

---

## 5. TIMEOUT HANDLING

Node `send_message` dengan quick_replies perlu timeout
— jika contact tidak merespons dalam N detik, lanjut ke timeout_node.

### Implementasi via Laravel Queue dengan delay:

```php
// Saat node dengan timeout di-execute:
ProcessBotTimeout::dispatch($conversationId, $nodeId, $sessionVersion)
    ->delay(now()->addSeconds($node['timeout_seconds']));

// Di dalam Job ProcessBotTimeout:
// 1. Load session dari MongoDB
// 2. Cek session.version === $sessionVersion
//    Jika beda → contact sudah merespons, session sudah bergerak → cancel (no-op)
//    Jika sama → contact tidak merespons → pindah ke timeout_node_id
```

---

## 6. TESTING CHECKLIST

- [ ] Flow dijalankan dari start_node saat pesan pertama masuk
- [ ] Quick reply memilih branch yang benar
- [ ] collect_input menyimpan variable dengan benar
- [ ] Validasi input menolak format yang salah, hitung retry
- [ ] Retry habis → pindah ke node fallback
- [ ] condition mengambil nilai contact attribute dengan benar
- [ ] api_call timeout → pindah ke error node, tidak hang
- [ ] Handoff: Dispatcher dipanggil dengan skill_tags dari config
- [ ] Handoff: summary tersimpan di conversations.custom_attributes
- [ ] Handoff: Redis is_bot_active = 0 setelah handoff
- [ ] Timeout job: tidak dieksekusi jika contact sudah merespons
- [ ] Dua pesan masuk bersamaan tidak menyebabkan dua session dibuat
