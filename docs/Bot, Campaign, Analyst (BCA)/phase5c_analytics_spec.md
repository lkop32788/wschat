# Phase 5C — Analytics & Reporting: Technical Specification
# Enterprise Omnichannel Platform
# Audience: AI coding assistant / developer

---

## OVERVIEW & FILOSOFI DESAIN

Analytics di platform CS mengukur dua hal: seberapa cepat dan seberapa baik.
"Cepat" = SLA (first response time, resolution time).
"Baik" = CSAT, unresolved rate, bot containment rate.

### Keputusan arsitektur paling penting:

**JANGAN query MongoDB atau conversations table secara langsung untuk laporan.**

Percakapan aktif bisa jutaan baris. JOIN lintas database (SQL + MongoDB)
tidak mungkin. Query analitik yang berat akan lock tabel operasional.

**Solusi: Aggregated Metrics Table (Pre-computed)**

Gunakan scheduled job (nightly / hourly) yang mengagregasi data
dari tabel operasional ke tabel `analytics_*` yang dioptimalkan untuk baca.
Dashboard query tabel analytics, bukan tabel operasional.

---

## 1. DATA MODEL: ANALYTICS TABLES

Semua di SQL Server. Grain: satu row = satu conversation yang sudah resolved.

### `analytics_conversation_facts`

```sql
-- Fact table: satu row per conversation yang resolved/closed
-- Di-populate oleh background job setiap kali conversation di-resolve

CREATE TABLE analytics_conversation_facts (
    id                      BIGINT IDENTITY PRIMARY KEY,
    company_id              UNIQUEIDENTIFIER NOT NULL,
    conversation_id         UNIQUEIDENTIFIER NOT NULL,
    channel_id              UNIQUEIDENTIFIER NOT NULL,
    channel_type            NVARCHAR(30) NOT NULL,
    contact_id              UNIQUEIDENTIFIER NOT NULL,
    assigned_agent_id       UNIQUEIDENTIFIER NULL,

    -- Timing metrics (semua dalam detik)
    first_response_seconds  INT NULL,    -- waktu dari created_at ke first_response_at
    resolution_seconds      INT NULL,    -- waktu dari created_at ke resolved_at
    handle_seconds          INT NULL,    -- total waktu conversation aktif

    -- Volume metrics
    total_messages          INT NOT NULL DEFAULT 0,
    inbound_messages        INT NOT NULL DEFAULT 0,
    outbound_messages       INT NOT NULL DEFAULT 0,
    bot_messages            INT NOT NULL DEFAULT 0,

    -- Classification
    was_bot_handled         BIT DEFAULT 0,   -- conversation ditangani bot saja (tanpa handoff)
    had_bot_handoff         BIT DEFAULT 0,   -- ada transisi bot → human
    reassignment_count      INT DEFAULT 0,   -- berapa kali di-reassign

    -- CSAT
    csat_score              TINYINT NULL,    -- 1-5, null jika belum diisi
    csat_responded_at       DATETIME2 NULL,

    -- Dimensions untuk grouping
    resolved_date           DATE NOT NULL,   -- untuk partisi per hari
    resolved_hour           TINYINT NOT NULL,-- 0-23, untuk heatmap per jam
    resolved_week           INT NULL,        -- ISO week number
    resolved_month          NVARCHAR(7) NULL,-- format 'YYYY-MM'

    -- SLA flags
    met_first_response_sla  BIT NULL,        -- null jika SLA tidak dikonfigurasi
    met_resolution_sla      BIT NULL,

    created_at DATETIME2 DEFAULT GETUTCDATE()
);

-- Index untuk query paling umum
CREATE INDEX idx_facts_company_date
    ON analytics_conversation_facts (company_id, resolved_date DESC);

CREATE INDEX idx_facts_company_agent_date
    ON analytics_conversation_facts (company_id, assigned_agent_id, resolved_date DESC);

CREATE INDEX idx_facts_company_channel_date
    ON analytics_conversation_facts (company_id, channel_id, resolved_date DESC);

-- Pastikan tidak ada duplikat per conversation
CREATE UNIQUE INDEX idx_facts_conversation
    ON analytics_conversation_facts (company_id, conversation_id);
```

### `analytics_hourly_volume`

