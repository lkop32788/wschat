# Phase 4A — Realtime Server (Node.js + Socket.io): Technical Specification
# Enterprise Omnichannel Platform
# Audience: AI coding assistant / developer

---

## OVERVIEW & TANGGUNG JAWAB

Realtime Server adalah jembatan antara backend (Laravel + Redis) dan
browser agen. Tugasnya HANYA distribusi event — tidak ada business logic
di sini. Kalau ada logika yang tergoda untuk ditaruh di sini, taruh di
Laravel (Phase 3).

Tanggung jawab eksplisit:
  1. Maintain WebSocket connections ke semua browser agen yang aktif
  2. Subscribe ke Redis channel:events:{company_id} dari Laravel
  3. Forward event Redis ke Socket.io room yang tepat
  4. Handle presence: catat online/offline, kirim heartbeat ke Laravel
  5. Handle typing indicator (broadcast ke room tanpa menyentuh DB)
  6. Enforce company isolation — agent company A tidak boleh terima event company B

---

## STRUKTUR FILE

```
realtime-server/
├── server.js                     ← entry point
├── socket/
│   ├── index.js                  ← Socket.io setup & middleware
│   ├── handlers/
│   │   ├── connectionHandler.js  ← on connect / disconnect
│   │   ├── messagingHandler.js   ← typing, read receipt events
│   │   └── presenceHandler.js    ← heartbeat, status change
│   └── rooms.js                  ← room naming conventions
├── redis/
│   ├── subscriber.js             ← subscribe channel:events:* dari Laravel
│   └── publisher.js             ← kirim heartbeat ke Laravel internal API
├── middleware/
│   └── socketAuth.js             ← JWT verification untuk Socket.io
├── config/
│   └── index.js
└── package.json
```

---

## 1. ENTRY POINT: `server.js`

### Dependencies yang diperlukan:
```json
{
  "socket.io": "^4.7.x",
  "redis": "^4.7.x",
  "jsonwebtoken": "^9.x",
  "axios": "^1.x",
  "pino": "^9.x"
}
```

### Bootstrap sequence (urutan WAJIB):
```
1. Buat HTTP server (Node http.createServer)
2. Attach Socket.io ke HTTP server
3. Connect ke Redis (dua client: subscriber + publisher)
   PENTING: Redis subscriber HARUS dedicated client tersendiri.
   Client yang sedang dalam mode subscribe tidak bisa digunakan
   untuk operasi Redis lain (SET, GET, dll).
4. Setup Redis subscriber (listen events dari Laravel)
5. Setup Socket.io middleware (auth)
6. Register Socket.io event handlers
7. Start HTTP server listen
```

### Graceful shutdown (WAJIB):
```javascript
process.on('SIGTERM', async () => {
  // 1. Stop menerima koneksi baru
  io.close();
  // 2. Disconnect semua client dengan pesan
  // 3. Close Redis connections
  // 4. Exit
});
```

---

## 2. SOCKET.IO SETUP & ROOM MANAGEMENT

### File: `socket/rooms.js`

#### Konvensi penamaan room (KRITIS — harus konsisten dengan frontend):

```javascript
// Room untuk semua agen dalam satu company
// Digunakan untuk broadcast: conversation baru, agent assignment
const companyRoom = (companyId) => `company:${companyId}`;

// Room untuk satu conversation spesifik
// Digunakan untuk: new message, typing indicator, status update
const conversationRoom = (conversationId) => `conv:${conversationId}`;

// Room personal per agent
// Digunakan untuk: notifikasi yang hanya untuk satu agen
const agentRoom = (agentId) => `agent:${agentId}`;
```

#### Join room rules (ditentukan oleh role):

```
Role: agent
  → Join companyRoom(companyId)                  ← semua event company
  → Join agentRoom(agentId)                      ← event personal

Role: supervisor / admin
  → Join companyRoom(companyId)                  ← semua event company
  → Join agentRoom(agentId)                      ← event personal
  → Join conversationRoom(*) semua conversation  ← bisa monitor semua

Saat agent membuka sebuah conversation di UI:
  → Client emit 'join:conversation', { conversationId }
  → Server join socket ke conversationRoom(conversationId)

Saat agent menutup conversation tab / pindah conversation:
  → Client emit 'leave:conversation', { conversationId }
  → Server leave socket dari conversationRoom(conversationId)
```

