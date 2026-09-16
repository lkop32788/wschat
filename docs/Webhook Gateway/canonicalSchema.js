'use strict';

/**
 * Canonical Message Schema
 *
 * Ini adalah "bahasa bersama" seluruh sistem.
 * Setelah melewati adapter, SEMUA pesan dari provider manapun
 * menjadi format ini sebelum masuk ke broker.
 *
 * Consumer (Laravel, Dispatcher) hanya perlu mengerti satu schema ini —
 * bukan 6 format berbeda dari 6 provider.
 *
 * KEPUTUSAN DESAIN:
 * - Semua field opsional kecuali yang ditandai REQUIRED
 * - `raw_payload` selalu disimpan untuk debugging & audit
 * - `idempotency_key` = provider_message_id — consumer pakai ini untuk dedup di DB
 */

/**
 * @typedef {Object} CanonicalMessage
 *
 * // ── Routing (REQUIRED) ────────────────────────────────────────
 * @property {string} event_id           - UUID v4, dibuat gateway (bukan provider)
 * @property {string} company_id         - UUID dari SQL companies.id
 * @property {string} channel_id         - UUID dari SQL channels.id
 * @property {string} channel_type       - "whatsapp"|"line"|"email"|"telegram"|"sms"
 * @property {string} direction          - "inbound" (selalu di gateway, outbound dari API)
 * @property {string} idempotency_key    - provider_message_id untuk dedup
 *
 * // ── Sender (REQUIRED) ─────────────────────────────────────────
 * @property {string} sender_external_id - identifier pengirim di sisi provider
 *                                         (nomor WA, LINE UID, email address)
 * @property {string|null} sender_name   - display name dari provider profile
 * @property {string|null} sender_avatar - URL foto profil dari provider
 *
 * // ── Content (REQUIRED: content_type + salah satu field content) ──
 * @property {string} content_type       - lihat ContentType enum di bawah
 * @property {Object} content            - struktur bervariasi per content_type
 *
 * // ── Threading ─────────────────────────────────────────────────
 * @property {string|null} quoted_message_id    - provider ID pesan yang di-quote/reply
 * @property {string|null} conversation_ref_id  - thread ID untuk email
 *
 * // ── Timestamps ────────────────────────────────────────────────
 * @property {string} provider_timestamp - ISO 8601 dari provider
 * @property {string} received_at        - ISO 8601, saat gateway terima
 *
 * // ── Debug ─────────────────────────────────────────────────────
 * @property {Object} raw_payload        - payload asli dari provider, tidak dimodifikasi
 */

const ContentType = Object.freeze({
    TEXT: 'text',
    IMAGE: 'image',
    AUDIO: 'audio',
    VIDEO: 'video',
    FILE: 'file',
    LOCATION: 'location',
    CONTACT_CARD: 'contact_card',
    STICKER: 'sticker',
    BUTTON_REPLY: 'button_reply',   // WhatsApp interactive
    LIST_REPLY: 'list_reply',       // WhatsApp interactive
    EMAIL_HTML: 'email_html',
    REACTION: 'reaction',           // WhatsApp reaction (emoji di pesan lain)
    UNSUPPORTED: 'unsupported',     // content type yang belum di-handle
});

module.exports = { ContentType };
