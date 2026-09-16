# Phase 4B — Frontend Dashboard: Technical Specification
# Enterprise Omnichannel Platform
# Stack: React (atau Vue 3) + Tailwind CSS + Zustand (atau Pinia)
# Audience: AI coding assistant / developer

---

## OVERVIEW

Dashboard operasional untuk agen CS dan supervisor.
Tiga tampilan utama yang harus dibangun di Phase 4:

  1. Inbox (prioritas utama — ini core UI)
  2. Conversation Detail (panel chat)
  3. Agent Presence Sidebar

Broadcast Console, Analytics, dan Admin Panel masuk Phase 5.

---

## TECH STACK DECISIONS

```
Framework  : React 18+ (atau Vue 3 dengan Composition API)
Styling    : Tailwind CSS v3
State      : Zustand (React) / Pinia (Vue) — JANGAN Redux, terlalu verbose
Socket     : socket.io-client v4
HTTP       : axios dengan interceptor untuk auth token
Routing    : React Router v6 / Vue Router v4
Build      : Vite
Virtual scroll: @tanstack/react-virtual (React) / vue-virtual-scroller (Vue)
```

---

## 1. STRUKTUR STATE MANAGEMENT

### Prinsip desain store:

```
JANGAN taruh semua state dalam satu store monolitik.
Pisahkan berdasarkan domain:

├── useAuthStore         ← token, user info, login/logout
├── useInboxStore        ← conversation list, filter, sort
├── useConversationStore ← pesan dalam conversation yang aktif
├── usePresenceStore     ← status online semua agent
└── useSocketStore       ← socket instance, connection state
```

### `useAuthStore`

```typescript
interface AuthState {
  token: string | null;
  user: {
    id: string;
    name: string;
    role: 'agent' | 'supervisor' | 'admin';
    companyId: string;
    skillTags: string[];
    maxConcurrentChats: number;
  } | null;
  isAuthenticated: boolean;

  // Actions
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshToken: () => Promise<void>;
}
```

### `useInboxStore`

```typescript
interface ConversationSummary {
  id: string;
  contactName: string;
  contactAvatar: string | null;
  channelType: 'whatsapp' | 'line' | 'email' | 'telegram' | 'sms';
  lastMessagePreview: string;
  lastMessageAt: string;      // ISO string
  lastMessageDirection: 'inbound' | 'outbound';
  status: 'pending' | 'open' | 'snoozed' | 'resolved';
  unreadCount: number;
  assignedAgentId: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
}

interface InboxState {
  conversations: ConversationSummary[];
  activeFilter: 'mine' | 'all' | 'unassigned' | 'pending';
  searchQuery: string;
  isLoading: boolean;
  hasMore: boolean;
  cursor: string | null;    // untuk pagination cursor-based

  // Actions
  loadInitial: () => Promise<void>;
  loadMore: () => Promise<void>;
  applyFilter: (filter: string) => void;
  search: (query: string) => void;

  // Socket updates (dipanggil oleh socket handler)
  upsertConversation: (update: Partial<ConversationSummary>) => void;
  removeConversation: (id: string) => void;
  incrementUnread: (conversationId: string) => void;
}
```

**PENTING — `upsertConversation` logic:**
```
Ketika socket event 'inbox:update' datang:
1. Cari conversation di state berdasarkan id
2. FOUND  → update fields (preview, timestamp, unread) + re-sort list
3. NOT FOUND → insert di posisi pertama (conversation baru masuk)

Re-sort setelah update: by lastMessageAt DESC
Jangan re-fetch dari server — gunakan data dari socket event saja.
```

### `useConversationStore`

