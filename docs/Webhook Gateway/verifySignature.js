'use strict';

/**
 * Signature Verification Middleware
 *
 * MENGAPA INI KRITIS:
 * Tanpa verifikasi signature, endpoint webhook kita bisa di-spam oleh siapapun
 * dengan request palsu — membanjiri queue, menciptakan percakapan hantu, atau
 * memicu aksi seperti assign agent untuk pesan yang tidak nyata.
 *
 * Setiap provider punya mekanisme verifikasi berbeda:
 * - WhatsApp Cloud API : HMAC-SHA256 dari raw body, header X-Hub-Signature-256
 * - LINE               : HMAC-SHA256 dari raw body, header X-Line-Signature
 * - Telegram           : Secret token sederhana di header X-Telegram-Bot-Api-Secret-Token
 * - Email (SMTP/API)   : Tergantung provider — Mailgun, SendGrid punya masing-masing
 *
 * PENTING: Semua verifikasi menggunakan timingSafeEqual untuk mencegah timing attack.
 * Jangan pakai === untuk membandingkan HMAC — rentan terhadap timing side-channel.
 */

const crypto = require('crypto');

// ── WhatsApp Cloud API (Meta) ──────────────────────────────────────────────

/**
 * Middleware: verifikasi signature WhatsApp Cloud API
 *
 * Meta mengirim header: X-Hub-Signature-256: sha256=<hex>
 * Kita hitung ulang HMAC dengan APP_SECRET, bandingkan secara safe.
 *
 * Juga handle GET request untuk webhook verification (saat pertama setup).
 */
function verifyWhatsApp(req, res, next) {
    // Handle challenge verification (GET) — diperlukan saat setup channel
    if (req.method === 'GET') {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
            res.locals.logger.info('WhatsApp webhook verified');
            return res.status(200).send(challenge);
        }
        return res.status(403).json({ error: 'Verification failed' });
    }

    // Handle POST (actual messages)
    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
        return res.status(401).json({ error: 'Missing signature' });
    }

    // channel_id di-pass sebagai URL param: /webhook/whatsapp/:channelId
    // APP_SECRET berbeda per channel (setiap WA number punya secret sendiri)
    const appSecret = getChannelSecret('whatsapp', req.params.channelId);
    if (!appSecret) {
        return res.status(401).json({ error: 'Unknown channel' });
    }

    const expectedSig = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(req.rawBody)
        .digest('hex');

    const receivedSig = Buffer.from(signature);
    const computedSig = Buffer.from(expectedSig);

    // WAJIB timingSafeEqual — bukan ===
    if (receivedSig.length !== computedSig.length ||
        !crypto.timingSafeEqual(receivedSig, computedSig)) {
        res.locals.logger.warn({ channelId: req.params.channelId }, 'WhatsApp signature mismatch');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
}

// ── LINE Messaging API ─────────────────────────────────────────────────────

/**
 * Middleware: verifikasi signature LINE
 *
 * LINE mengirim header: X-Line-Signature: <base64 HMAC-SHA256>
 * Channel secret ada di LINE Developer Console per bot.
 */
function verifyLine(req, res, next) {
    const signature = req.headers['x-line-signature'];
    if (!signature) {
        return res.status(401).json({ error: 'Missing signature' });
    }

    const channelSecret = getChannelSecret('line', req.params.channelId);
    if (!channelSecret) {
        return res.status(401).json({ error: 'Unknown channel' });
    }

    const expected = crypto
        .createHmac('sha256', channelSecret)
        .update(req.rawBody)
        .digest('base64');

    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);

    if (expectedBuf.length !== receivedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        res.locals.logger.warn({ channelId: req.params.channelId }, 'LINE signature mismatch');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
}

// ── Telegram ───────────────────────────────────────────────────────────────

/**
 * Middleware: verifikasi secret token Telegram
 *
 * Telegram (setWebhook dengan secret_token) mengirim:
 * X-Telegram-Bot-Api-Secret-Token: <secret>
 * Lebih sederhana dari HMAC tapi tetap harus timingSafeEqual.
 */
function verifyTelegram(req, res, next) {
    const token = req.headers['x-telegram-bot-api-secret-token'];
    if (!token) {
        return res.status(401).json({ error: 'Missing token' });
    }

    const expectedToken = getChannelSecret('telegram', req.params.channelId);
    if (!expectedToken) {
        return res.status(401).json({ error: 'Unknown channel' });
    }

    const receivedBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expectedToken);

    if (receivedBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    next();
}

// ── Channel Secret Resolution ──────────────────────────────────────────────

/**
 * Ambil secret/credential per channel dari cache atau config.
 *
 * Di production: ini harus query Redis (dengan TTL cache) yang datanya
 * dari SQL Server channels.credentials_encrypted. Disetup saat channel aktif.
 *
 * Pattern:
 * 1. Cek Redis cache: channel:secret:{channelType}:{channelId}
 * 2. Cache miss → query SQL, decrypt, simpan di Redis (TTL 5 menit)
 * 3. Return secret
 *
 * NOTE: Implementasi ini menggunakan in-memory map sebagai placeholder.
 * Ganti dengan Redis lookup di production.
 */
function getChannelSecret(channelType, channelId) {
    // TODO: replace dengan Redis + SQL lookup
    // Contoh implementasi async:
    //
    // const cacheKey = `channel:secret:${channelType}:${channelId}`;
    // const cached = await redis.get(cacheKey);
    // if (cached) return cached;
    //
    // const channel = await db.query(
    //   'SELECT credentials_encrypted FROM channels WHERE id = @channelId',
    //   { channelId }
    // );
    // const secret = decrypt(channel.credentials_encrypted); // AES-256-CBC
    // await redis.setex(cacheKey, 300, secret);
    // return secret;

    return process.env[`CHANNEL_SECRET_${channelType.toUpperCase()}_${channelId}`] || null;
}

module.exports = { verifyWhatsApp, verifyLine, verifyTelegram };
