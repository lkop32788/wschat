'use strict';

/**
 * WhatsApp Cloud API Adapter
 *
 * Mengubah payload raw WhatsApp → canonical schema.
 *
 * TANTANGAN WHATSAPP:
 * 1. Satu webhook POST bisa berisi MULTIPLE events (entries & changes array)
 *    → Kita harus unpack dan hasilkan multiple canonical messages
 *
 * 2. WhatsApp mengirim status update (delivered, read) dalam payload yang sama
 *    dengan pesan masuk → harus dipisahkan
 *
 * 3. Nomor pengirim format internasional tanpa '+': "6281234567890"
 *    → Normalize ke E.164: "+6281234567890"
 *
 * 4. Timestamp WhatsApp dalam Unix epoch string: "1700000000"
 *    → Convert ke ISO 8601
 *
 * Referensi: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */

const { v4: uuidv4 } = require('uuid');
const { ContentType } = require('./canonicalSchema');

/**
 * Parse satu webhook POST WhatsApp → array canonical messages
 *
 * @param {Object} rawPayload   - req.body dari WhatsApp
 * @param {string} companyId    - dari URL param atau channel lookup
 * @param {string} channelId    - dari URL param
 * @returns {Array<CanonicalMessage>}
 */
function normalizeWhatsApp(rawPayload, companyId, channelId) {
    const messages = [];
    const statusUpdates = [];

    // WhatsApp payload structure:
    // { object: "whatsapp_business_account", entry: [{ changes: [{ value: {...} }] }] }
    for (const entry of rawPayload.entry || []) {
        for (const change of entry.changes || []) {
            if (change.field !== 'messages') continue;

            const value = change.value;

            // Proses inbound messages
            for (const msg of value.messages || []) {
                const contact = (value.contacts || []).find(
                    c => c.wa_id === msg.from
                );

                const canonical = buildCanonicalFromWaMessage(
                    msg, contact, value, companyId, channelId
                );

                if (canonical) messages.push(canonical);
            }

            // Proses status updates (delivered, read, failed)
            // Ini perlu di-route ke queue berbeda untuk update status di MongoDB
            for (const status of value.statuses || []) {
                statusUpdates.push({
                    event_type: 'STATUS_UPDATE',
                    channel_type: 'whatsapp',
                    company_id: companyId,
                    channel_id: channelId,
                    provider_message_id: status.id,
                    status: status.status,           // "delivered" | "read" | "failed"
                    recipient_id: status.recipient_id,
                    timestamp: new Date(parseInt(status.timestamp) * 1000).toISOString(),
                    error: status.errors?.[0] || null,
                });
            }
        }
    }

    return { messages, statusUpdates };
}

function buildCanonicalFromWaMessage(msg, contact, value, companyId, channelId) {
    const senderPhone = normalizePhone(msg.from);
    const receivedAt = new Date().toISOString();
    const providerTimestamp = new Date(parseInt(msg.timestamp) * 1000).toISOString();

    const base = {
        event_id: uuidv4(),
        company_id: companyId,
        channel_id: channelId,
        channel_type: 'whatsapp',
        direction: 'inbound',
        idempotency_key: msg.id,                    // wamid — unik per pesan
        sender_external_id: senderPhone,
        sender_name: contact?.profile?.name || null,
        sender_avatar: null,                         // WA tidak expose avatar di webhook
        quoted_message_id: msg.context?.id || null,
        conversation_ref_id: null,
        provider_timestamp: providerTimestamp,
        received_at: receivedAt,
        raw_payload: msg,
    };

    // Mapping content berdasarkan type
    switch (msg.type) {
        case 'text':
            return {
                ...base,
                content_type: ContentType.TEXT,
                content: { body: msg.text.body },
            };

        case 'image':
            return {
                ...base,
                content_type: ContentType.IMAGE,
                content: {
                    provider_media_id: msg.image.id,    // perlu di-download via API
                    mime_type: msg.image.mime_type,
                    sha256: msg.image.sha256,
                    caption: msg.image.caption || null,
                },
            };

        case 'audio':
            return {
                ...base,
                content_type: ContentType.AUDIO,
                content: {
                    provider_media_id: msg.audio.id,
                    mime_type: msg.audio.mime_type,
                    voice: msg.audio.voice || false,    // true jika voice note
                },
            };

        case 'video':
            return {
                ...base,
                content_type: ContentType.VIDEO,
                content: {
                    provider_media_id: msg.video.id,
                    mime_type: msg.video.mime_type,
                    caption: msg.video.caption || null,
                },
            };

        case 'document':
            return {
                ...base,
                content_type: ContentType.FILE,
                content: {
                    provider_media_id: msg.document.id,
                    mime_type: msg.document.mime_type,
                    filename: msg.document.filename || null,
                    caption: msg.document.caption || null,
                },
            };

        case 'location':
            return {
                ...base,
                content_type: ContentType.LOCATION,
                content: {
                    latitude: msg.location.latitude,
                    longitude: msg.location.longitude,
                    name: msg.location.name || null,
                    address: msg.location.address || null,
                },
            };

        case 'sticker':
            return {
                ...base,
                content_type: ContentType.STICKER,
                content: {
                    provider_media_id: msg.sticker.id,
                    mime_type: msg.sticker.mime_type,
                    animated: msg.sticker.animated || false,
                },
            };

        case 'interactive':
            return normalizeWaInteractive(base, msg.interactive);

        case 'button':
            // Quick reply button response
            return {
                ...base,
                content_type: ContentType.BUTTON_REPLY,
                content: {
                    button_text: msg.button.text,
                    button_payload: msg.button.payload,
                },
            };

        case 'reaction':
            return {
                ...base,
                content_type: ContentType.REACTION,
                content: {
                    emoji: msg.reaction.emoji,
                    reacted_to_message_id: msg.reaction.message_id,
                },
            };

        default:
            // Tipe tidak dikenal — tetap simpan dengan raw payload
            return {
                ...base,
                content_type: ContentType.UNSUPPORTED,
                content: { original_type: msg.type },
            };
    }
}

function normalizeWaInteractive(base, interactive) {
    if (interactive.type === 'button_reply') {
        return {
            ...base,
            content_type: ContentType.BUTTON_REPLY,
            content: {
                button_id: interactive.button_reply.id,
                button_text: interactive.button_reply.title,
            },
        };
    }
    if (interactive.type === 'list_reply') {
        return {
            ...base,
            content_type: ContentType.LIST_REPLY,
            content: {
                list_item_id: interactive.list_reply.id,
                list_item_title: interactive.list_reply.title,
                list_item_description: interactive.list_reply.description || null,
            },
        };
    }
    return {
        ...base,
        content_type: ContentType.UNSUPPORTED,
        content: { original_type: `interactive.${interactive.type}` },
    };
}

/**
 * Normalize nomor telepon ke E.164 format.
 * WA mengirim tanpa '+': "6281234567890" → "+6281234567890"
 */
function normalizePhone(phone) {
    if (!phone) return phone;
    const digits = phone.replace(/\D/g, '');
    return '+' + digits;
}

module.exports = { normalizeWhatsApp };