```typescript
interface Message {
  id: string;               // MongoDB _id
  tempId?: string;          // untuk optimistic UI
  conversationId: string;
  direction: 'inbound' | 'outbound';
  senderType: 'contact' | 'agent' | 'bot' | 'system';
  senderId: string;
  contentType: string;
  content: Record<string, any>;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  providerTimestamp: string;
  createdAt: string;
  quotedMessage?: Message | null;
}

interface ConversationState {
  activeConversationId: string | null;
  messages: Message[];
  isLoadingMessages: boolean;
  hasMoreMessages: boolean;      // untuk load history (scroll ke atas)
  oldestCursor: string | null;   // MongoDB _id paling lama yang sudah di-load
  typingAgents: string[];        // agentId yang sedang typing
  contactIsTyping: boolean;

  // Actions
  openConversation: (id: string) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  sendMessage: (content: object) => Promise<void>;

  // Socket updates
  appendMessage: (message: Message) => void;
  updateMessageStatus: (providerMsgId: string, status: string) => void;
  setTyping: (agentId: string, isTyping: boolean) => void;
}
```

### `usePresenceStore`

```typescript
interface AgentPresence {
  agentId: string;
  name: string;
  avatar: string | null;
  status: 'online' | 'offline' | 'busy' | 'away';
  activeChats: number;
}

interface PresenceState {
  agents: Record<string, AgentPresence>;   // key: agentId

  // Actions
  setOnline: (agentId: string) => void;
  setOffline: (agentId: string) => void;
  updateStatus: (agentId: string, status: string) => void;
}
```

---

## 2. SOCKET.IO CLIENT SETUP

### File: `lib/socket.ts`

```typescript
// Singleton socket instance
// Buat sekali, reuse di seluruh aplikasi

import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    throw new Error('Socket not initialized. Call initSocket() first.');
  }
  return socket;
}

export function initSocket(token: string): Socket {
  if (socket?.connected) {
    return socket;
  }

  socket = io(import.meta.env.VITE_SOCKET_URL, {
    auth: { token },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    timeout: 20000,
    transports: ['websocket'],   // skip long-polling, langsung WebSocket
  });

  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
```

### File: `lib/socketEventHandlers.ts`

Satu file yang mendaftarkan SEMUA socket event listener.
Dipanggil sekali setelah socket berhasil connect.

