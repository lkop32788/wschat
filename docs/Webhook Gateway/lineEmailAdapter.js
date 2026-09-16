'use strict';

/**
 * LINE Messaging API Adapter
 *
 * TANTANGAN LINE:
 * 1. Satu webhook bisa berisi array `events` dari berbagai type
 * 2. LINE punya banyak event type: message, postback, follow, unfollow, join, leave, dll
 *    → Kita hanya peduli `message` events untuk inbox
 * 3. LINE user ID format: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" (32 hex chars)
 * 4. Source bisa: user (1-on-1), group, room → kita hanya handle user untuk CS inbox
 * 5. Timestamp dalam milliseconds (bukan seconds seperti WA)
 */

const { v4: uuidv4 } = require('uuid');
const { ContentType } = require('./canonicalSchema');

function normalizeLine(rawPayload, companyId, channelId) {
    const messages = [];

    for (const event of rawPayload.events || []) {
        // Hanya proses pesan 1-on-1 (source.type === 'user')
        // Group/room messages tidak masuk ke CS inbox
        if (event.source?.type !== 'user') continue;

        // Hanya proses message events
        if (event.type !== 'message' && event.type !== 'postback') continue;

        const canonical = buildCanonicalFromLineEvent(event, companyId, channelId);
        if (canonical) messages.push(canonical);
    }

    return { messages, statusUpdates: [] }; // LINE tidak kirim delivery status via webhook
}

