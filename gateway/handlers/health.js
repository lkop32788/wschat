'use strict';

/**
 * Health Check Handler
 * Digunakan oleh load balancer / container orchestrator (k8s, ECS) untuk liveness probe.
 */

async function healthCheck(req, res) {
    const { redis } = res.locals;
    const checks = { redis: 'ok', broker: 'ok' };

    // Ping Redis
    try {
        await redis.ping();
    } catch {
        checks.redis = 'error';
    }

    // amqpChannel tersedia di res.locals — periksa apakah masih terhubung
    const amqpChannel = res.locals.amqpChannel;
    if (!amqpChannel || amqpChannel.connection?.stream?.destroyed) {
        checks.broker = 'error';
    }

    const healthy = Object.values(checks).every(v => v === 'ok');
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        checks,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
}

module.exports = { healthCheck };
