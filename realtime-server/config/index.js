export const config = {
  port:      parseInt(process.env.PORT ?? '3002', 10),
  nodeEnv:   process.env.NODE_ENV ?? 'development',

  redis: {
    url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  },

  jwt: {
    secret: process.env.APP_JWT_SECRET ?? '',
  },

  laravel: {
    internalUrl: process.env.LARAVEL_INTERNAL_URL ?? 'http://localhost:8000',
    apiKey:      process.env.INTERNAL_API_KEY ?? '',
  },

  cors: {
    origins: (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map(s => s.trim()),
  },

  log: {
    level: process.env.LOG_LEVEL ?? 'info',
  },

  // Socket.io heartbeat
  socket: {
    pingTimeout:  60_000,
    pingInterval: 25_000,
  },

  // Agent presence TTL di Redis (detik)
  presenceTtl: 300,

  // Delay sebelum mark offline setelah disconnect (ms)
  offlineGracePeriod: 10_000,
};
