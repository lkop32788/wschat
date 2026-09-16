'use strict';

/**
 * Channel Resolver Service
 *
 * Memetakan {channel_type, channelId dari URL} → {company_id, channel_id di DB}
 *
 * MENGAPA INI DIPERLUKAN:
 * URL webhook kita: /webhook/whatsapp/:channelId
 * channelId di URL bisa berupa:
 * - UUID internal dari tabel channels (paling aman)
 * - Nomor telepon WA (jika provider config menggunakan nomor sebagai identifier)
 * - Bot ID dari LINE
 *
 * Kita perlu resolve ini ke internal channel UUID + company_id
 * untuk dimasukkan ke canonical message.
 *
 * CACHING STRATEGY:
 * Channel config jarang berubah → cache agresif di Redis (TTL 5 menit).
 * Invalidasi cache ketika admin update channel config dari dashboard.
 *
 * KEY: channel:meta:{channel_type}:{external_identifier}
 */

const CACHE_TTL = 300; // 5 menit

async function lookupChannelByEndpoint(channelType, channelIdentifier, redis) {
    const cacheKey = `channel:meta:${channelType}:${channelIdentifier}`;

    // 1. Cek cache Redis
    try {
        const cached = await redis.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }
    } catch (err) {
        // Cache miss atau Redis error — lanjut ke DB lookup
    }

    // 2. Query database (di production: gunakan connection pool ke SQL Server)
    // Placeholder — implementasi actual menggunakan mssql atau sequelize
    const channelInfo = await queryChannelFromDB(channelType, channelIdentifier);

    if (!channelInfo) return null;

    // 3. Cache hasilnya
    const payload = {
        channel_id: channelInfo.id,
        company_id: channelInfo.company_id,
        channel_type: channelType,
        is_active: channelInfo.is_active,
    };

    await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(payload));

    return payload;
}

/**
 * Invalidate channel cache — dipanggil dari Core API (Laravel)
 * via internal API call ketika admin update channel config.
 *
 * Endpoint: POST /internal/cache/invalidate/channel
 * Body: { channel_type, channel_identifier }
 */
async function invalidateChannelCache(channelType, channelIdentifier, redis) {
    const cacheKey = `channel:meta:${channelType}:${channelIdentifier}`;
    await redis.del(cacheKey);
}

// ── DB Query (placeholder) ─────────────────────────────────────────────────

async function queryChannelFromDB(channelType, channelIdentifier) {
    // TODO: implementasi dengan mssql
    //
    // const pool = await getSqlPool();
    // const result = await pool.request()
    //     .input('channelType', sql.NVarChar, channelType)
    //     .input('identifier', sql.NVarChar, channelIdentifier)
    //     .query(`
    //         SELECT id, company_id, is_active
    //         FROM channels
    //         WHERE type = @channelType
    //           AND JSON_VALUE(settings, '$.channel_identifier') = @identifier
    //           AND is_active = 1
    //           AND deleted_at IS NULL
    //     `);
    // return result.recordset[0] || null;

    return null; // placeholder
}

module.exports = { lookupChannelByEndpoint, invalidateChannelCache };