```sql
-- Pre-aggregated: volume pesan per jam per channel
-- Di-update setiap jam oleh scheduled job

CREATE TABLE analytics_hourly_volume (
    id              BIGINT IDENTITY PRIMARY KEY,
    company_id      UNIQUEIDENTIFIER NOT NULL,
    channel_id      UNIQUEIDENTIFIER NOT NULL,
    channel_type    NVARCHAR(30) NOT NULL,
    hour_bucket     DATETIME2 NOT NULL,       -- truncated ke jam: '2024-01-15 10:00:00'
    inbound_count   INT DEFAULT 0,
    outbound_count  INT DEFAULT 0,
    new_conv_count  INT DEFAULT 0,
    resolved_count  INT DEFAULT 0,

    CONSTRAINT uq_hourly_volume UNIQUE (company_id, channel_id, hour_bucket)
);

CREATE INDEX idx_hourly_company_date
    ON analytics_hourly_volume (company_id, hour_bucket DESC);
```

### `analytics_agent_daily`

```sql
-- Per-agent metrics per hari
-- Di-update pada akhir hari (midnight job)

CREATE TABLE analytics_agent_daily (
    id                          BIGINT IDENTITY PRIMARY KEY,
    company_id                  UNIQUEIDENTIFIER NOT NULL,
    agent_id                    UNIQUEIDENTIFIER NOT NULL,
    date_bucket                 DATE NOT NULL,

    conversations_handled       INT DEFAULT 0,
    conversations_resolved      INT DEFAULT 0,
    messages_sent               INT DEFAULT 0,
    avg_first_response_seconds  INT NULL,
    avg_resolution_seconds      INT NULL,
    avg_csat_score              DECIMAL(3,2) NULL,
    online_seconds              INT DEFAULT 0,    -- total waktu online

    CONSTRAINT uq_agent_daily UNIQUE (company_id, agent_id, date_bucket)
);

CREATE INDEX idx_agent_daily_company_date
    ON analytics_agent_daily (company_id, date_bucket DESC);
```

### `sla_configs`

```sql
-- Konfigurasi SLA per company (bisa per channel juga)

CREATE TABLE sla_configs (
    id                          UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    company_id                  UNIQUEIDENTIFIER NOT NULL,
    channel_id                  UNIQUEIDENTIFIER NULL,    -- NULL = berlaku untuk semua
    first_response_seconds      INT NOT NULL DEFAULT 300, -- 5 menit
    resolution_seconds          INT NOT NULL DEFAULT 86400,-- 24 jam
    business_hours_only         BIT DEFAULT 1,
    business_hours_config       NVARCHAR(MAX) NULL,       -- JSON: { mon: {start:'09:00', end:'18:00'}, ... }
    is_active                   BIT DEFAULT 1,
    created_at                  DATETIME2 DEFAULT GETUTCDATE(),

    CONSTRAINT fk_sla_company FOREIGN KEY (company_id) REFERENCES companies(id),
    CONSTRAINT uq_sla_company_channel UNIQUE (company_id, channel_id)
);
```

---

## 2. BACKGROUND JOBS (DATA PIPELINE)

### Job 1: `ConversationResolvedAnalyticsJob`

**Trigger:** Event-driven — dipanggil setiap kali conversation di-resolve.
Bukan batch, tapi per-event agar data analytics tidak terlalu delayed.

```
Input: conversation_id

1. Load conversation dari SQL (header)
2. Hitung metrics:

   first_response_seconds:
     Jika first_response_at IS NOT NULL:
       Hitung selisih created_at → first_response_at
       Jika sla_config.business_hours_only = true:
         Kurangi durasi di luar jam kerja dari selisih
     Else: NULL

   resolution_seconds:
     Selisih created_at → resolved_at (dengan business hours jika dikonfigurasi)

   total_messages, inbound_messages, outbound_messages, bot_messages:
     Query MongoDB: COUNT messages WHERE conversation_id = :id GROUP BY sender_type

   was_bot_handled:
     = 1 jika bot_messages > 0 AND had_bot_handoff = 0

   had_bot_handoff:
     = 1 jika ada record di conversation_assignments dengan reason = 'bot_handoff'

   reassignment_count:
     SELECT COUNT(*) FROM conversation_assignments
     WHERE conversation_id = :id AND reason IN ('manual', 'reassign')

3. Load sla_config untuk company + channel
4. Hitung met_first_response_sla, met_resolution_sla

5. UPSERT ke analytics_conversation_facts
   (unique key: company_id + conversation_id)

6. UPSERT ke analytics_hourly_volume untuk jam yang relevan
```

### Job 2: `HourlyVolumeAggregationJob`

**Trigger:** Scheduled, setiap jam (via Laravel Scheduler `->hourly()`).