```typescript
export function registerSocketHandlers(socket: Socket, stores: Stores): void {

  // ── Inbox updates ───────────────────────────────────────────────────────
  socket.on('inbox:update', (data) => {
    stores.inbox.upsertConversation({
      id:                  data.conversationId,
      lastMessagePreview:  data.preview,
      lastMessageAt:       data.timestamp,
      lastMessageDirection: data.direction,
    });
    // Jika ini bukan conversation yang sedang dibuka, increment unread
    if (data.conversationId !== stores.conversation.activeConversationId) {
      stores.inbox.incrementUnread(data.conversationId);
    }
  });

  socket.on('inbox:assigned', (data) => {
    stores.inbox.upsertConversation({
      id:              data.conversationId,
      assignedAgentId: data.agentId,
    });
  });

  socket.on('inbox:resolved', (data) => {
    // Jika filter aktif = 'mine' atau 'open', hapus dari list
    if (['mine', 'open'].includes(stores.inbox.activeFilter)) {
      stores.inbox.removeConversation(data.conversationId);
    } else {
      stores.inbox.upsertConversation({ id: data.conversationId, status: 'resolved' });
    }
  });

  // ── Conversation detail ─────────────────────────────────────────────────
  socket.on('message:new', (data) => {
    if (data.conversationId !== stores.conversation.activeConversationId) return;
    stores.conversation.appendMessage(data);
    // Auto-scroll ke bawah jika user sedang di posisi bawah
    // Logic ini ada di komponen MessageList (cek scrollPosition)
  });

  socket.on('message:status', (data) => {
    stores.conversation.updateMessageStatus(data.messageId, data.status);
  });

  // ── Typing indicators ────────────────────────────────────────────────────
  socket.on('typing:start', (data) => {
    if (data.conversationId !== stores.conversation.activeConversationId) return;
    stores.conversation.setTyping(data.agentId, true);
  });

  socket.on('typing:stop', (data) => {
    stores.conversation.setTyping(data.agentId, false);
  });

  socket.on('contact:typing', (data) => {
    if (data.conversationId !== stores.conversation.activeConversationId) return;
    stores.conversation.contactIsTyping = true;
    // Auto-clear setelah 3 detik (TTL di Redis 5 detik, beri buffer)
    setTimeout(() => { stores.conversation.contactIsTyping = false; }, 3000);
  });

  // ── Presence ─────────────────────────────────────────────────────────────
  socket.on('agent:online',  (data) => stores.presence.setOnline(data.agentId));
  socket.on('agent:offline', (data) => stores.presence.setOffline(data.agentId));
  socket.on('agent:status',  (data) => stores.presence.updateStatus(data.agentId, data.status));

  // ── Personal notifications ───────────────────────────────────────────────
  socket.on('conversation:assigned', (data) => {
    // Conversation baru di-assign ke agent ini
    showToastNotification(`Percakapan baru: ${data.contactName}`);
    stores.inbox.upsertConversation(data);
    // Browser notification jika tab tidak fokus
    if (document.hidden) {
      showBrowserNotification('Percakapan baru masuk', data.contactName);
    }
  });

  // ── Connection lifecycle ─────────────────────────────────────────────────
  socket.on('connect', () => {
    console.info('[Socket] Connected:', socket.id);
    stores.socket.setConnected(true);
    // Re-join conversation room jika sedang buka conversation
    const activeId = stores.conversation.activeConversationId;
    if (activeId) {
      socket.emit('join:conversation', { conversationId: activeId });
    }
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected:', reason);
    stores.socket.setConnected(false);
    // Socket.io akan auto-reconnect jika reason bukan 'io client disconnect'
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'UNAUTHORIZED') {
      // Token expired — refresh dan reconnect
      stores.auth.refreshToken().then((newToken) => {
        socket.auth = { token: newToken };
        socket.connect();
      });
    }
  });

  // ── App-level heartbeat (beda dengan Socket.io ping) ───────────────────
  setInterval(() => {
    if (socket.connected) {
      socket.emit('heartbeat');
    }
  }, 30000);
}
```

---

## 3. INBOX COMPONENT

### Layout struktur:

```
┌─────────────────────────────────────────────────────────────────┐
│  TopBar: logo, search, agent status toggle, notif bell          │
├──────────────────────┬──────────────────────────────────────────┤
│  Left Panel (320px)  │  Right Panel (flex-1)                    │
│                      │                                          │
│  Filter tabs:        │  ConversationDetail (jika ada yang       │
│  Mine | All | Unassigned       aktif) atau EmptyState           │
│                      │                                          │
│  ConversationList    │                                          │
│  (virtual scroll)    │                                          │
│                      │                                          │
│  PresenceSidebar     │                                          │
│  (collapsed default) │                                          │
└──────────────────────┴──────────────────────────────────────────┘
```

### `ConversationList` component:

**WAJIB menggunakan virtual scroll.**
Tanpa virtual scroll, inbox dengan 500+ conversation akan freeze browser.

```typescript
// Menggunakan @tanstack/react-virtual
import { useVirtualizer } from '@tanstack/react-virtual';

const rowVirtualizer = useVirtualizer({
  count: conversations.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 80,     // estimasi tinggi per item (px)
  overscan: 10,               // render 10 item di luar viewport
});

// Infinite scroll: load more saat near bottom
const handleScroll = () => {
  const el = scrollRef.current;
  if (!el) return;
  const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 200;
  if (nearBottom && hasMore && !isLoading) {
    loadMore();
  }
};
```

### `ConversationItem` component (satu row di list):

Data yang ditampilkan:
```
[Avatar channel type icon]  [Contact Name]              [Timestamp]
                            [Last message preview]      [Unread badge]
                            [Channel badge] [Priority badge]
```

