import { socketAuthMiddleware } from '../middleware/socketAuth.js';
import { registerConnectionHandler } from './handlers/connectionHandler.js';
import { registerMessagingHandler } from './handlers/messagingHandler.js';
import { registerPresenceHandler } from './handlers/presenceHandler.js';

/**
 * Setup Socket.io middleware dan event handlers.
 *
 * @param {import('socket.io').Server} io
 * @param {import('redis').RedisClientType} redis       General-purpose Redis client
 * @param {import('../../redis/subscriber.js').RedisEventSubscriber} subscriber
 * @param {import('pino').Logger} log
 */
export function setupSocketio(io, redis, subscriber, log) {
  // Auth middleware — dijalankan sebelum 'connection' event
  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    registerConnectionHandler(socket, io, redis, subscriber, log);
    registerMessagingHandler(socket, io, redis, log);
    registerPresenceHandler(socket, io, redis, log);
  });
}
