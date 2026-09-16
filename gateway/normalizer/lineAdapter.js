'use strict';

/**
 * LINE Messaging API Adapter
 *
 * TANTANGAN:
 * 1. Satu webhook bisa berisi array events dari berbagai type
 * 2. LINE event types: message, postback, follow, unfollow, join, leave, dll
 *    → Kita hanya handle `message` + `postback` untuk CS inbox
 * 3. LINE user ID format: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
 * 4. Source bisa: user (1-on-1), group, room → hanya handle user untuk inbox
 * 5. Timestamp dalam milliseconds (bukan seconds seperti WA)
 */

const { v4: uuidv4 } = require('uuid');
const { ContentType } = require('../lib/canonicalSchema');

/**
 * @param {Object} rawPayload
 * @param {string} companyId
 * @param {string} channelId
 * @returns {{ messages: CanonicalMessage[], statusUpdates: [] }}
 */
function normalizeLine(rawPayload, companyId, channelId) {
    const messages   = [];
    const receivedAt = new Date().toISOString();

    for (const event of rawPayload.events || []) {
        // Hanya proses pesan 1-on-1
        if (event.source?.type !== 'user') continue;
        if (event.type !== 'message' && event.type !== 'postback') continue;

        const canonical = buildCanonical(event, companyId, channelId, receivedAt);
        if (canonical) messages.push(canonical);
    }

    return { messages, statusUpdates: [] }; // LINE tidak kirim delivery status via webhook
}

function buildCanonical(event, companyId, channelId, receivedAt) {
    const base = {
        event_id:            uuidv4(),
        company_id:          companyId,
        channel_id:          channelId,
        channel_type:        'line',
        direction:           'inbound',
        idempotency_key:     event.webhookEventId || event.message?.id,
        sender_external_id:  event.source.userId,
        sender_name:         null,  // LINE tidak expose nama di webhook — perlu API call
        sender_avatar:       null,
        quoted_message_id:   null,
        conversation_ref_id: null,
        provider_timestamp:  new Date(event.timestamp).toISOString(),
        received_at:         receivedAt,
        raw_payload:         event,
    };

    if (event.type === 'postback') {
        return {
            ...base,
            idempotency_key: `postback_${event.source.userId}_${event.timestamp}`,
            content_type:    ContentType.BUTTON_REPLY,
            content: {
                button_payload: event.postback.data,
                button_text:    event.postback.displayText || null,
            },
        };
    }

    const msg = event.message;
    switch (msg.type) {
        case 'text':
            return { ...base, content_type: ContentType.TEXT, content: { body: msg.text } };

        case 'image':
            return {
                ...base,
                content_type: ContentType.IMAGE,
                content: {
                    provider_media_id: msg.id,
                    external_url: msg.contentProvider?.type === 'external'
                        ? msg.contentProvider.originalContentUrl
                        : null,
                },
            };

        case 'audio':
            return {
                ...base,
                content_type: ContentType.AUDIO,
                content: { provider_media_id: msg.id, duration_ms: msg.duration || null },
            };

        case 'video':
            return {
                ...base,
                content_type: ContentType.VIDEO,
                content: {
                    provider_media_id: msg.id,
                    duration_ms:       msg.duration || null,
                    preview_url:       msg.contentProvider?.previewImageUrl || null,
                },
            };

        case 'file':
            return {
                ...base,
                content_type: ContentType.FILE,
                content: { provider_media_id: msg.id, filename: msg.fileName, file_size: msg.fileSize },
            };

        case 'location':
            return {
                ...base,
                content_type: ContentType.LOCATION,
                content: {
                    latitude:  msg.latitude,
                    longitude: msg.longitude,
                    title:     msg.title   || null,
                    address:   msg.address || null,
                },
            };

        case 'sticker':
            return {
                ...base,
                content_type: ContentType.STICKER,
                content: { package_id: msg.packageId, sticker_id: msg.stickerId },
            };

        default:
            return { ...base, content_type: ContentType.UNSUPPORTED, content: { original_type: msg.type } };
    }
}

module.exports = { normalizeLine };
