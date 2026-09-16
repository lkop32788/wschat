'use strict';

/**
 * Telegram Bot API Adapter
 *
 * TANTANGAN:
 * 1. Update object bisa berisi berbagai field: message, edited_message, callback_query, dll
 *    → Kita hanya handle `message` untuk inbound CS inbox
 * 2. Telegram user ID adalah integer (bukan string seperti LINE)
 * 3. Timestamp Unix epoch (seconds) — sama dengan WhatsApp
 * 4. File/media diakses via getFile API, bukan langsung dari webhook
 */

const { v4: uuidv4 } = require('uuid');
const { ContentType } = require('../lib/canonicalSchema');

/**
 * @param {Object} rawPayload  - req.body dari Telegram (satu Update object)
 * @param {string} companyId
 * @param {string} channelId
 * @returns {{ messages: CanonicalMessage[], statusUpdates: [] }}
 */
function normalizeTelegram(rawPayload, companyId, channelId) {
    const messages   = [];
    const receivedAt = new Date().toISOString();

    const msg = rawPayload.message || rawPayload.edited_message;
    const callbackQuery = rawPayload.callback_query;

    if (msg && msg.chat?.type === 'private') {
        const canonical = buildCanonical(msg, companyId, channelId, receivedAt, false);
        if (canonical) messages.push(canonical);
    } else if (callbackQuery) {
        const inlineMsg = buildCallbackQueryCanonical(callbackQuery, companyId, channelId, receivedAt);
        if (inlineMsg) messages.push(inlineMsg);
    }

    return { messages, statusUpdates: [] };
}

function buildCanonical(msg, companyId, channelId, receivedAt, isEdited) {
    const senderId = String(msg.from.id);

    const base = {
        event_id:            uuidv4(),
        company_id:          companyId,
        channel_id:          channelId,
        channel_type:        'telegram',
        direction:           'inbound',
        idempotency_key:     `tg_${msg.message_id}_${senderId}`,
        sender_external_id:  senderId,
        sender_name:         [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || null,
        sender_avatar:       null,
        quoted_message_id:   msg.reply_to_message ? `tg_${msg.reply_to_message.message_id}_${senderId}` : null,
        conversation_ref_id: null,
        provider_timestamp:  new Date(msg.date * 1000).toISOString(),
        received_at:         receivedAt,
        raw_payload:         { message_id: msg.message_id, from_id: msg.from.id, is_edited: isEdited },
    };

    if (msg.text) {
        return { ...base, content_type: ContentType.TEXT, content: { body: msg.text } };
    }

    if (msg.photo) {
        const largest = msg.photo[msg.photo.length - 1];
        return {
            ...base,
            content_type: ContentType.IMAGE,
            content: { provider_media_id: largest.file_id, caption: msg.caption || null },
        };
    }

    if (msg.audio) {
        return {
            ...base,
            content_type: ContentType.AUDIO,
            content: {
                provider_media_id: msg.audio.file_id,
                duration_s:        msg.audio.duration,
                mime_type:         msg.audio.mime_type || null,
                filename:          msg.audio.file_name || null,
            },
        };
    }

    if (msg.voice) {
        return {
            ...base,
            content_type: ContentType.AUDIO,
            content: {
                provider_media_id: msg.voice.file_id,
                duration_s:        msg.voice.duration,
                mime_type:         msg.voice.mime_type || 'audio/ogg',
                voice:             true,
            },
        };
    }

    if (msg.video) {
        return {
            ...base,
            content_type: ContentType.VIDEO,
            content: {
                provider_media_id: msg.video.file_id,
                duration_s:        msg.video.duration,
                caption:           msg.caption || null,
            },
        };
    }

    if (msg.document) {
        return {
            ...base,
            content_type: ContentType.FILE,
            content: {
                provider_media_id: msg.document.file_id,
                mime_type:         msg.document.mime_type || null,
                filename:          msg.document.file_name || null,
            },
        };
    }

    if (msg.location) {
        return {
            ...base,
            content_type: ContentType.LOCATION,
            content: { latitude: msg.location.latitude, longitude: msg.location.longitude },
        };
    }

    if (msg.sticker) {
        return {
            ...base,
            content_type: ContentType.STICKER,
            content: {
                provider_media_id: msg.sticker.file_id,
                emoji:             msg.sticker.emoji || null,
                animated:          msg.sticker.is_animated || false,
            },
        };
    }

    return { ...base, content_type: ContentType.UNSUPPORTED, content: { original_type: 'unknown' } };
}

function buildCallbackQueryCanonical(query, companyId, channelId, receivedAt) {
    const senderId = String(query.from.id);
    return {
        event_id:            uuidv4(),
        company_id:          companyId,
        channel_id:          channelId,
        channel_type:        'telegram',
        direction:           'inbound',
        idempotency_key:     `tg_cb_${query.id}`,
        sender_external_id:  senderId,
        sender_name:         [query.from.first_name, query.from.last_name].filter(Boolean).join(' ') || null,
        sender_avatar:       null,
        quoted_message_id:   null,
        conversation_ref_id: null,
        provider_timestamp:  new Date().toISOString(),
        received_at:         receivedAt,
        content_type:        ContentType.BUTTON_REPLY,
        content: { button_payload: query.data, button_text: null },
        raw_payload:         { callback_query_id: query.id, from_id: query.from.id },
    };
}

module.exports = { normalizeTelegram };