function buildCanonicalFromLineEvent(event, companyId, channelId) {
    const base = {
        event_id: uuidv4(),
        company_id: companyId,
        channel_id: channelId,
        channel_type: 'line',
        direction: 'inbound',
        idempotency_key: event.webhookEventId || event.message?.id,
        sender_external_id: event.source.userId,
        sender_name: null,   // LINE tidak expose nama di webhook — perlu API call terpisah
        sender_avatar: null,
        quoted_message_id: null,    // LINE tidak support quote di webhook payload
        conversation_ref_id: null,
        provider_timestamp: new Date(event.timestamp).toISOString(), // ms → ISO
        received_at: new Date().toISOString(),
        raw_payload: event,
    };

    // Handle postback (button tap di Flex Message/Template)
    if (event.type === 'postback') {
        return {
            ...base,
            idempotency_key: `postback_${event.source.userId}_${event.timestamp}`,
            content_type: ContentType.BUTTON_REPLY,
            content: {
                button_payload: event.postback.data,
                button_text: event.postback.displayText || null,
            },
        };
    }

    const msg = event.message;
    switch (msg.type) {
        case 'text':
            return {
                ...base,
                content_type: ContentType.TEXT,
                content: {
                    body: msg.text,
                    // LINE mentions: msg.mention?.mentionees (jarang dipakai di CS context)
                },
            };

        case 'image':
            return {
                ...base,
                content_type: ContentType.IMAGE,
                content: {
                    provider_media_id: msg.id,      // perlu GET /v2/bot/message/{id}/content
                    // contentProvider.type: 'line' = bisa download via API
                    //                       'external' = sudah ada URL langsung
                    external_url: msg.contentProvider?.type === 'external'
                        ? msg.contentProvider.originalContentUrl
                        : null,
                },
            };

        case 'audio':
            return {
                ...base,
                content_type: ContentType.AUDIO,
                content: {
                    provider_media_id: msg.id,
                    duration_ms: msg.duration || null,
                },
            };

        case 'video':
            return {
                ...base,
                content_type: ContentType.VIDEO,
                content: {
                    provider_media_id: msg.id,
                    duration_ms: msg.duration || null,
                    preview_url: msg.contentProvider?.previewImageUrl || null,
                },
            };

        case 'file':
            return {
                ...base,
                content_type: ContentType.FILE,
                content: {
                    provider_media_id: msg.id,
                    filename: msg.fileName,
                    file_size: msg.fileSize,
                },
            };

        case 'location':
            return {
                ...base,
                content_type: ContentType.LOCATION,
                content: {
                    latitude: msg.latitude,
                    longitude: msg.longitude,
                    title: msg.title || null,
                    address: msg.address || null,
                },
            };

        case 'sticker':
            return {
                ...base,
                content_type: ContentType.STICKER,
                content: {
                    package_id: msg.packageId,
                    sticker_id: msg.stickerId,
                    // keywords tersedia di beberapa sticker untuk NLP
                    keywords: msg.stickerResourceType === 'ANIMATION_SOUND'
                        ? msg.keywords
                        : null,
                },
            };

        default:
            return {
                ...base,
                content_type: ContentType.UNSUPPORTED,
                content: { original_type: msg.type },
            };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Email Adapter (Inbound via Mailgun/SendGrid/Postmark Parse Webhook)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Email Inbound Adapter
 *
 * Email providers seperti Mailgun, SendGrid, Postmark menyediakan
 * "inbound parse webhook" — email yang masuk ke domain kita di-forward
 * sebagai multipart/form-data HTTP POST.
 *
 * TANTANGAN EMAIL:
 * 1. HTML body bisa sangat besar (embedded image, quoted replies)
 * 2. Threading: In-Reply-To header untuk link ke conversation yang sama
 * 3. Attachments: bisa banyak, masing-masing sebagai file terpisah
 * 4. Spam: perlu filter basic sebelum masuk ke inbox
 * 5. Format berbeda antara Mailgun, SendGrid, Postmark
 *
 * Kita buat adapter untuk Mailgun sebagai contoh.
 */

function normalizeMailgunEmail(rawPayload, companyId, channelId) {
    // Mailgun sends multipart form fields (sudah di-parse oleh multer/formidable)
    const {
        sender,
        from,
        subject,
        'body-html': htmlBody,
        'body-plain': textBody,
        'Message-Id': messageId,
        'In-Reply-To': inReplyTo,
        References,
        'attachment-count': attachmentCount,
        timestamp,
        token,
        signature,
    } = rawPayload;

    // Parse sender display name dan email
    const senderEmail = extractEmail(from || sender);
    const senderName = extractDisplayName(from || sender);

    const message = {
        event_id: uuidv4(),
        company_id: companyId,
        channel_id: channelId,
        channel_type: 'email',
        direction: 'inbound',
        idempotency_key: messageId,
        sender_external_id: senderEmail,
        sender_name: senderName,
        sender_avatar: null,
        quoted_message_id: null,
        // Threading via In-Reply-To header — consumer akan lookup conversation
        conversation_ref_id: inReplyTo || extractFirstReference(References),
        provider_timestamp: new Date(parseInt(timestamp) * 1000).toISOString(),
        received_at: new Date().toISOString(),
        content_type: ContentType.EMAIL_HTML,
        content: {
            subject: subject || '(No Subject)',
            html_body: sanitizeEmailHtml(htmlBody),
            text_body: textBody || null,
            // Attachments: Mailgun menyertakan sebagai 'attachment-1', 'attachment-2', dll
            // Di production: upload ke object storage (S3/R2), simpan URL
            attachment_count: parseInt(attachmentCount || 0),
            attachments: [], // di-populate oleh attachment handler terpisah
        },
        raw_payload: { subject, messageId, inReplyTo },  // jangan simpan full HTML di raw
    };

    return { messages: [message], statusUpdates: [] };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractEmail(fromHeader) {
    if (!fromHeader) return null;
    // "Display Name <email@domain.com>" → "email@domain.com"
    const match = fromHeader.match(/<([^>]+)>/);
    return match ? match[1].toLowerCase() : fromHeader.toLowerCase().trim();
}

function extractDisplayName(fromHeader) {
    if (!fromHeader) return null;
    const match = fromHeader.match(/^([^<]+)</);
    return match ? match[1].trim().replace(/^"|"$/g, '') : null;
}

function extractFirstReference(referencesHeader) {
    if (!referencesHeader) return null;
    // References: <msgid1@domain> <msgid2@domain> — ambil yang pertama
    const match = referencesHeader.match(/<([^>]+)>/);
    return match ? match[1] : null;
}

/**
 * Basic HTML sanitization untuk mencegah XSS saat ditampilkan di dashboard.
 * Di production: gunakan library seperti DOMPurify (server-side) atau sanitize-html.
 */
function sanitizeEmailHtml(html) {
    if (!html) return null;
    // Placeholder — ganti dengan proper sanitizer di production
    // Minimal: buang <script> tags
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/javascript:/gi, '');
}

module.exports = { normalizeLine, normalizeMailgunEmail };