State visual per item:
```
- Active (currently open): background highlight
- Unread: bold contact name + unread count badge
- Assigned to me: normal
- Assigned to other: tampilkan nama agen dengan warna berbeda
- Pending (unassigned): border kiri berwarna kuning/warning
- High priority: border kiri merah
```

### Filter logic (CLIENT-SIDE setelah load):

```typescript
const filteredConversations = useMemo(() => {
  let result = conversations;

  switch (activeFilter) {
    case 'mine':
      result = result.filter(c => c.assignedAgentId === currentAgentId);
      break;
    case 'unassigned':
      result = result.filter(c => !c.assignedAgentId && c.status === 'pending');
      break;
    case 'all':
      // semua
      break;
  }

  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    result = result.filter(c =>
      c.contactName.toLowerCase().includes(q) ||
      c.lastMessagePreview.toLowerCase().includes(q)
    );
  }

  return result.sort((a, b) =>
    new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  );
}, [conversations, activeFilter, searchQuery, currentAgentId]);
```

---

## 4. CONVERSATION DETAIL COMPONENT

### Layout:

```
┌───────────────────────────────────────────┐
│  ConversationHeader                        │
│  Contact name, channel, status, assign btn │
├───────────────────────────────────────────┤
│                                            │
│  MessageList (flex-1, overflow-y scroll)   │
│  Virtual scroll dari bawah ke atas         │
│                                            │
│  TypingIndicator (tampil jika ada)         │
├───────────────────────────────────────────┤
│  MessageInput                              │
│  Textarea + media upload + send btn        │
└───────────────────────────────────────────┘
```

### Message loading pattern (PENTING):

```
1. Saat conversation dibuka:
   a. socket.emit('join:conversation', { conversationId })
   b. Fetch 30 pesan terbaru dari REST API:
      GET /api/conversations/{id}/messages?limit=30
   c. Render — scroll ke BAWAH (pesan terbaru)

2. Saat user scroll ke ATAS (load history):
   a. Simpan scroll position saat ini
   b. Fetch 30 pesan sebelumnya:
      GET /api/conversations/{id}/messages?before={oldestCursor}&limit=30
   c. Prepend ke message list
   d. Restore scroll position (jangan jump ke atas)

3. Saat pesan baru datang via socket:
   a. Append ke bawah
   b. Jika user sedang di posisi bawah (dalam 100px dari bottom) → auto-scroll
   c. Jika user sedang scroll ke atas (baca history) → tampilkan "X pesan baru" badge, jangan auto-scroll
```

### Scroll position detection:
```typescript
const isAtBottom = (): boolean => {
  const el = messageContainerRef.current;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
};
```

### `MessageBubble` component:

Render berbeda berdasarkan `contentType`:

```
text          → Bubble dengan teks, support markdown basic (bold, italic, link)
image         → Thumbnail clickable → open lightbox. Lazy load.
audio         → Custom audio player (play/pause, progress, durasi)
video         → Video player (HTML5 native atau react-player)
file          → Download card: icon + nama file + ukuran
location      → Embed Google Maps mini atau koordinat teks dengan link
sticker       → Image tanpa bubble background
button_reply  → Bubble teks dengan context "memilih: {button_text}"
list_reply    → Bubble teks dengan context "memilih: {item_title}"
email_html    → Collapsible HTML preview dalam iframe sandbox
system_event  → Centered text: "Dialihkan ke Budi • 10:30"
```

Direction styling:
```
inbound  (dari contact) → bubble kiri, warna abu/putih
outbound (dari agent)   → bubble kanan, warna primer brand
bot                     → bubble kiri, icon robot, warna berbeda
system                  → center, italic, no bubble
```

### Message status indicator (outbound only):

```
pending   → jam (clock icon) — belum dikirim
sent      → centang satu
delivered → centang dua abu-abu
read      → centang dua biru
failed    → X merah + retry button
```

