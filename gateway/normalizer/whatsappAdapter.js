'use strict';

/**
 * WhatsApp Cloud API Adapter
 *
 * TANTANGAN:
 * 1. Satu POST bisa berisi MULTIPLE events (entry[] + changes[])
 * 2. Status updates (delivered, read) ada dalam payload yang sama dengan pesan
 * 3. Nomor pengirim tanpa '+': "6281234567890" → normalize ke "+6281234567890"
 * 4. Timestamp Unix epoch string → ISO 8601
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */

const { v4: uuidv4 } = require('uuid');
const { ContentType } = require('../lib/canonicalSchema');

/**
 * @param {Object} rawPayload  - req.body dari WhatsApp
 * @param {string} companyId
 * @param {string} channelId
 * @returns {{ messages: CanonicalMessage[], statusUpdates: Object[] }}
 */
function normalizeWhatsApp(rawPayload, companyId, channelId) {
    const messages       = [];
    const statusUpdates  = [];
    const receivedAt     = new Date().toISOString();

    for (const entry of rawPayload.entry || []) {
        for (const change of entry.changes || []) {
            if (change.field !== 'messages') continue;
            const value = change.value;

            for (const msg of value.messages || []) {
                const contact  = (value.contacts || []).find(c => c.wa_id === msg.from);
                const canonical = buildCanonical(msg, contact, companyId, channelId, receivedAt);
                if (canonical) messages.push(canonical);
            }

            for (const status of value.statuses || []) {
                statusUpdates.push({
                    event_type:         'STATUS_UPDATE',
                    channel_type:       'whatsapp',
                    company_id:         companyId,
                    channel_id:         channelId,
                    provider_message_id: status.id,
                    status:              status.status,      // delivered | read | failed
                    recipient_id:        status.recipient_id,
                    timestamp:           new Date(parseInt(status.timestamp, 10) * 1000).toISOString(),
                    error:               status.errors?.[0] || null,
                });
            }
        }
    }

    return { messages, statusUpdates };
}

function buildCanonical(msg, contact, companyId, channelId, receivedAt) {
    const base = {
        event_id:            uuidv4(),
        company_id:          companyId,
        channel_id:          channelId,
        channel_type:        'whatsapp',
        direction:           'inbound',
        idempotency_key:     msg.id,
        sender_external_id:  normalizePhone(msg.from),
        sender_name:         contact?.profile?.name || null,
        sender_avatar:       null,
        quoted_message_id:   msg.context?.id || null,
        conversation_ref_id: null,
        provider_timestamp:  new Date(parseInt(msg.timestamp, 10) * 1000).toISOString(),
        received_at:         receivedAt,
        raw_payload:         msg,
    };

    switch (msg.type) {
        case 'text':
            return { ...base, content_type: ContentType.TEXT, content: { body: msg.text.body } };

        case 'image':
            return {
                ...base,
                content_type: ContentType.IMAGE,
                content: {
                    provider_media_id: msg.image.id,
                    mime_type:         msg.image.mime_type,
                    sha256:            msg.image.sha256,
                    caption:           msg.image.caption || null,
                },
            };

        case 'audio':
            return {
                ...base,
                content_type: ContentType.AUDIO,
                content: {
                    provider_media_id: msg.audio.id,
                    mime_type:         msg.audio.mime_type,
                    voice:             msg.audio.voice || false,
                },
            };

        case 'video':
            return {
                ...base,
                content_type: ContentType.VIDEO,
                content: {
                    provider_media_id: msg.video.id,
                    mime_type:         msg.video.mime_type,
                    caption:           msg.video.caption || null,
                },
            };

        case 'document':
            return {
                ...base,
                content_type: ContentType.FILE,
                content: {
                    provider_media_id: msg.document.id,
                    mime_type:         msg.document.mime_type,
                    filename:          msg.document.filename || null,
                    caption:           msg.document.caption || null,
                },
            };

        case 'location':
            return {
                ...base,
                content_type: ContentType.LOCATION,
                content: {
                    latitude:  msg.location.latitude,
                    longitude: msg.location.longitude,
                    name:      msg.location.name    || null,
                    address:   msg.location.address || null,
                },
            };

        case 'sticker':
            return {
                ...base,
                content_type: ContentType.STICKER,
                content: {
                    provider_media_id: msg.sticker.id,
                    mime_type:         msg.sticker.mime_type,
                    animated:          msg.sticker.animated || false,
                },
            };

        case 'interactive':
            return normalizeInteractive(base, msg.interactive);

        case 'button':
            return {
                ...base,
                content_type: ContentType.BUTTON_REPLY,
                content: { button_text: msg.button.text, button_payload: msg.button.payload },
            };

        case 'reaction':
            return {
                ...base,
                content_type: ContentType.REACTION,
                content: { emoji: msg.reaction.emoji, reacted_to_message_id: msg.reaction.message_id },
            };

        default:
            return { ...base, content_type: ContentType.UNSUPPORTED, content: { original_type: msg.type } };
    }
}

function normalizeInteractive(base, interactive) {
    if (interactive.type === 'button_reply') {
        return {
            ...base,
            content_type: ContentType.BUTTON_REPLY,
            content: { button_id: interactive.button_reply.id, button_text: interactive.button_reply.title },
        };
    }
    if (interactive.type === 'list_reply') {
        return {
            ...base,
            content_type: ContentType.LIST_REPLY,
            content: {
                list_item_id:          interactive.list_reply.id,
                list_item_title:       interactive.list_reply.title,
                list_item_description: interactive.list_reply.description || null,
            },
        };
    }
    return { ...base, content_type: ContentType.UNSUPPORTED, content: { original_type: `interactive.${interactive.type}` } };
}

function normalizePhone(phone) {
    if (!phone) return phone;
    const digits = phone.replace(/\D/g, '');
    return '+' + digits;
}

module.exports = { normalizeWhatsApp };
