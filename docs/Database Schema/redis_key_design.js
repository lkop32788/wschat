/**
 * Redis Key Design: Enterprise Omnichannel Platform
 *
 * KONVENSI KEY: {scope}:{company_id}:{entity}:{id}:{field}
 *
 * Alasan strict naming convention:
 * 1. Multi-tenant: company_id sebagai namespace mencegah data bleed antar tenant
 * 2. Pattern-scan efisien: SCAN agent:{cid}:* untuk bulk ops dalam satu tenant
 * 3. TTL management: semua key punya TTL, tidak ada orphan key
 *
 * CATATAN PENTING: Redis adalah ephemeral state. Setiap state di Redis
 * HARUS bisa di-rebuild dari SQL/MongoDB jika Redis restart/flush.
 * Jangan simpan source-of-truth di Redis.
 */


// ══════════════════════════════════════════════════════════════════════════════
// 1. AGENT PRESENCE & AVAILABILITY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Status online/offline/busy per agent.
 *
 * Key:   agent:presence:{company_id}:{agent_id}
 * Type:  HASH
 * TTL:   300 seconds (heartbeat dari frontend harus refresh setiap 60s)
 *        Jika TTL expired = agent dianggap offline (disconnected tanpa logout)
 */
const agentPresenceKey = (companyId, agentId) =>
    `agent:presence:${companyId}:${agentId}`;

// Fields:
// {
//   status: "online" | "offline" | "busy" | "away"
//   socket_id: "socket-abc123"     -- Socket.io connection ID terkini
//   connected_at: "1720000000"     -- unix timestamp
//   last_heartbeat: "1720000060"
// }

// Pattern untuk query semua agent yang online di satu company:
// SCAN 0 MATCH agent:presence:{company_id}:* COUNT 100
// Lalu filter HGET * status == "online"


/**
 * Sorted Set untuk ranking agen berdasarkan beban kerja aktif.
 * Digunakan oleh Dispatcher Engine sebagai tie-breaker (Least-Active algorithm).
 *
 * Key:   agent:workload:{company_id}
 * Type:  ZSET (Sorted Set)
 * Score: jumlah active_chats saat ini (lebih rendah = lebih diprioritaskan)
 * TTL:   Tidak ada TTL — di-update setiap ada assignment/resolve
 */
const agentWorkloadKey = (companyId) =>
    `agent:workload:${companyId}`;

// Operasi:
// ZADD agent:workload:{cid} 3 {agent_id}        -- set beban agent = 3 chat
// ZINCRBY agent:workload:{cid} 1 {agent_id}     -- tambah 1 saat dapat chat baru
// ZINCRBY agent:workload:{cid} -1 {agent_id}    -- kurangi 1 saat chat resolved
// ZRANGEBYSCORE agent:workload:{cid} 0 {max_load} LIMIT 0 10  -- cari agent tersedia


/**
 * Set agent yang online + skill tertentu — digunakan Dispatcher Engine.
 *
 * Key:   agent:skill:{company_id}:{skill_tag}
 * Type:  SET
 * TTL:   Sama dengan TTL presence (refresh setiap heartbeat)
 *
 * Logika: saat agent heartbeat, rebuild SET ini dari skill_tags di user profile.
 */
const agentSkillKey = (companyId, skillTag) =>
    `agent:skill:${companyId}:${skillTag}`;

// SADD agent:skill:{cid}:billing {agent_id}
// SMEMBERS agent:skill:{cid}:billing   -- semua agent dengan skill "billing"
// SINTER agent:skill:{cid}:billing agent:skill:{cid}:indonesian  -- multi-skill filter


// ══════════════════════════════════════════════════════════════════════════════
// 2. CONVERSATION STATE (Fast-Access)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * State aktif sebuah conversation — untuk avoid round-trip ke SQL.
 *
 * Key:   conv:state:{company_id}:{conversation_id}
 * Type:  HASH
 * TTL:   3600s (refresh setiap ada aktivitas dalam conversation)
 */
const conversationStateKey = (companyId, convId) =>
    `conv:state:${companyId}:${convId}`;

// Fields:
// {
//   status: "open"
//   assigned_agent_id: "{uuid}"
//   channel_type: "whatsapp"
//   is_bot_active: "1" | "0"       -- flag apakah bot sedang handle
//   contact_id: "{uuid}"
//   last_activity: "1720000000"    -- untuk deteksi idle conversation
// }


/**
 * RACE CONDITION PREVENTION: Conversation Assignment Lock
 *
 * Skenario race condition:
 * - Dispatcher Engine menerima 5 pesan masuk hampir bersamaan
 * - 5 worker thread mencoba assign ke agent yang sama secara bersamaan
 * - Hasilnya: satu agent dapat 5 chat sekaligus (bukan round-robin)
 *
 * Solusi: Distributed Lock dengan Redis SET NX EX
 *
 * Key:   lock:conv_assign:{conversation_id}
 * Type:  STRING (value = worker ID yang memegang lock)
 * TTL:   5 seconds (auto-release jika worker crash)
 */