```
1. Tentukan hour_bucket: 1 jam yang baru saja selesai
   misal: jika sekarang 11:05, hitung untuk bucket 10:00

2. Untuk setiap company yang aktif:
   Query conversations:
     SELECT
       channel_id,
       channel_type,
       COUNT(*) AS new_conv_count,
       COUNT(CASE WHEN resolved_at IS NOT NULL THEN 1 END) AS resolved_count
     FROM conversations
     WHERE company_id = :id
       AND created_at >= :hour_start
       AND created_at <  :hour_end

   Query MongoDB untuk message volume:
     db.messages.aggregate([
       { $match: { company_id, created_at: { $gte, $lt } } },
       { $group: { _id: { channel_id, direction }, count: { $sum: 1 } } }
     ])

3. UPSERT ke analytics_hourly_volume
```

### Job 3: `AgentDailyRollupJob`

**Trigger:** Scheduled, setiap tengah malam (`->dailyAt('00:05')`).
Proses data untuk hari kemarin.

```
1. date_bucket = yesterday

2. Untuk setiap agent yang aktif kemarin:
   Aggregate dari analytics_conversation_facts:
     WHERE assigned_agent_id = :id AND resolved_date = :date_bucket

   Hitung online_seconds:
     Ini tricky — perlu tracking kapan agent online/offline.
     Tambahkan tabel agent_presence_log:
       (company_id, agent_id, status, timestamp)
     Setiap kali agent connect/disconnect, insert ke tabel ini.
     Hitung total online_seconds = SUM(offline_time - online_time)

3. UPSERT ke analytics_agent_daily
```

### Tabel tambahan: `agent_presence_log`

```sql
CREATE TABLE agent_presence_log (
    id          BIGINT IDENTITY PRIMARY KEY,
    company_id  UNIQUEIDENTIFIER NOT NULL,
    agent_id    UNIQUEIDENTIFIER NOT NULL,
    event       NVARCHAR(10) NOT NULL,    -- 'online' | 'offline' | 'busy' | 'away'
    logged_at   DATETIME2 NOT NULL DEFAULT GETUTCDATE()
);

CREATE INDEX idx_presence_log_agent_date
    ON agent_presence_log (company_id, agent_id, logged_at DESC);

-- TTL: hapus log lebih dari 90 hari (cleanup job bulanan)
```

---

## 3. QUERY PATTERNS

AI implementor cukup membuat Service/Repository untuk masing-masing query ini.
Frontend memanggil via REST API endpoint.

### Query 1 — Overview dashboard (7 hari terakhir):

```sql
SELECT
    SUM(inbound_count)                              AS total_inbound,
    SUM(resolved_count)                             AS total_resolved,
    AVG(CAST(first_response_seconds AS FLOAT))      AS avg_first_response,
    AVG(CAST(resolution_seconds AS FLOAT))          AS avg_resolution,
    SUM(CASE WHEN met_first_response_sla = 1
             THEN 1 ELSE 0 END) * 100.0
    / NULLIF(COUNT(*), 0)                           AS sla_compliance_pct
FROM analytics_conversation_facts
WHERE company_id   = :company_id
  AND resolved_date >= DATEADD(DAY, -7, CAST(GETUTCDATE() AS DATE))
```

### Query 2 — Volume trend per hari (untuk line chart):

```sql
SELECT
    resolved_date,
    COUNT(*)                                 AS total_conversations,
    AVG(first_response_seconds)              AS avg_first_response,
    SUM(CASE WHEN met_first_response_sla = 1 THEN 1 ELSE 0 END) AS met_sla_count
FROM analytics_conversation_facts
WHERE company_id   = :company_id
  AND resolved_date BETWEEN :date_from AND :date_to
GROUP BY resolved_date
ORDER BY resolved_date ASC
```

### Query 3 — Agent performance leaderboard:

```sql
SELECT
    u.name,
    u.id,
    ad.conversations_handled,
    ad.avg_first_response_seconds,
    ad.avg_resolution_seconds,
    ad.avg_csat_score,
    ad.online_seconds
FROM analytics_agent_daily ad
JOIN users u ON u.id = ad.agent_id
WHERE ad.company_id  = :company_id
  AND ad.date_bucket = :date
ORDER BY ad.conversations_handled DESC
```

### Query 4 — Channel breakdown (untuk pie/bar chart):

```sql
SELECT
    channel_type,
    COUNT(*)                AS total,
    AVG(first_response_seconds) AS avg_first_response,
    SUM(CASE WHEN met_first_response_sla = 1 THEN 1 ELSE 0 END)
    * 100.0 / COUNT(*)     AS sla_pct
FROM analytics_conversation_facts
WHERE company_id   = :company_id
  AND resolved_date BETWEEN :date_from AND :date_to
GROUP BY channel_type
```

