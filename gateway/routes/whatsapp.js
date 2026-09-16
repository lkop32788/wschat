'use strict';

/**
 * WhatsApp Route Handler
 *
 * PRINSIP KRITIS: Kirim 200 OK SECEPATNYA.
 * Meta retry jika tidak mendapat 200 dalam ~20 detik → duplikat di queue.
 * Solusi: res.sendStatus(200) langsung, proses lanjut async fire-and-forget.
 * Error setelah 200 tidak ter-expose ke provider → WAJIB di-log.
 */

const { Router } = require('express');
const { verifyWhatsApp }         = require('../middleware/verifySignature');
const { normalizeWhatsApp }      = require('../normalizer/whatsappAdapter');
const { lookupChannelByEndpoint } = require('../services/channelResolver');
const { publishIfNotDuplicate, publishStatusUpdate } = require('../services/publisher');

const router = Router();

// GET  — challenge verification (Meta setup)
// POST — actual message events
router.route('/:channelId')
    .get(verifyWhatsApp)   // verifyWhatsApp handles GET response internally
    .post(verifyWhatsApp, handleWebhook);

async function handleWebhook(req, res) {
    const { redis, amqpChannel, logger } = res.locals;
    const { channelId } = req.params;

    // ── 200 OK SEKARANG — sebelum proses apapun ─────────────────────────────
    res.sendStatus(200);

    try {
        if (!req.body?.entry?.length) {
            logger.debug({ channelId }, 'Empty WhatsApp payload, skipping');
            return;
        }

        const channelInfo = await lookupChannelByEndpoint('whatsapp', channelId, redis);
        if (!channelInfo) {
            logger.warn({ channelId }, 'Unknown/inactive WhatsApp channel, discarding');
            return;
        }

        const { messages, statusUpdates } = normalizeWhatsApp(
            req.body, channelInfo.company_id, channelInfo.channel_id
        );

        const results = await Promise.allSettled([
            ...messages.map(msg => publishIfNotDuplicate(msg, amqpChannel, redis, logger)),
            ...statusUpdates.map(su => publishStatusUpdate(su, amqpChannel)),
        ]);

        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
            logger.error({
                channelId,
                failed_count: failed.length,
                errors: failed.map(f => f.reason?.message),
            }, 'Some messages failed to publish');
        }

        logger.info({
            channelId,
            company_id:    channelInfo.company_id,
            messages:      messages.length,
            status_updates: statusUpdates.length,
            published:     results.filter(r => r.status === 'fulfilled' && r.value?.published).length,
        }, 'WhatsApp webhook processed');

    } catch (err) {
        // Error di sini tidak mempengaruhi provider (sudah dapat 200)
        logger.error({ err, channelId }, 'Fatal error processing WhatsApp webhook');
    }
}

module.exports = router;
