'use strict';

const { createClient } = require('redis');

/**
 * Buat dan connect Redis client dengan reconnect strategy.
 * Di-inject ke semua route handlers via res.locals.
 *
 * @param {import('pino').Logger} logger
 * @returns {Promise<import('redis').RedisClientType>}
 */
async function createRedisClient(logger) {
    const client = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
            reconnectStrategy: (retries) => {
                if (retries > 20) {
                    logger.error('Redis max reconnect attempts reached');
                    return new Error('Max reconnect attempts');
                }
                return Math.min(retries * 100, 3000);
            },
        },
    });

    client.on('error', (err) => logger.error({ err }, 'Redis client error'));
    client.on('reconnecting', () => logger.warn('Redis reconnecting'));
    client.on('ready', () => logger.info('Redis connected'));

    await client.connect();
    return client;
}

module.exports = { createRedisClient };