---

## 3. AUTH MIDDLEWARE: `middleware/socketAuth.js`

Socket.io mendukung middleware yang dijalankan sebelum `connection` event.
Gunakan ini untuk verifikasi JWT.

### Alur:

```
1. Ambil token dari socket.handshake.auth.token
   (frontend kirim saat io({ auth: { token } }))

2. Verify JWT dengan APP_JWT_SECRET
   → Invalid / expired: next(new Error('UNAUTHORIZED'))
     Client akan terima error dan disconnect

3. Decode payload JWT:
   {
     sub: agent_id,
     company_id: uuid,
     role: 'agent' | 'supervisor' | 'admin',
     exp: unix_timestamp
   }

4. Simpan ke socket.data:
   socket.data.agentId    = payload.sub
   socket.data.companyId  = payload.company_id
   socket.data.role       = payload.role

5. next() — lanjutkan ke connection handler
```

### PENTING — Token refresh:
JWT mungkin expire saat agent masih aktif (misal: expire 1 jam).
Frontend harus mengirim token baru sebelum expire via:
```
socket.emit('auth:refresh', { token: newToken })
```
Server update `socket.data` dengan payload baru.
Jika token tidak di-refresh dan expire, disconnect socket.

---

## 4. CONNECTION HANDLER: `socket/handlers/connectionHandler.js`

### Event: `connection` (built-in Socket.io)

```
Saat agent connect:

1. Ambil { agentId, companyId, role } dari socket.data

2. Join rooms sesuai role (lihat Section 2)

3. Simpan socket.id ke Redis:
   HSET agent:presence:{companyId}:{agentId}
     status         "online"
     socket_id      socket.id
     connected_at   unix_timestamp
     last_heartbeat unix_timestamp
   EXPIRE agent:presence:{companyId}:{agentId} 300

4. Tambahkan ke workload sorted set jika belum ada:
   ZADD agent:workload:{companyId} NX 0 {agentId}

5. Tambahkan ke skill sets:
   Ambil skill_tags dari cache atau query Laravel internal API:
   GET /internal/agent/{agentId}/skills
   Untuk setiap skill:
     SADD agent:skill:{companyId}:{skill} {agentId}
     EXPIRE agent:skill:{companyId}:{skill} 300

6. Notify agen lain di company (untuk presence list di UI):
   io.to(companyRoom(companyId)).emit('agent:online', {
     agentId,
     timestamp: Date.now()
   })

7. Subscribe ke Redis channel company ini (jika belum ada subscriber):
   Lihat Section 6 — Redis Subscriber

8. Kirim initial state ke agent yang baru connect:
   socket.emit('init:state', {
     onlineAgents: [...],   ← ambil dari Redis SCAN agent:presence:{companyId}:*
     myConversations: [...] ← fetch dari Laravel API
   })
```

### Event: `disconnect` (built-in Socket.io)

```
Saat agent disconnect:

1. DEL agent:presence:{companyId}:{agentId}

2. Hapus dari semua skill sets:
   Gunakan SREM untuk setiap skill yang diketahui

3. Notify agen lain:
   io.to(companyRoom(companyId)).emit('agent:offline', { agentId })

4. Kirim notif ke Laravel untuk handle re-assignment:
   POST /internal/agent/offline
   Body: { company_id, agent_id }

5. JANGAN hapus dari workload sorted set
   (agen mungkin reconnect — biarkan score tetap ada)

CATATAN: Jangan langsung mark offline jika disconnect terjadi.
Tunggu 10 detik — bisa jadi network blip sesaat.
Gunakan setTimeout dengan cancel jika agent reconnect dalam 10 detik.
```

---

## 5. MESSAGING HANDLER: `socket/handlers/messagingHandler.js`

### Event yang di-listen dari CLIENT:

#### `typing:start`
```
Client emit: { conversationId }

Server:
1. Validasi: apakah agent ini memang di-assign ke conversationId?
   Cek Redis conv:state:{companyId}:{conversationId}.assigned_agent_id === agentId
   Jika tidak match dan bukan supervisor/admin → ignore

2. Set Redis key:
   SET typing:{companyId}:{conversationId}:{agentId} "1" EX 5

3. Broadcast ke conversation room (kecuali pengirim):
   io.to(conversationRoom(conversationId)).except(socket.id)
     .emit('typing:start', { agentId, conversationId })
```

