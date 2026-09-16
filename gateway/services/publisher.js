'use strict';

/**
 * Publisher Service
 *
 * Publish canonical message ke RabbitMQ setelah idempotency check.
 * Semua publish dilakukan dalam confirm mode — broker konfirmasi sebelum resolve.
 */

const { isWebhookDuplicate } = require('../lib/redisKeys');

/**
 * Publish ke broker jika bukan duplikat.
 * Return: { published: true } | { published: false, reason: 'duplicate' }
 *
 * @param {Object} canonicalMsg
 * @param {import('amqplib').ConfirmChannel} amqpChannel
 * @param {import('redis').RedisClientType} redis
 * @param {import('pino').Logger} logger
 */
async function publishIfNotDuplicate(canonicalMsg, amqpChannel, redis, logger) {
    const isDuplicate = await isWebhookDuplicate(
        redis,
        canonicalMsg.channel_type,
        canonicalMsg.idempotency_key
    );

    if (isDuplicate) {
        logger.debug({ idempotency_key: canonicalMsg.idempotency_key }, 'Duplicate webhook, skipping');
        return { published: false, reason: 'duplicate' };
    }

    await publishToExchange(amqpChannel, `inbound.${canonicalMsg.channel_type}`, canonicalMsg, {
        headers: {
            'x-company-id':   canonicalMsg.company_id,
            'x-channel-type': canonicalMsg.channel_type,
        },
    });

    logger.debug({
        event_id:    canonicalMsg.event_id,
        routing_key: `inbound.${canonicalMsg.channel_type}`,
    }, 'Message published');

    return { published: true };
}

/**
 * Publish status update (delivered, read, failed) ke exchange message.status.
 *
 * @param {Object} statusUpdate
 * @param {import('amqplib').ConfirmChannel} amqpChannel
 */
async function publishStatusUpdate(statusUpdate, amqpChannel) {
    await publishToExchange(
        amqpChannel,
        `status.${statusUpdate.channel_type}`,
        statusUpdate,
        {},
        'message.status'
    );
}

// ── Internal ─────────────────────────────────────────────────────────────

function publishToExchange(amqpChannel, routingKey, payload, extraOptions = {}, exchange = 'messages') {
    return new Promise((resolve, reject) => {
        const buf = Buffer.from(JSON.stringify(payload));
        const options = {
            persistent:      true,
            contentType:     'application/json',
            contentEncoding: 'utf-8',
            messageId:       payload.event_id || undefined,
            timestamp:       Math.floor(Date.now() / 1000),
            ...extraOptions,
        };

        const ok = amqpChannel.publish(exchange, routingKey, buf, options);

        if (!ok) {
            // Back pressure — buffer broker penuh, tunggu drain
            amqpChannel.once('drain', resolve);
        } else {
            resolve();
        }
    });
}

module.exports = { publishIfNotDuplicate, publishStatusUpdate };
