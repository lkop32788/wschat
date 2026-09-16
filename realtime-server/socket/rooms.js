/**
 * Konvensi penamaan room Socket.io.
 * HARUS konsisten antara server dan frontend client.
 */

/** Semua agen dalam satu company — broadcast inbox update, assignment */
export const companyRoom = (companyId) => `company:${companyId}`;

/** Satu conversation spesifik — new message, typing, status update */
export const conversationRoom = (conversationId) => `conv:${conversationId}`;

/** Personal room per agent — notifikasi yang hanya untuk satu agen */
export const agentRoom = (agentId) => `agent:${agentId}`;
