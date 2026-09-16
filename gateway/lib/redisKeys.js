'use strict';

/**
 * Redis Key Naming — sesuai konvensi Phase 1: redis_key_design.js
 * Format: {scope}:{company_id}:{entity}:{id}
 */

const webhookIdempotencyKey = (channelType, providerMsgId) =>
    `idempotent:webhook:${channelType}:${providerMsgId}`;

const channelMetaKey = (channelType, channelIdentifier) =>
    `channel:meta:${channelType}:${channelIdentifier}`;

const channelSecretKey = (channelType, channelId) =>
    `channel:secret:${channelType}:${channelId}`;

const conversationStateKey = (companyId, convId) =>
    `conv:state:${companyId}:${convId}`;

const realtimeChannel = (companyId) =>
    `channel:events:${companyId}`;

/**
 * Dedup check: set NX dengan TTL 5 menit.
 * @returns {Promise<boolean>} true jika duplikat (sudah ada sebelumnya)
 */
async function isWebhookDuplicate(redis, channelType, providerMsgId) {
    const key = webhookIdempotencyKey(channelType, providerMsgId);
    const result = await redis.set(key, '1', { NX: true, EX: 300 });
    return result === null; // null = key sudah ada = duplikat
}

module.exports = {
    webhookIdempotencyKey,
    channelMetaKey,
    channelSecretKey,
    conversationStateKey,
    realtimeChannel,
    isWebhookDuplicate,
};