#### `typing:stop`
```
Client emit: { conversationId }

Server:
1. DEL typing:{companyId}:{conversationId}:{agentId}

2. Broadcast ke conversation room:
   io.to(conversationRoom(conversationId)).except(socket.id)
     .emit('typing:stop', { agentId, conversationId })
```

#### `message:read`
```
Client emit: { conversationId, lastReadMessageId }

Server:
1. Publish ke Redis untuk diproses Laravel:
   PUBLISH dispatcher:requests JSON.stringify({
     action: 'MARK_READ',
     company_id: companyId,
     conversation_id: conversationId,
     agent_id: agentId,
     last_read_message_id: lastReadMessageId
   })
   (Laravel akan UPDATE conversations.unread_count = 0)

2. Broadcast ke conversation room (untuk sinkronisasi multi-tab):
   io.to(conversationRoom(conversationId))
     .emit('message:read', { agentId, conversationId, lastReadMessageId })
```

#### `join:conversation`
```
Client emit: { conversationId }

Server:
1. Validasi company ownership:
   Cek Redis conv:state:{companyId}:{conversationId}
   Jika company_id tidak match → ignore (security)

2. socket.join(conversationRoom(conversationId))

3. Acknowledge: socket.emit('joined:conversation', { conversationId })
```

#### `leave:conversation`
```
Client emit: { conversationId }
Server: socket.leave(conversationRoom(conversationId))
```

---

## 6. REDIS SUBSCRIBER: `redis/subscriber.js`

### ARSITEKTUR KRITIS

Laravel mempublish event ke channel `channel:events:{company_id}`.
Realtime Server subscribe, lalu forward ke Socket.io room yang tepat.

### Satu subscriber per company (bukan per socket):

```
Problem: Jika subscribe per-socket, dengan 100 agen online di 10 company,
         kita butuh 100 Redis subscriptions untuk channel yang sama.
         Redis SUBSCRIBE tidak mahal, tapi ini tidak efisien.

Solusi:  Satu Redis subscriber per company_id yang aktif.
         Map: activeSubscriptions = new Map<companyId, boolean>()

         Saat agent pertama dari company X connect:
           → subscribe ke channel:events:{companyId}
           → activeSubscriptions.set(companyId, true)

         Saat semua agent dari company X disconnect:
           → unsubscribe dari channel:events:{companyId}
           → activeSubscriptions.delete(companyId)
```

### Event routing dari Redis ke Socket.io room:

```javascript
// Saat menerima message dari Redis channel
subscriber.on('message', (channel, message) => {
  const companyId = channel.replace('channel:events:', '');
  const event = JSON.parse(message);

  switch (event.type) {

    case 'NEW_MESSAGE':
      // → Ke conversation room (agen yang sedang buka conversation itu)
      io.to(conversationRoom(event.payload.conversation_id))
        .emit('message:new', event.payload);

      // → Ke company room (untuk update preview di inbox list)
      io.to(companyRoom(companyId))
        .emit('inbox:update', {
          conversationId:   event.payload.conversation_id,
          preview:          event.payload.preview,
          direction:        event.payload.direction,
          timestamp:        event.payload.timestamp,
          unreadIncrement:  1
        });
      break;

    case 'CONVERSATION_ASSIGNED':
      // → Ke agent room spesifik (notifikasi personal)
      io.to(agentRoom(event.payload.agent_id))
        .emit('conversation:assigned', event.payload);

      // → Ke company room (update assignee di inbox list)
      io.to(companyRoom(companyId))
        .emit('inbox:assigned', event.payload);
      break;

    case 'CONVERSATION_RESOLVED':
      io.to(companyRoom(companyId))
        .emit('inbox:resolved', { conversationId: event.payload.conversation_id });

      io.to(conversationRoom(event.payload.conversation_id))
        .emit('conversation:resolved', event.payload);
      break;

    case 'CONVERSATION_REOPENED':
      io.to(companyRoom(companyId))
        .emit('inbox:reopened', event.payload);
      break;

    case 'MESSAGE_STATUS_UPDATE':
      // delivered / read dari provider
      io.to(conversationRoom(event.payload.conversation_id))
        .emit('message:status', {
          messageId: event.payload.provider_message_id,
          status:    event.payload.status
        });
      break;

    case 'AGENT_TYPING':
      // Dari pelanggan (via bot/channel) yang sedang ketik — jarang tapi ada
      io.to(conversationRoom(event.payload.conversation_id))
        .emit('contact:typing', event.payload);
      break;
  }
});
```

