'use strict';

/**
 * Webhook Gateway — Entry Point
 *
 * ARSITEKTUR KRITIS: Server ini sengaja dibuat TERPISAH dari Core API (Laravel).
 * Alasannya:
 * 1. Laravel bootstraps banyak service (Eloquent, Auth, dll) — terlalu berat
 *    untuk menangani ribuan webhook/detik dengan latency rendah.
 * 2. Node.js event loop non-blocking cocok untuk I/O-bound workload ini.
 * 3. Scaling horizontal: gateway ini bisa di-scale independen dari API server.
 *
 * PRINSIP UTAMA: "Receive fast, process async"
 * - HTTP handler HANYA melakukan: verify signature → dedup check → enqueue
 * - Semua logika bisnis (routing, assignment, reply) ada di consumer, BUKAN di sini
 */

const express = require('express');
const { json, raw } = require('express');
const { createClient } = require('redis');
const amqplib = require('amqplib');
const pino = require('pino');

const whatsappRouter = require('./routes/whatsapp');
const lineRouter = require('./routes/line');
const emailRouter = require('./routes/email');
const telegramRouter = require('./routes/telegram');
const { healthCheck } = require('./handlers/health');

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    // Di production gunakan pino-pretty hanya untuk development
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
});

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function bootstrap() {
    // Redis connection — shared di seluruh app via module singleton
    const redis = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
            reconnectStrategy: (retries) => Math.min(retries * 50, 2000),
        },
    });
    redis.on('error', (err) => logger.error({ err }, 'Redis connection error'));
    await redis.connect();

    // RabbitMQ connection + channel
    // PENTING: Buat satu connection, satu channel — reuse untuk semua publish
    // Jangan buat connection baru per request (sangat mahal)
    const amqpConn = await amqplib.connect(
        process.env.RABBITMQ_URL || 'amqp://localhost'
    );
    const amqpChannel = await amqpConn.createConfirmChannel();

    // Declare exchanges dan queues (idempotent — aman dipanggil ulang)
    await setupBrokerTopology(amqpChannel);

    // Tangani disconnect gracefully
    amqpConn.on('error', (err) => {
        logger.error({ err }, 'RabbitMQ connection error — will reconnect');
        // Di production: gunakan library seperti amqplib-retry atau amqp-connection-manager
    });

    const app = express();

    // ── Global Middleware ──────────────────────────────────────────────────

    // Raw body HARUS diparsing sebelum json() untuk keperluan signature verification.
    // WhatsApp dan LINE membutuhkan raw body (bukan parsed) untuk HMAC.
    // Simpan raw body di req.rawBody untuk diakses verifier.
    app.use(
        raw({
            type: ['application/json', 'application/x-www-form-urlencoded'],
            verify: (req, _res, buf) => {
                req.rawBody = buf; // Buffer mentah untuk HMAC verification
            },
        })
    );
    app.use(json()); // Parse setelah rawBody di-capture

    // Request logging (structured, masuk ke log aggregator)
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            logger.info({
                method: req.method,
                url: req.url,
                status: res.statusCode,
                duration_ms: Date.now() - start,
                provider: req.headers['x-provider'] || 'unknown',
            });
        });
        next();
    });

    // Inject dependencies ke semua route handlers via res.locals
    // Pattern ini menghindari singleton global yang sulit di-test
    app.use((req, res, next) => {
        res.locals.redis = redis;
        res.locals.amqpChannel = amqpChannel;
        res.locals.logger = logger;
        next();
    });

    // ── Routes ─────────────────────────────────────────────────────────────

    app.get('/health', healthCheck);

    // Setiap provider punya endpoint terpisah karena:
    // 1. Signature verification beda per provider
    // 2. Struktur payload beda → adapter berbeda
    // 3. Memudahkan monitoring per provider
    app.use('/webhook/whatsapp', whatsappRouter);
    app.use('/webhook/line', lineRouter);
    app.use('/webhook/email', emailRouter);
    app.use('/webhook/telegram', telegramRouter);

    // 404 handler
    app.use((req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    // Global error handler — JANGAN expose stack trace ke client
    app.use((err, req, res, _next) => {
        logger.error({ err, url: req.url }, 'Unhandled error in gateway');
        res.status(500).json({ error: 'Internal server error' });
    });

    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        logger.info({ port: PORT }, 'Webhook gateway started');
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
        logger.info('SIGTERM received — shutting down gracefully');
        await amqpChannel.close();
        await amqpConn.close();
        await redis.quit();
        process.exit(0);
    });
}

// ── Broker Topology ────────────────────────────────────────────────────────

async function setupBrokerTopology(channel) {
    // Topic exchange — routing key menentukan ke queue mana
    // Format routing key: {direction}.{channel_type}
    // Contoh: inbound.whatsapp, inbound.line, outbound.whatsapp
    await channel.assertExchange('messages', 'topic', { durable: true });

    // Dead letter exchange untuk pesan yang gagal diproses setelah N retry
    await channel.assertExchange('messages.dlx', 'direct', { durable: true });

    // Queue inbound per channel type — consumer bisa scale per channel
    const inboundQueues = ['whatsapp', 'line', 'email', 'telegram', 'sms'];
    for (const channelType of inboundQueues) {
        const queueName = `inbound.${channelType}`;
        await channel.assertQueue(queueName, {
            durable: true,          // survive broker restart
            arguments: {
                'x-dead-letter-exchange': 'messages.dlx',
                'x-dead-letter-routing-key': `dead.${channelType}`,
                'x-message-ttl': 300000,    // 5 menit — jika tidak diproses, ke DLX
            },
        });
        await channel.bindQueue(queueName, 'messages', `inbound.${channelType}`);
    }

    // Dead letter queue untuk monitoring & reprocessing manual
    await channel.assertQueue('dead.letters', { durable: true });
    await channel.bindQueue('dead.letters', 'messages.dlx', '#');
}

bootstrap().catch((err) => {
    console.error('Fatal: gateway failed to start', err);
    process.exit(1);
});