### Optimistic UI untuk pengiriman pesan:

```typescript
async function sendMessage(content: object) {
  const tempId = `temp_${Date.now()}`;

  // 1. Langsung append ke state dengan status 'pending'
  appendMessage({
    id: tempId,
    tempId,
    direction: 'outbound',
    senderType: 'agent',
    status: 'pending',
    content,
    createdAt: new Date().toISOString(),
    // ... fields lain
  });

  // 2. Scroll ke bawah
  scrollToBottom();

  try {
    // 3. POST ke REST API
    const response = await api.post(
      `/conversations/${activeConversationId}/messages`,
      { content }
    );

    // 4. Replace tempId dengan real message dari server
    replaceMessage(tempId, response.data.message);

  } catch (error) {
    // 5. Update status jadi 'failed', tampilkan retry button
    updateMessageById(tempId, { status: 'failed' });
  }
}
```

### Typing indicator debounce (KRITIS untuk UX dan Redis):

```typescript
// Jangan kirim 'typing:start' setiap keystroke — terlalu banyak event
// Kirim sekali saat mulai ketik, kirim 'typing:stop' saat berhenti

let typingTimeout: NodeJS.Timeout | null = null;
let isCurrentlyTyping = false;

function handleInputChange(value: string) {
  setInputValue(value);

  if (!isCurrentlyTyping) {
    isCurrentlyTyping = true;
    socket.emit('typing:start', { conversationId: activeConversationId });
  }

  // Reset timer setiap keystroke
  if (typingTimeout) clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isCurrentlyTyping = false;
    socket.emit('typing:stop', { conversationId: activeConversationId });
  }, 2000);  // stop signal setelah 2 detik tidak ada keystroke
}

// Pastikan stop signal dikirim saat pesan terkirim
function handleSend() {
  if (typingTimeout) clearTimeout(typingTimeout);
  isCurrentlyTyping = false;
  socket.emit('typing:stop', { conversationId: activeConversationId });
  sendMessage(inputValue);
  setInputValue('');
}
```

---

## 5. CONVERSATION HEADER COMPONENT

Data yang ditampilkan:
```
- Nama contact + avatar
- Channel type badge (icon WA/LINE/Email + label)
- Status badge (Open / Pending / Snoozed)
- Assigned agent (nama + avatar kecil)
- Tombol: Resolve | Assign | Snooze | Transfer
```

### Tombol Resolve:
```
onClick:
1. Optimistic: update status di local state → 'resolved'
2. POST /api/conversations/{id}/resolve
3. Error → rollback status
4. Socket broadcast akan datang dari server — idempotent jika sudah diupdate
```

### Tombol Transfer (ke agent lain):
```
onClick:
1. Buka modal: dropdown list agent yang online
   Data dari usePresenceStore.agents (filter status = 'online')
2. Pilih agent → POST /api/conversations/{id}/assign { agent_id }
3. Update assignedAgentId di inbox store
```

---

## 6. REST API ENDPOINTS YANG DIBUTUHKAN FRONTEND

Frontend memanggil endpoint ini via axios. Semua harus ada di Laravel Core API.

```
Auth:
  POST   /api/auth/login
  POST   /api/auth/logout
  POST   /api/auth/refresh

Inbox:
  GET    /api/conversations
         ?filter=mine|all|unassigned|pending
         &cursor={id}
         &limit=30
         Response: { data: ConversationSummary[], next_cursor, has_more }

Conversation:
  GET    /api/conversations/{id}
         Response: ConversationDetail (header + contact info)

  GET    /api/conversations/{id}/messages
         ?limit=30&before={mongodb_id}
         Response: { data: Message[], has_more }

  POST   /api/conversations/{id}/messages
         Body: { content_type, content }
         Response: { message: Message }

  POST   /api/conversations/{id}/resolve
  POST   /api/conversations/{id}/reopen
  POST   /api/conversations/{id}/assign   Body: { agent_id }
  POST   /api/conversations/{id}/snooze   Body: { until: ISO timestamp }

Contacts:
  GET    /api/contacts/{id}
  PATCH  /api/contacts/{id}

Agents (untuk transfer dropdown):
  GET    /api/agents?status=online
```

