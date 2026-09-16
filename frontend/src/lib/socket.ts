import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) throw new Error('Socket not initialized. Call initSocket() first.');
  return socket;
}

export function initSocket(token: string): Socket {
  if (socket?.connected) return socket;

  socket = io(import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:3002', {
    auth:                    { token },
    reconnection:            true,
    reconnectionAttempts:    10,
    reconnectionDelay:       1000,
    reconnectionDelayMax:    30_000,
    timeout:                 20_000,
    transports:              ['websocket'],
  });

  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
