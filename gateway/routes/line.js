'use strict';

const { Router } = require('express');
const { verifyLine }              = require('../middleware/verifySignature');
const { normalizeLine }           = require('../normalizer/lineAdapter');
const { lookupChannelByEndpoint } = require('../services/channelResolver');
const { publishIfNotDuplicate }   = require('../services/publisher');

const router = Router();

router.post('/:channelId', verifyLine, handleWebhook);

async function handleWebhook(req, res) {
    const { redis, amqpChannel, logger } = res.locals;
    const { channelId } = req.params;

    // LINE juga butuh 200 cepat untuk menghindari retry
    res.sendStatus(200);

    try {
        if (!req.body?.events?.length) {
            logger.debug({ channelId }, 'Empty LINE payload, skipping');
            return;
        }

        const channelInfo = await lookupChannelByEndpoint('line', channelId, redis);
        if (!channelInfo) {
            logger.warn({ channelId }, 'Unknown/inactive LINE channel, discarding');
            return;
        }

        const { messages } = normalizeLine(req.body, channelInfo.company_id, channelInfo.channel_id);

        const results = await Promise.allSettled(
            messages.map(msg => publishIfNotDuplicate(msg, amqpChannel, redis, logger))
        );

        const failed = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
            logger.error({ channelId, failed_count: failed.length }, 'Some LINE messages failed to publish');
        }

        logger.info({
            channelId,
            company_id: channelInfo.company_id,
            messages:   messages.length,
        }, 'LINE webhook processed');

    } catch (err) {
        logger.error({ err, channelId }, 'Fatal error processing LINE webhook');
    }
}

module.exports = router;