### Query 5 — Hourly heatmap (jam sibuk per hari):

```sql
SELECT
    DATEPART(dw, hour_bucket) - 1   AS day_of_week,  -- 0=Sun, 6=Sat
    DATEPART(HOUR, hour_bucket)     AS hour_of_day,
    SUM(inbound_count)              AS volume
FROM analytics_hourly_volume
WHERE company_id  = :company_id
  AND hour_bucket >= DATEADD(DAY, -28, GETUTCDATE())
GROUP BY
    DATEPART(dw,   hour_bucket),
    DATEPART(HOUR, hour_bucket)
ORDER BY day_of_week, hour_of_day
```

### Query 6 — SLA breach list (untuk alerting):

```sql
SELECT TOP 50
    c.id,
    c.last_message_preview,
    c.created_at,
    DATEDIFF(SECOND, c.created_at, GETUTCDATE()) AS age_seconds,
    c.assigned_agent_id,
    sc.first_response_seconds                    AS sla_threshold
FROM conversations c
JOIN sla_configs sc ON sc.company_id = c.company_id
    AND (sc.channel_id = c.channel_id OR sc.channel_id IS NULL)
WHERE c.company_id = :company_id
  AND c.status IN ('open', 'pending')
  AND c.first_response_at IS NULL
  AND DATEDIFF(SECOND, c.created_at, GETUTCDATE()) > sc.first_response_seconds
ORDER BY c.created_at ASC
```

---

## 4. BUSINESS HOURS CALCULATOR

SLA di banyak CS platform hanya menghitung waktu di jam kerja.
Misal: tiket masuk Jumat 17:00, first response Senin 09:30.
Dengan business hours, SLA-nya bukan 64.5 jam melainkan 0.5 jam.

### Service: `BusinessHoursCalculator`

```php
class BusinessHoursCalculator {
    /**
     * Hitung jumlah detik "business time" antara dua timestamp.
     * business_hours_config dari sla_configs.business_hours_config
     */
    public function calculateSeconds(
        Carbon $from,
        Carbon $to,
        array $businessHoursConfig
    ): int {
        // Struktur businessHoursConfig:
        // {
        //   "timezone": "Asia/Jakarta",
        //   "schedule": {
        //     "mon": { "start": "09:00", "end": "18:00" },
        //     "tue": { "start": "09:00", "end": "18:00" },
        //     ...
        //     "sat": null,  // null = libur
        //     "sun": null
        //   },
        //   "holidays": ["2024-12-25", "2024-01-01"]
        // }

        // Algoritma:
        // 1. Konversi from dan to ke timezone business
        // 2. Iterasi menit demi menit (atau detik) dari from ke to
        // 3. Untuk setiap interval: cek apakah masuk dalam jadwal kerja
        // 4. Jumlahkan hanya interval yang masuk jadwal kerja

        // Untuk performance: iterasi per hari, bukan per menit
        // Setiap hari hitung berapa detik overlap dengan jam kerja hari itu
    }
}
```

---

## 5. REST API ENDPOINTS (Laravel)

Semua di bawah `/api/analytics/` dengan middleware `auth` + company scoping.

```
GET /api/analytics/overview
    ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
    Response: { total_conversations, avg_first_response, avg_resolution,
                sla_compliance_pct, csat_avg, bot_containment_pct }

GET /api/analytics/volume-trend
    ?date_from=&date_to=&group_by=day|week|month
    Response: [{ date, total, avg_first_response, met_sla }]

GET /api/analytics/channel-breakdown
    ?date_from=&date_to=
    Response: [{ channel_type, total, avg_first_response, sla_pct }]

GET /api/analytics/agent-performance
    ?date=YYYY-MM-DD&sort_by=conversations|csat|response_time
    Response: [{ agent_id, name, conversations, avg_first_response, csat, online_seconds }]

GET /api/analytics/hourly-heatmap
    ?weeks=4
    Response: [[day, hour, volume], ...]  -- untuk render 7x24 grid

GET /api/analytics/sla-breaches
    Response: [{ conversation_id, age_seconds, threshold_seconds, agent_name }]

GET /api/analytics/export
    ?type=conversations|agents&date_from=&date_to=&format=csv
    Response: file download atau job ID jika async
```

### Report Export:

Untuk dataset kecil (<10.000 rows): generate synchronous, return file langsung.
Untuk dataset besar: dispatch `ExportReportJob`, return `{ job_id }`.
Frontend poll `GET /api/analytics/export/{job_id}/status` hingga selesai.

---

## 6. ANALYTICS DASHBOARD (Frontend)

### Halaman: `/analytics`