const conversationAssignLockKey = (convId) =>
    `lock:conv_assign:${convId}`;

// Implementasi lock di Node.js:
async function acquireAssignmentLock(redis, convId, workerId, ttlSeconds = 5) {
    // SET key value NX EX ttl — atomic, hanya set jika key belum ada
    const result = await redis.set(
        conversationAssignLockKey(convId),
        workerId,
        'NX',   // hanya set jika NOT EXISTS
        'EX',   // dengan expiry
        ttlSeconds
    );
    return result === 'OK'; // true = berhasil dapat lock, false = ada yang memegang
}

async function releaseAssignmentLock(redis, convId, workerId) {
    // CRITICAL: hanya release jika kita yang memegang lock (Lua script untuk atomicity)
    const lua = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        else
            return 0
        end
    `;
    await redis.eval(lua, 1, conversationAssignLockKey(convId), workerId);
}


// ══════════════════════════════════════════════════════════════════════════════
// 3. RATE LIMITING
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Rate limiter per channel untuk outbound messages.
 * Penting untuk broadcast engine agar tidak kena ban dari provider.
 *
 * Key:   ratelimit:outbound:{company_id}:{channel_id}:{window}
 * Type:  STRING (counter)
 * TTL:   Sesuai window (misal: 60s untuk rate per menit)
 *
 * Pattern: Sliding Window Counter
 */
const rateLimitKey = (companyId, channelId, windowUnix) =>
    `ratelimit:outbound:${companyId}:${channelId}:${windowUnix}`;

async function checkAndIncrementRateLimit(redis, companyId, channelId, maxPerMinute) {
    const window = Math.floor(Date.now() / 1000 / 60); // 1-minute window
    const key = rateLimitKey(companyId, channelId, window);

    const pipeline = redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, 65); // sedikit lebih dari 60s untuk keamanan
    const [count] = await pipeline.exec();

    if (count[1] > maxPerMinute) {
        const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);
        throw new RateLimitError(`Rate limit exceeded`, retryAfter);
    }

    return count[1]; // jumlah request dalam window ini
}


// ══════════════════════════════════════════════════════════════════════════════
// 4. WEBHOOK IDEMPOTENCY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * PROBLEM: Provider WhatsApp/LINE kadang mengirim webhook DUPLIKAT
 * (retry jika server kita lambat merespons, atau network issue).
 *
 * Jika tidak ditangani: satu pesan pelanggan masuk dua kali ke inbox.
 *
 * SOLUSI: Idempotency key per webhook event dengan TTL pendek.
 *
 * Key:   idempotent:webhook:{channel_type}:{provider_message_id}
 * Type:  STRING
 * TTL:   300 seconds (5 menit — cukup untuk deduplicate retry, tidak memakan memory)
 */
const webhookIdempotencyKey = (channelType, providerMsgId) =>
    `idempotent:webhook:${channelType}:${providerMsgId}`;

async function isWebhookDuplicate(redis, channelType, providerMsgId) {
    const key = webhookIdempotencyKey(channelType, providerMsgId);
    // SET NX EX: hanya set jika belum ada
    const result = await redis.set(key, '1', 'NX', 'EX', 300);
    return result === null; // null = key sudah ada = ini duplikat
}


// ══════════════════════════════════════════════════════════════════════════════
// 5. TYPING INDICATOR (Ephemeral)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Key:   typing:{company_id}:{conversation_id}:{sender_id}
 * Type:  STRING
 * TTL:   5 seconds (auto-expire jika frontend tidak kirim update lagi)
 *
 * Pub/Sub channel untuk broadcast ke Socket.io room.
 */
const typingKey = (companyId, convId, senderId) =>
    `typing:${companyId}:${convId}:${senderId}`;

// Redis Pub/Sub channel untuk realtime events ke Socket.io server:
// PUBLISH channel:events:{company_id} {JSON payload}
const realtimeChannel = (companyId) => `channel:events:${companyId}`;


// ══════════════════════════════════════════════════════════════════════════════
// 6. BROADCAST CAMPAIGN STATE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Progress tracking broadcast campaign (bisa jutaan recipient).
 *
 * Key:   broadcast:{company_id}:{campaign_id}:stats
 * Type:  HASH
 * TTL:   86400s (24 jam setelah campaign selesai)
 */
const broadcastStatsKey = (companyId, campaignId) =>
    `broadcast:${companyId}:${campaignId}:stats`;

// Fields: { total, sent, delivered, failed, pending }
// Di-update dengan HINCRBY setiap worker selesai proses satu batch


module.exports = {
    agentPresenceKey,
    agentWorkloadKey,
    agentSkillKey,
    conversationStateKey,
    conversationAssignLockKey,
    rateLimitKey,
    webhookIdempotencyKey,
    typingKey,
    realtimeChannel,
    broadcastStatsKey,
    acquireAssignmentLock,
    releaseAssignmentLock,
    checkAndIncrementRateLimit,
    isWebhookDuplicate,
};
