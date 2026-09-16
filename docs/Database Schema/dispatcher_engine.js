/**
 * Dispatcher Engine — Core Routing Algorithm
 *
 * Skill-Based Routing + Least-Active Load Balancing
 *
 * Algoritma 3 tahap:
 * 1. FILTER:    Cari agent online dengan skill yang cocok (Redis SINTER)
 * 2. QUALIFY:   Exclude agent yang sudah full (max_concurrent_chats)
 * 3. TIE-BREAK: Pilih agent dengan active_chats paling rendah (ZRANGEBYSCORE)
 *
 * RACE CONDITION PREVENTION: Distributed lock sebelum ZINCRBY
 * Tanpa lock: dua worker bisa simultaneously assign ke agent yang sama
 * karena keduanya membaca workload=2 sebelum salah satu increment.
 */

const redis = require('./redis_client');
const { v4: uuid } = require('uuid');
const {
    agentSkillKey,
    agentWorkloadKey,
    agentPresenceKey,
    conversationStateKey,
    conversationAssignLockKey,
    acquireAssignmentLock,
    releaseAssignmentLock,
} = require('./redis_key_design');

class DispatcherEngine {

    /**
     * Entry point: assign conversation ke agent yang tepat.
     *
     * @param {string} companyId
     * @param {string} conversationId
     * @param {string[]} intentTags  - ['billing', 'complaint']
     * @returns {string|null} agentId yang di-assign, atau null jika tidak ada yang tersedia
     */
    async dispatch(companyId, conversationId, intentTags = []) {
        const workerId = uuid(); // identitas worker ini untuk lock ownership

        // Prevent concurrent dispatch untuk conversation yang sama
        const lockAcquired = await acquireAssignmentLock(redis, conversationId, workerId);
        if (!lockAcquired) {
            // Worker lain sedang handle conversation ini — skip
            console.warn(`[Dispatcher] Lock not acquired for conv ${conversationId}, skipping`);
            return null;
        }

        try {
            // STEP 1: Cari agent kandidat berdasarkan skill
            const candidateAgentIds = await this._findAgentsBySkill(companyId, intentTags);

            if (candidateAgentIds.length === 0) {
                // Tidak ada agent dengan skill yang cocok
                // Fallback: cari agent dengan skill "general"
                const generalAgents = await this._findAgentsBySkill(companyId, ['general']);
                if (generalAgents.length === 0) {
                    await this._markConversationAsWaiting(companyId, conversationId);
                    return null;
                }
                candidateAgentIds.push(...generalAgents);
            }

            // STEP 2: Filter agent yang online & belum full
            const availableAgents = await this._filterAvailableAgents(
                companyId,
                candidateAgentIds
            );

            if (availableAgents.length === 0) {
                await this._markConversationAsWaiting(companyId, conversationId);
                return null;
            }

            // STEP 3: Pilih agent dengan workload terendah
            const selectedAgentId = await this._selectLeastActiveAgent(
                companyId,
                availableAgents
            );

            // Assign: update Redis workload + conversation state secara atomic
            await this._assignConversation(companyId, conversationId, selectedAgentId);

            return selectedAgentId;

        } finally {
            // SELALU release lock, bahkan jika terjadi error
            await releaseAssignmentLock(redis, conversationId, workerId);
        }
    }

    /**
     * STEP 1: Cari agent yang memiliki semua required skills menggunakan Redis SINTER.
     *
     * SINTER melakukan intersection of multiple SETs secara atomic di Redis.
     * Jauh lebih efisien dari loop aplikasi.
     *
     * Contoh: intentTags = ['billing', 'indonesian']
     * SINTER agent:skill:{cid}:billing agent:skill:{cid}:indonesian
     * → Agent yang punya KEDUA skill tersebut
     */
    async _findAgentsBySkill(companyId, intentTags) {
        if (!intentTags || intentTags.length === 0) {
            // Tidak ada skill requirement — semua agent eligible
            // Gunakan special "general" set yang berisi semua active agents
            return this._getAllActiveAgents(companyId);
        }

        const skillKeys = intentTags.map(tag => agentSkillKey(companyId, tag));

        // Jika hanya satu skill, SMEMBERS lebih sederhana dari SINTER dengan 1 key
        if (skillKeys.length === 1) {
            return redis.smembers(skillKeys[0]);
        }

        return redis.sinter(...skillKeys);
    }

