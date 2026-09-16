import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/**
 * Socket.io middleware — verifikasi JWT sebelum connection diterima.
 * Token diambil dari socket.handshake.auth.token (dikirim oleh frontend).
 */
export function socketAuthMiddleware(socket, next) {
  const token = socket.handshake.auth?.token;

  if (!token) {
    return next(new Error('UNAUTHORIZED'));
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });

    socket.data.agentId   = payload.sub;
    socket.data.companyId = payload.company_id;
    socket.data.role      = payload.role;
    socket.data.skillTags = payload.skill_tags ?? [];

    next();
  } catch (err) {
    // Token expired atau invalid
    next(new Error('UNAUTHORIZED'));
  }
}
