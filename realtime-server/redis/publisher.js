import axios from 'axios';
import { config } from '../config/index.js';

const laravelClient = axios.create({
  baseURL: config.laravel.internalUrl,
  timeout: 5000,
  headers: {
    'X-Internal-Key': config.laravel.apiKey,
    'Content-Type': 'application/json',
  },
});

/**
 * Kirim notifikasi offline ke Laravel agar konversasi dapat di-reassign.
 */
export async function notifyAgentOffline(companyId, agentId) {
  try {
    await laravelClient.post('/internal/agent/offline', { company_id: companyId, agent_id: agentId });
  } catch (err) {
    // Jangan throw — ini non-critical (Laravel punya TTL sendiri di Redis)
    console.error('[publisher] notifyAgentOffline failed:', err.message);
  }
}

/**
 * Ambil skill_tags agent dari Laravel untuk disimpan ke Redis skill sets.
 */
export async function fetchAgentSkills(agentId) {
  try {
    const { data } = await laravelClient.get(`/internal/agent/${agentId}/skills`);
    return data;
  } catch (err) {
    console.error('[publisher] fetchAgentSkills failed:', err.message);
    return { skill_tags: [], max_concurrent_chats: 5 };
  }
}
