'use strict';

/**
 * Email Inbound Adapter (Mailgun Inbound Parse)
 *
 * TANTANGAN:
 * 1. HTML body bisa besar — truncate dan sanitize sebelum masuk broker
 * 2. Threading via In-Reply-To header → conversation_ref_id
 * 3. Attachments dikirim sebagai multipart/form-data terpisah
 * 4. Format sender: "Display Name <email@domain.com>" → parse keduanya
 */

const { v4: uuidv4 } = require('uuid');
const sanitizeHtml = require('sanitize-html');
const { ContentType } = require('../lib/canonicalSchema');

const MAX_HTML_LENGTH = 100_000; // 100 KB

/**
 * @param {Object} rawPayload  - parsed form fields dari Mailgun
 * @param {string} companyId
 * @param {string} channelId
 * @returns {{ messages: CanonicalMessage[], statusUpdates: [] }}
 */
function normalizeMailgunEmail(rawPayload, companyId, channelId) {
    const {
        sender,
        from,
        subject,
        'body-html':     htmlBody,
        'body-plain':    textBody,
        'Message-Id':    messageId,
        'In-Reply-To':   inReplyTo,
        References,
        'attachment-count': attachmentCount,
        timestamp,
    } = rawPayload;

    const senderEmail = extractEmail(from || sender);
    const senderName  = extractDisplayName(from || sender);

    const message = {
        event_id:            uuidv4(),
        company_id:          companyId,
        channel_id:          channelId,
        channel_type:        'email',
        direction:           'inbound',
        idempotency_key:     messageId,
        sender_external_id:  senderEmail,
        sender_name:         senderName,
        sender_avatar:       null,
        quoted_message_id:   null,
        conversation_ref_id: inReplyTo || extractFirstReference(References),
        provider_timestamp:  new Date(parseInt(timestamp || '0', 10) * 1000).toISOString(),
        received_at:         new Date().toISOString(),
        content_type:        ContentType.EMAIL_HTML,
        content: {
            subject:          subject || '(No Subject)',
            html_body:        sanitizeEmailHtml(htmlBody),
            text_body:        textBody || null,
            attachment_count: parseInt(attachmentCount || '0', 10),
            attachments:      [], // di-populate oleh attachment handler terpisah
        },
        // Jangan masukkan HTML body ke raw_payload — terlalu besar dan berisi PII
        raw_payload: { subject, messageId, inReplyTo, sender: senderEmail },
    };

    return { messages: [message], statusUpdates: [] };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractEmail(fromHeader) {
    if (!fromHeader) return null;
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
    const match = referencesHeader.match(/<([^>]+)>/);
    return match ? match[1] : null;
}

function sanitizeEmailHtml(html) {
    if (!html) return null;
    const truncated = html.length > MAX_HTML_LENGTH
        ? html.slice(0, MAX_HTML_LENGTH) + '<!-- truncated -->'
        : html;

    return sanitizeHtml(truncated, {
        allowedTags:       sanitizeHtml.defaults.allowedTags.concat(['img', 'table', 'thead', 'tbody', 'tr', 'td', 'th']),
        allowedAttributes: {
            '*': ['style', 'class'],
            'a': ['href', 'name', 'target'],
            'img': ['src', 'alt', 'width', 'height'],
        },
        allowedSchemes: ['http', 'https', 'mailto'],
    });
}

module.exports = { normalizeMailgunEmail };