    /**
     * STEP 2: Filter dari kandidat — hanya yang online dan belum mencapai max load.
     *
     * PROBLEM: max_concurrent_chats berbeda per agent (dari SQL), tapi Redis hanya
     * menyimpan current workload. Solusi: cache max_concurrent_chats di Redis hash
     * saat agent login.
     */
    async _filterAvailableAgents(companyId, candidateIds) {
        if (candidateIds.length === 0) return [];

        const available = [];

        // Pipeline semua HGETALL sekaligus — satu round-trip ke Redis
        const pipeline = redis.pipeline();
        for (const agentId of candidateIds) {
            pipeline.hgetall(agentPresenceKey(companyId, agentId));
        }
        const results = await pipeline.exec();

        // Ambil workload untuk semua kandidat dalam satu ZMSCORE
        const workloads = await redis.zmscore(
            agentWorkloadKey(companyId),
            ...candidateIds
        );

        candidateIds.forEach((agentId, idx) => {
            const presence = results[idx][1]; // [error, value] dari pipeline
            if (!presence || presence.status !== 'online') return;

            const currentLoad = parseInt(workloads[idx] || '0');
            const maxLoad = parseInt(presence.max_concurrent_chats || '5');

            if (currentLoad < maxLoad) {
                available.push({ agentId, currentLoad, maxLoad });
            }
        });

        return available;
    }

    /**
     * STEP 3: Pilih agent dengan active_chats paling rendah.
     *
     * Karena kita sudah dapat currentLoad dari step 2, tinggal sort.
     * Tidak perlu query Redis lagi — hindari extra round-trip.
     *
     * TIE-BREAKING (load sama): pilih secara random untuk distribusi merata.
     */
    async _selectLeastActiveAgent(companyId, availableAgents) {
        // Sort by currentLoad ascending
        availableAgents.sort((a, b) => a.currentLoad - b.currentLoad);

        const minLoad = availableAgents[0].currentLoad;
        const tiedAgents = availableAgents.filter(a => a.currentLoad === minLoad);

        // Random tie-break
        const selected = tiedAgents[Math.floor(Math.random() * tiedAgents.length)];
        return selected.agentId;
    }

    /**
     * Atomic assignment: increment workload + update conversation state.
     *
     * Gunakan pipeline untuk atomicity — kedua operasi dikirim sekaligus.
     * Bukan 100% atomic seperti Lua script, tapi acceptable karena kita
     * sudah protect dengan distributed lock di layer atas.
     */
    async _assignConversation(companyId, conversationId, agentId) {
        const pipeline = redis.pipeline();

        // Increment agent workload
        pipeline.zincrby(agentWorkloadKey(companyId), 1, agentId);

        // Update conversation state
        pipeline.hset(conversationStateKey(companyId, conversationId), {
            status: 'open',
            assigned_agent_id: agentId,
            last_activity: Math.floor(Date.now() / 1000).toString(),
        });
        pipeline.expire(conversationStateKey(companyId, conversationId), 3600);

        await pipeline.exec();

        // Publish event ke realtime server untuk push notif ke agent
        await redis.publish(
            `channel:events:${companyId}`,
            JSON.stringify({
                type: 'CONVERSATION_ASSIGNED',
                payload: { conversationId, agentId, companyId }
            })
        );
    }

    async _markConversationAsWaiting(companyId, conversationId) {
        await redis.hset(conversationStateKey(companyId, conversationId), {
            status: 'pending',
            assigned_agent_id: '',
            last_activity: Math.floor(Date.now() / 1000).toString(),
        });
        await redis.expire(conversationStateKey(companyId, conversationId), 3600);
    }

    async _getAllActiveAgents(companyId) {
        return redis.smembers(agentSkillKey(companyId, 'general'));
    }

    /**
     * Dipanggil saat conversation resolved/closed.
     * Kurangi workload agent yang di-assign.
     */
    async releaseConversation(companyId, conversationId, agentId) {
        const pipeline = redis.pipeline();

        pipeline.zincrby(agentWorkloadKey(companyId), -1, agentId);

        // Pastikan score tidak negatif (guard)
        pipeline.zscore(agentWorkloadKey(companyId), agentId);

        const results = await pipeline.exec();
        const newScore = parseFloat(results[1][1] || '0');

        if (newScore < 0) {
            await redis.zadd(agentWorkloadKey(companyId), 0, agentId);
        }
    }
}

module.exports = new DispatcherEngine();
