import { companyRoom } from '../rooms.js';
import { config } from '../../config/index.js';

const VALID_STATUSES = new Set(['online', 'busy', 'away']);

/**
 * Handle heartbeat dan perubahan status manual dari agen.
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 * @param {import('redis').RedisClientType} redis
 * @param {import('pino').Logger} log
 */
export function registerPresenceHandler(socket, io, redis, log) {
  const { agentId, companyId } = socket.data;

  // ── heartbeat ─────────────────────────────────────────────────────────────
  socket.on('heartbeat', async () => {
    const presenceKey = `agent:presence:${companyId}:${agentId}`;

    try {
      await redis.hSet(presenceKey, 'last_heartbeat', Date.now().toString());
      await redis.expire(presenceKey, config.presenceTtl);

      // Refresh TTL semua skill sets milik agent ini
      const skills = socket.data.skillTags ?? [];
      await Promise.all(skills.map(
        (skill) => redis.expire(`agent:skill:${companyId}:${skill}`, config.presenceTtl)
      ));

      socket.emit('heartbeat:ack');
    } catch (err) {
      log.error({ agentId, err }, 'Heartbeat error');
    }
  });

  // ── presence:update ───────────────────────────────────────────────────────
  socket.on('presence:update', async ({ status } = {}) => {
    if (!VALID_STATUSES.has(status)) return;

    const presenceKey = `agent:presence:${companyId}:${agentId}`;

    try {
      await redis.hSet(presenceKey, 'status', status);

      // Jika busy/away → hapus dari skill sets agar Dispatcher tidak assign
      if (status === 'busy' || status === 'away') {
        const skills = socket.data.skillTags ?? [];
        await Promise.all(skills.map(
          (skill) => redis.sRem(`agent:skill:${companyId}:${skill}`, agentId)
        ));
      }

      // Jika online → tambah kembali ke skill sets
      if (status === 'online') {
        const skills = socket.data.skillTags ?? [];
        await Promise.all(skills.map(async (skill) => {
          const key = `agent:skill:${companyId}:${skill}`;
          await redis.sAdd(key, agentId);
          await redis.expire(key, config.presenceTtl);
        }));
      }

      // Broadcast ke semua agen di company
      io.to(companyRoom(companyId)).emit('agent:status', { agentId, status });

      log.debug({ agentId, status }, 'Presence updated');
    } catch (err) {
      log.error({ agentId, err }, 'Presence update error');
    }
  });
}