---

## 7. PRESENCE HANDLER: `socket/handlers/presenceHandler.js`

### Heartbeat mechanism:

```
Frontend mengirim heartbeat setiap 30 detik:
  socket.emit('heartbeat')

Server merespons:
  1. HSET agent:presence:{companyId}:{agentId} last_heartbeat {now}
  2. EXPIRE agent:presence:{companyId}:{agentId} 300  ← reset TTL
  3. Refresh semua skill set TTL:
     Untuk setiap skill agent:
       EXPIRE agent:skill:{companyId}:{skill} 300
  4. socket.emit('heartbeat:ack')
```

### Status change (agent ganti status manual):
```
Client emit: 'presence:update', { status: 'busy' | 'away' | 'online' }

Server:
1. Validasi: status harus salah satu dari nilai yang valid
2. HSET agent:presence:{companyId}:{agentId} status {newStatus}
3. Broadcast ke company room:
   io.to(companyRoom(companyId)).emit('agent:status', { agentId, status: newStatus })
4. Jika status = 'busy' atau 'away':
   Hapus dari skill sets (agar Dispatcher tidak assign ke agent ini)
   SREM agent:skill:{companyId}:* {agentId}
5. Jika status = 'online':
   Tambah kembali ke skill sets
```

---

## 8. ENVIRONMENT VARIABLES

```env
PORT=3002
NODE_ENV=production

# Redis (HARUS dua connection terpisah)
REDIS_URL=redis://localhost:6379

# JWT (SAMA dengan yang digunakan Laravel)
JWT_SECRET=sama-persis-dengan-APP_JWT_SECRET-di-laravel

# Laravel Internal API
LARAVEL_INTERNAL_URL=http://localhost:8000
INTERNAL_API_KEY=sama-persis-dengan-INTERNAL_API_KEY-di-laravel

# Socket.io CORS
ALLOWED_ORIGINS=http://localhost:5173,https://app.yourdomain.com

LOG_LEVEL=info
```

---

## 9. SOCKET.IO SERVER CONFIG (PENTING)

```javascript
const io = new Server(httpServer, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS.split(','),
    credentials: true
  },
  // Heartbeat dari Socket.io sendiri (berbeda dengan app heartbeat)
  pingTimeout: 60000,    // 60 detik sebelum disconnect jika tidak ada ping
  pingInterval: 25000,   // ping setiap 25 detik

  // Adapter untuk multi-instance scaling (WAJIB jika deploy >1 instance)
  // adapter: createAdapter(pubClient, subClient)  ← socket.io-redis-adapter
  // Tanpa ini, agent di instance A tidak bisa terima event untuk agent di instance B
});
```

### Scaling note:
Jika deploy lebih dari 1 instance Realtime Server (load balanced),
WAJIB pasang `@socket.io/redis-adapter`:
```
npm install @socket.io/redis-adapter
```
Tanpa adapter ini, `io.to(room).emit()` hanya broadcast ke socket
yang terkoneksi di instance tersebut — agent di instance lain tidak terima.

---

## 10. TESTING CHECKLIST

- [ ] Agent connect → muncul online di Redis, agen lain terima `agent:online`
- [ ] Agent disconnect → muncul offline di Redis setelah 10 detik, agen lain terima `agent:offline`
- [ ] Laravel publish NEW_MESSAGE → agen yang buka conversation terima `message:new`
- [ ] Laravel publish NEW_MESSAGE → semua agen company terima `inbox:update`
- [ ] Agent emit typing → agen lain di conversation room terima, bukan pengirim sendiri
- [ ] Typing auto-stop setelah 5 detik (Redis TTL expire, tidak ada `typing:stop` eksplisit)
- [ ] Agent dari company A tidak menerima event company B (room isolation)
- [ ] JWT expired → socket disconnect, tidak bisa reconnect tanpa token baru
- [ ] Deploy 2 instance + redis-adapter → agent di instance berbeda tetap terima event
