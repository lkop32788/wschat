/**
 * MongoDB Schema: messages collection
 *
 * KEPUTUSAN ARSITEKTUR: kenapa MongoDB untuk messages?
 *
 * 1. Struktur pesan BERBEDA per channel:
 *    - WhatsApp: bisa kirim button, list, location, sticker, reaction
 *    - LINE: flex message, carousel, imagemap
 *    - Email: HTML body, attachments, thread-id, headers
 *    - Semua ini TIDAK fit di satu tabel relational tanpa puluhan kolom nullable.
 *
 * 2. Insert throughput: SQL Server row-locking overhead tidak ideal untuk
 *    flood scenario (ribuan pesan/menit saat broadcast reply).
 *
 * 3. Immutability: pesan chat tidak pernah di-UPDATE (hanya soft-delete/edit metadata),
 *    sehingga MongoDB append-only pattern sangat natural.
 *
 * RELASI ke SQL:
 * - company_id, conversation_id, sender_id = UUID yang sama dengan SQL Server
 * - Tidak ada FK enforcement, tapi field ini wajib ada dan diindex
 */

// ── COLLECTION: messages ────────────────────────────────────────────────────

/**
 * Document structure untuk satu pesan
 */
const MessageSchema = {
    // Identitas & routing
    _id: ObjectId,                          // MongoDB auto-generated
    company_id: UUID,                       // tenant partition key — WAJIB ada
    conversation_id: UUID,                  // ref ke SQL conversations.id
    channel_id: UUID,                       // ref ke SQL channels.id
    channel_type: String,                   // "whatsapp" | "line" | "email" | "telegram"

    // Pengirim
    direction: String,                      // "inbound" | "outbound"
    sender_type: String,                    // "contact" | "agent" | "bot" | "system"
    sender_id: UUID,                        // contact_id atau user_id dari SQL

    // Konten — polymorphic, tergantung content_type
    content_type: String,                   // "text" | "image" | "audio" | "video" | "file" |
                                            // "location" | "contact_card" | "button_reply" |
                                            // "list_reply" | "sticker" | "email_html" | "system_event"
    content: {
        // text
        body: String,

        // media (image/audio/video/file)
        url: String,
        mime_type: String,
        file_size: Number,
        filename: String,
        duration_seconds: Number,           // audio/video
        thumbnail_url: String,
        caption: String,

        // location
        latitude: Number,
        longitude: Number,
        address: String,

        // email
        subject: String,
        html_body: String,
        text_body: String,
        thread_id: String,
        attachments: [{ filename: String, url: String, size: Number }],

        // interactive (button reply, list reply)
        button_id: String,
        button_text: String,
        list_section_title: String,

        // system event (untuk audit trail di inbox)
        event_type: String,                 // "assigned" | "resolved" | "note_added" | "snoozed"
        event_payload: Object,
    },

    // Quoted/replied message (WhatsApp quote, LINE reply)
    quoted_message_id: ObjectId,            // ref ke _id dalam collection yang sama
    quoted_preview: String,                 // text preview untuk display, max 100 chars

    // Status delivery
    status: String,                         // "pending" | "sent" | "delivered" | "read" | "failed"
    status_history: [{
        status: String,
        timestamp: Date,
        provider_event: String,             // raw event name dari provider
    }],
    error_code: String,
    error_message: String,

    // Metadata provider
    provider_message_id: String,            // ID dari WhatsApp/LINE/dll untuk tracking
    provider_timestamp: Date,               // timestamp dari provider (bisa berbeda dengan created_at)

    // Internal metadata
    is_deleted: Boolean,                    // soft delete
    deleted_at: Date,
    edited_at: Date,
    edit_history: [{ body: String, edited_at: Date }],

    // Bot & automation
    is_automated: Boolean,                  // true jika dikirim oleh bot
    bot_intent: String,                     // intent yang trigger pesan ini
    flow_id: String,                        // ref ke bot flow

    created_at: Date,
    updated_at: Date,
};

/**
 * INDEX STRATEGY untuk messages collection
 *
 * CRITICAL: Semua query HARUS prefix dengan company_id untuk isolasi tenant.
 * MongoDB tidak punya row-level security built-in — aplikasi yang enforce ini.
 */

// Compound index utama: load conversation history
db.messages.createIndex(
    { company_id: 1, conversation_id: 1, created_at: -1 },
    {
        name: "idx_conversation_timeline",
        background: true
    }
);

// Index untuk lookup by provider message ID (handle duplicate webhook)
db.messages.createIndex(
    { company_id: 1, channel_type: 1, provider_message_id: 1 },
    {
        name: "idx_provider_dedup",
        unique: true,
        partialFilterExpression: { provider_message_id: { $exists: true, $ne: null } }
    }
);

// Index untuk monitoring delivery status (outbound messages yang masih pending)
db.messages.createIndex(
    { company_id: 1, direction: 1, status: 1, created_at: -1 },
    {
        name: "idx_delivery_monitoring",
        partialFilterExpression: { direction: "outbound" }
    }
);

// TTL index untuk auto-purge pesan lama (opsional, tergantung retention policy)
// Uncomment jika plan membutuhkan GDPR-compliant data retention
// db.messages.createIndex(
//     { created_at: 1 },
//     { expireAfterSeconds: 63072000 } // 2 tahun
// );


// ── COLLECTION: bot_sessions ─────────────────────────────────────────────────

/**
 * Menyimpan state percakapan bot yang sedang aktif.
 * Sengaja di MongoDB (bukan Redis) karena:
 * - State bisa kompleks (nested flow state, collected variables)
 * - Perlu persistence kalau Redis restart
 * - Redis tetap menyimpan "apakah conversation ini bot-mode?" sebagai boolean flag
 *   untuk query cepat, tapi detail state ada di sini
 */
const BotSessionSchema = {
    _id: ObjectId,
    company_id: UUID,
    conversation_id: UUID,
    flow_id: String,                        // bot flow yang sedang berjalan
    current_node_id: String,               // posisi dalam flow graph
    variables: Object,                      // collected data: nama, nomor order, dll
    intent_stack: [String],                // history intent untuk context
    is_active: Boolean,
    started_at: Date,
    last_interaction_at: Date,
    handoff_at: Date,                      // kapan di-handoff ke agent
    handoff_reason: String,
};

db.bot_sessions.createIndex(
    { company_id: 1, conversation_id: 1 },
    { name: "idx_bot_active_session", unique: true }
);

db.bot_sessions.createIndex(
    { last_interaction_at: 1 },
    { expireAfterSeconds: 86400 }           // TTL: session mati setelah 24 jam idle
);
