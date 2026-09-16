'use strict';

/**
 * Email Inbound Route (Mailgun Inbound Parse)
 *
 * Mailgun POST-nya sebagai multipart/form-data, bukan JSON.
 * Express tidak parse multipart secara default — gunakan express-formidable
 * atau multer. Di sini kita parse manual dari req.body yang sudah di-set
 * oleh middleware (atau gunakan raw body untuk Mailgun signature verification).
 */

const { Router } = require('express');
const { verifyMailgun }           = require('../middleware/verifySignature');
const { normalizeMailgunEmail }   = require('../normalizer/emailAdapter');
const { lookupChannelByEndpoint } = require('../services/channelResolver');
const { publishIfNotDuplicate }   = require('../services/publisher');

const router = Router();

router.post('/:channelId', verifyMailgun, handleWebhook);

async function handleWebhook(req, res) {
    const { redis, amqpChannel, logger } = res.locals;
    const { channelId } = req.params;

    res.sendStatus(200);

    try {
        if (!req.body?.['Message-Id'] && !req.body?.sender) {
            logger.debug({ channelId }, 'Unrecognized email payload, skipping');
            return;
        }

        const channelInfo = await lookupChannelByEndpoint('email', channelId, redis);
        if (!channelInfo) {
            logger.warn({ channelId }, 'Unknown/inactive email channel, discarding');
            return;
        }

        const { messages } = normalizeMailgunEmail(req.body, channelInfo.company_id, channelInfo.channel_id);

        const results = await Promise.allSettled(
            messages.map(msg => publishIfNotDuplicate(msg, amqpChannel, redis, logger))
        );

        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
            logger.error({ channelId, failed_count: failed.length }, 'Some email messages failed to publish');
        }

        logger.info({
            channelId,
            company_id: channelInfo.company_id,
            messages:   messages.length,
        }, 'Email webhook processed');

    } catch (err) {
        logger.error({ err, channelId }, 'Fatal error processing email webhook');
    }
}

module.exports = router;