### Pagination strategy:

Gunakan **cursor-based pagination** (bukan offset).
Alasannya: conversation list berubah real-time. Offset-based akan
menghasilkan duplicate/skip item saat ada conversation baru masuk
di antara halaman yang sedang dibaca.

```
Request pertama : GET /api/conversations?limit=30
Response        : { data: [...], next_cursor: "conv-id-ke-30", has_more: true }
Request berikut : GET /api/conversations?cursor=conv-id-ke-30&limit=30
```

---

## 7. NOTIFICATION SYSTEM

### Toast notification:
- Tampil untuk: pesan baru masuk di conversation yang sedang dibuka,
  assignment baru, resolusi oleh agent lain
- Auto-dismiss setelah 4 detik
- Maksimal 3 toast sekaligus (stack ke atas)
- Gunakan library: `react-hot-toast` atau `sonner`

### Unread badge:
- Favicon badge (gunakan `favico.js` atau canvas manipulation)
- Update jumlah total unread di browser tab title: `(3) Inbox — Platform`
- Reset saat tab menjadi fokus dan conversation yang unread dibuka

### Browser notification (Web Push):
```typescript
// Minta permission saat login
if (Notification.permission === 'default') {
  await Notification.requestPermission();
}

// Tampilkan saat tab tidak fokus
function showBrowserNotification(title: string, body: string) {
  if (document.hidden && Notification.permission === 'granted') {
    new Notification(title, {
      body,
      icon: '/icons/notification-icon.png',
    });
  }
}
```

---

## 8. PERFORMANCE CHECKLIST

- [ ] Virtual scroll di ConversationList (>100 items tidak boleh lag)
- [ ] Virtual scroll di MessageList untuk conversation dengan >200 pesan
- [ ] Image lazy loading dengan Intersection Observer
- [ ] Debounce typing indicator (max 1 event per 2 detik, bukan per keystroke)
- [ ] Search di inbox: debounce 300ms sebelum filter
- [ ] Semua socket listener harus di-cleanup saat component unmount
- [ ] Socket connection hanya dibuat sekali (singleton), bukan per component
- [ ] useMemo/useCallback untuk filteredConversations agar tidak re-compute setiap render

---

## 9. CATATAN PENTING UNTUK AI IMPLEMENTOR

1. **Scroll management di MessageList adalah bagian paling tricky.**
   Saat prepend history (scroll ke atas), harus restore scroll position
   agar user tidak tiba-tiba jump. Gunakan:
   ```typescript
   const scrollHeight = el.scrollHeight;
   // ... prepend messages ...
   el.scrollTop += el.scrollHeight - scrollHeight;
   ```

2. **Jangan store socket instance di React state atau Zustand state.**
   Socket adalah mutable object — menaruhnya di state akan trigger
   re-render yang tidak perlu. Gunakan ref atau module-level singleton.

3. **Optimistic UI harus punya rollback yang jelas.**
   Setiap action yang optimistic (kirim pesan, resolve, assign) harus
   punya handler error yang mengembalikan state ke kondisi sebelumnya.

4. **Token refresh dan socket reconnect harus dikoordinasikan.**
   Jika JWT expire, urutan yang benar:
   a. Refresh token via REST API
   b. Update axios default header
   c. Update socket.auth.token
   d. socket.disconnect() lalu socket.connect()
   Jangan hanya update satu tanpa yang lain.

5. **Company isolation di frontend.**
   Setelah login, semua request harus otomatis menyertakan company context.
   Taruh company_id di axios request interceptor sebagai header:
   `X-Company-ID: {companyId}`
   Backend akan double-check ini dengan JWT payload.
```
