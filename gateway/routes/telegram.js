'use strict';

const { Router } = require('express');
const { verifyTelegram }          = require('../middleware/verifySignature');
const { normalizeTelegram }       = require('../normalizer/telegramAdapter');
const { lookupChannelByEndpoint } = require('../services/channelResolver');
const { publishIfNotDuplicate }   = require('../services/publisher');

const router = Router();

router.post('/:channelId', verifyTelegram, handleWebhook);

async function handleWebhook(req, res) {
    const { redis, amqpChannel, logger } = res.locals;
    const { channelId } = req.params;

    // Telegram tunggu 200 atau re-deliver setelah ~1 menit (lebih toleran dari WA)
    res.sendStatus(200);

    try {
        if (!req.body?.update_id) {
            logger.debug({ channelId }, 'Invalid Telegram update, skipping');
            return;
        }

        const channelInfo = await lookupChannelByEndpoint('telegram', channelId, redis);
        if (!channelInfo) {
            logger.warn({ channelId }, 'Unknown/inactive Telegram channel, discarding');
            return;
        }

        const { messages } = normalizeTelegram(req.body, channelInfo.company_id, channelInfo.channel_id);

        const results = await Promise.allSettled(
            messages.map(msg => publishIfNotDuplicate(msg, amqpChannel, redis, logger))
        );

        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
            logger.error({ channelId, failed_count: failed.length }, 'Some Telegram messages failed to publish');
        }

        if (messages.length > 0) {
            logger.info({
                channelId,
                company_id: channelInfo.company_id,
                messages:   messages.length,
            }, 'Telegram webhook processed');
        }

    } catch (err) {
        logger.error({ err, channelId }, 'Fatal error processing Telegram webhook');
    }
}

module.exports = router;