#### Layout tab:

```
[Overview] [Volume] [Agent Performance] [Channel] [SLA]
```

#### Tab Overview — KPI cards + sparklines:

```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ 1,234    │ │ 4m 32s   │ │ 94.2%    │ │ 4.6 / 5  │
│ Total    │ │ Avg First│ │ SLA      │ │ CSAT     │
│ Handled  │ │ Response │ │ Met      │ │ Score    │
└──────────┘ └──────────┘ └──────────┘ └──────────┘

[Line chart: volume 7 hari terakhir]

[Date range picker: Today | 7D | 30D | Custom]
```

#### Tab Agent Performance — tabel dengan sorting:

```
Agent    Handled  Avg Response  Avg Resolution  CSAT   Online
Budi S.  45       3m 12s        1h 24m          4.8    6h 32m
Ana R.   38       5m 44s        2h 10m          4.5    7h 01m
...

[Export CSV button]
```

#### Tab SLA — breach monitoring:

```
[Red alert card: X conversations currently breaching SLA]

Tabel breach aktif:
Contact | Channel | Waiting Since | SLA Threshold | Assignee | [Assign Now]
```

#### Charting library:

Gunakan **Recharts** (React) atau **Chart.js** (Vue/vanilla).
Jangan gunakan library yang memerlukan server-side rendering.

Chart types yang dibutuhkan:
```
Line chart    → volume trend
Bar chart     → per-channel breakdown
Heatmap       → hourly volume (7×24 grid, warna dari putih ke biru)
Gauge/donut   → SLA compliance percentage
```

#### Heatmap implementation:

Recharts tidak punya heatmap bawaan. Implementasi manual dengan SVG grid:
```
7 kolom (hari) × 24 baris (jam) = 168 sel
Warna per sel: interpolasi antara warna terang (volume 0) ke warna gelap (volume max)
Tooltip: "Senin 14:00 — 47 percakapan"
```

---

## 7. CSAT (Customer Satisfaction) COLLECTION

### Trigger pengiriman CSAT survey:

Saat conversation di-resolve, kirim pesan otomatis ke contact:
```
"Terima kasih telah menghubungi kami. Bagaimana pengalaman Anda hari ini?
Berikan nilai 1-5 (1=Sangat Buruk, 5=Sangat Baik)"
```

### Implementasi:

```
1. Saat ConversationResolvedEvent fired di Laravel:
   Jika company.settings.csat_enabled = true:
     Dispatch SendCsatSurveyJob dengan delay 5 menit
     (beri contact waktu sebelum survey muncul)

2. SendCsatSurveyJob:
   - Kirim pesan template CSAT via channel yang sama
   - WhatsApp: Quick Reply buttons (1, 2, 3, 4, 5)
   - Lainnya: teks biasa, minta reply angka
   - Simpan ke tabel csat_surveys:
     (conversation_id, contact_id, sent_at, response, responded_at)

3. Saat contact membalas angka 1-5:
   Bot Flow engine atau dedicated handler tangkap respons ini
   - Update csat_surveys.response, responded_at
   - Update analytics_conversation_facts.csat_score
   - Kirim pesan terima kasih
```

### Tabel `csat_surveys`:

```sql
CREATE TABLE csat_surveys (
    id              BIGINT IDENTITY PRIMARY KEY,
    company_id      UNIQUEIDENTIFIER NOT NULL,
    conversation_id UNIQUEIDENTIFIER NOT NULL,
    contact_id      UNIQUEIDENTIFIER NOT NULL,
    sent_at         DATETIME2 NOT NULL,
    score           TINYINT NULL,         -- 1-5
    responded_at    DATETIME2 NULL,
    raw_response    NVARCHAR(50) NULL,

    CONSTRAINT uq_csat_conversation UNIQUE (conversation_id)
);
```

---

## 8. TESTING CHECKLIST

- [ ] `ConversationResolvedAnalyticsJob` membuat fact record dengan metrics yang benar
- [ ] Business hours calculator: 17:00 Jumat → 09:00 Senin = 0 detik (bukan 64 jam)
- [ ] SLA breach query mengembalikan conversation yang benar
- [ ] Hourly aggregation tidak double-count jika di-run ulang (upsert)
- [ ] Agent daily rollup: online_seconds terhitung dari presence_log
- [ ] CSAT survey tidak dikirim ulang jika conversation di-resolve berkali-kali
- [ ] Export CSV besar (>10k rows) berjalan async, tidak timeout
- [ ] Bot containment rate: conversations yang diselesaikan bot tanpa handoff
- [ ] Analytics query selalu include company_id filter (tenant isolation)
