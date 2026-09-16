'use strict';

/**
 * Canonical Message Schema
 *
 * "Bahasa bersama" seluruh sistem. Semua pesan dari provider manapun
 * dinormalisasi ke format ini sebelum masuk ke broker.
 * Consumer (Laravel) hanya perlu memahami satu schema ini.
 *
 * @typedef {Object} CanonicalMessage
 * @property {string}      event_id           - UUID v4, dibuat gateway
 * @property {string}      company_id         - UUID dari SQL companies.id
 * @property {string}      channel_id         - UUID dari SQL channels.id
 * @property {string}      channel_type       - 'whatsapp'|'line'|'email'|'telegram'|'sms'
 * @property {string}      direction          - selalu 'inbound' di gateway
 * @property {string}      idempotency_key    - provider_message_id untuk dedup
 * @property {string}      sender_external_id - identifier pengirim di provider
 * @property {string|null} sender_name
 * @property {string|null} sender_avatar
 * @property {string}      content_type       - lihat ContentType enum
 * @property {Object}      content
 * @property {string|null} quoted_message_id
 * @property {string|null} conversation_ref_id - thread ID untuk email (In-Reply-To)
 * @property {string}      provider_timestamp  - ISO 8601
 * @property {string}      received_at         - ISO 8601
 * @property {Object}      raw_payload         - payload asli (jangan log ke stdout)
 */

const ContentType = Object.freeze({
    TEXT:         'text',
    IMAGE:        'image',
    AUDIO:        'audio',
    VIDEO:        'video',
    FILE:         'file',
    LOCATION:     'location',
    CONTACT_CARD: 'contact_card',
    STICKER:      'sticker',
    BUTTON_REPLY: 'button_reply',
    LIST_REPLY:   'list_reply',
    EMAIL_HTML:   'email_html',
    REACTION:     'reaction',
    UNSUPPORTED:  'unsupported',
});

const ChannelType = Object.freeze({
    WHATSAPP: 'whatsapp',
    LINE:     'line',
    EMAIL:    'email',
    TELEGRAM: 'telegram',
    SMS:      'sms',
    WEBCHAT:  'webchat',
});

module.exports = { ContentType, ChannelType };
