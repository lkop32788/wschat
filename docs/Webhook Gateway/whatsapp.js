'use strict';

/**
 * WhatsApp Route Handler
 *
 * Ini adalah titik pertemuan semua middleware:
 * verify signature → lookup channel → idempotency check → normalize → publish
 *
 * POLA RESPONS KRITIS:
 * Kirim 200 OK SECEPATNYA — idealnya sebelum proses apapun.
 * Meta/WhatsApp akan retry jika tidak mendapat 200 dalam ~20 detik.
 * Retry ini akan membuat duplikat di queue jika tidak ada idempotency check.
 *
 * IMPLEMENTASI: res.sendStatus(200) dikirim dulu, lalu proses dilanjutkan async.
 * Ini berarti error setelah 200 tidak akan ter-expose ke provider —
 * pastikan semua error di-log dengan baik untuk monitoring.
 */

const { Router } = require('express');
const { verifyWhatsApp } = require('../middleware/verifySignature');
const { normalizeWhatsApp } = require('../normalizer/whatsappAdapter');
const { isWebhookDuplicate } = require('../../schema/redis_key_design');
const { lookupChannelByEndpoint } = require('../services/channelResolver');

const router = Router();

// GET — Challenge verification (WhatsApp setup)
// POST — Actual message events
// Keduanya ditangani di dalam verifyWhatsApp middleware
router.route('/:channelId')
    .get(verifyWhatsApp, (req, res) => {
        // verifyWhatsApp sudah handle response untuk GET
        // Ini fallback jika middleware tidak intercept
        res.status(200).send(req.query['hub.challenge']);
    })
    .post(verifyWhatsApp, handleWhatsAppWebhook);

async function handleWhatsAppWebhook(req, res) {
    const { redis, amqpChannel, logger } = res.locals;
    const { channelId } = req.params;

    // ── Langkah 1: Balas 200 OK SEKARANG ──────────────────────────────────
    // Provider tidak perlu tahu apa yang kita lakukan dengan pesan ini.
    // Semua proses berikutnya adalah async fire-and-forget.
    res.sendStatus(200);

    // ── Proses async (setelah 200 dikirim) ────────────────────────────────
    try {
        const rawPayload = req.body;

        // Validasi basic — jangan crash jika payload tidak sesuai ekspektasi
        if (!rawPayload?.entry?.length) {
            logger.debug({ channelId }, 'Empty WhatsApp payload, skipping');
            return;
        }

        // ── Langkah 2: Resolve company_id dari channel_id ─────────────────
        // channelId ada di URL params, company_id perlu di-lookup
        const channelInfo = await lookupChannelByEndpoint('whatsapp', channelId, redis);
        if (!channelInfo) {
            logger.warn({ channelId }, 'Unknown WhatsApp channel, discarding');
            return;
        }

        // ── Langkah 3: Normalize payload ──────────────────────────────────
        const { messages, statusUpdates } = normalizeWhatsApp(
            rawPayload,
            channelInfo.company_id,
            channelInfo.channel_id
        );

        // ── Langkah 4: Idempotency check + Publish per message ────────────
        const publishResults = await Promise.allSettled([
            ...messages.map(msg => publishIfNotDuplicate(msg, amqpChannel, redis, logger)),
            ...statusUpdates.map(su => publishStatusUpdate(su, amqpChannel, logger)),
        ]);

        // Log hasil publish — jangan throw, sudah balas 200
        const failed = publishResults.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
            logger.error({
                channelId,
                failed_count: failed.length,
                errors: failed.map(f => f.reason?.message),
            }, 'Some messages failed to publish');
        }

        logger.info({
            channelId,
            company_id: channelInfo.company_id,
            messages_count: messages.length,
            status_updates_count: statusUpdates.length,
            failed_count: failed.length,
        }, 'WhatsApp webhook processed');

    } catch (err) {
        // Error di sini tidak mempengaruhi provider (sudah dapat 200)
        // Tapi HARUS di-log untuk alerting
        logger.error({ err, channelId }, 'Fatal error processing WhatsApp webhook');
    }
}

/**
 * Idempotency check + publish ke RabbitMQ.
 *
 * Menggunakan Redis SET NX untuk memastikan satu idempotency_key
 * hanya diproses sekali, bahkan jika webhook datang duplikat.
 */
async function publishIfNotDuplicate(canonicalMsg, amqpChannel, redis, logger) {
    // Cek duplikat dengan Redis
    const isDuplicate = await isWebhookDuplicate(
        redis,
        canonicalMsg.channel_type,
        canonicalMsg.idempotency_key
    );

    if (isDuplicate) {
        logger.debug({
            idempotency_key: canonicalMsg.idempotency_key,
        }, 'Duplicate webhook detected, skipping');
        return;
    }

    // Publish ke exchange dengan routing key: inbound.{channel_type}
    const routingKey = `inbound.${canonicalMsg.channel_type}`;
    const messageBuffer = Buffer.from(JSON.stringify(canonicalMsg));

    // publishConfirm = tunggu broker konfirmasi diterima (publisher confirm mode)
    await new Promise((resolve, reject) => {
        const ok = amqpChannel.publish(
            'messages',
            routingKey,
            messageBuffer,
            {
                persistent: true,           // survive broker restart
                contentType: 'application/json',
                contentEncoding: 'utf-8',
                messageId: canonicalMsg.event_id,
                timestamp: Math.floor(Date.now() / 1000),
                headers: {
                    'x-company-id': canonicalMsg.company_id,
                    'x-channel-type': canonicalMsg.channel_type,
                },
            }
        );

        if (!ok) {
            // Buffer penuh — back pressure dari broker
            // amqpChannel akan emit 'drain' saat siap
            amqpChannel.once('drain', resolve);
        } else {
            resolve();
        }
    });

    logger.debug({
        event_id: canonicalMsg.event_id,
        routing_key: routingKey,
    }, 'Message published to broker');
}

/**
 * Publish status update (delivered, read, failed) ke queue terpisah.
 * Consumer akan update field `status` di MongoDB messages collection.
 */
async function publishStatusUpdate(statusUpdate, amqpChannel, logger) {
    amqpChannel.publish(
        'messages',
        'status.whatsapp',
        Buffer.from(JSON.stringify(statusUpdate)),
        { persistent: true, contentType: 'application/json' }
    );
}

module.exports = router;
