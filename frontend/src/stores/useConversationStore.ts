import { create } from 'zustand';
import api from '../lib/api';
import { getSocket } from '../lib/socket';
import type { Message, ConversationDetail } from '../types';

interface ConversationState {
  activeConversationId: string | null;
  detail: ConversationDetail | null;
  messages: Message[];
  isLoadingMessages: boolean;
  hasMoreMessages: boolean;
  oldestCursor: string | null;
  typingAgentIds: string[];
  contactIsTyping: boolean;

  openConversation: (id: string) => Promise<void>;
  closeConversation: () => void;
  loadOlderMessages: () => Promise<void>;
  sendMessage: (contentType: string, content: Record<string, unknown>, replyTo?: string) => Promise<void>;

  // Socket updates
  appendMessage: (msg: Message) => void;
  updateMessageStatus: (msgId: string, status: Message['status']) => void;
  setTypingAgent: (agentId: string, isTyping: boolean) => void;
  setContactTyping: (isTyping: boolean) => void;
}

const mapMsg = (raw: Record<string, unknown>): Message => ({
  id:                raw.id as string,
  conversationId:    raw.conversation_id as string,
  direction:         raw.direction as Message['direction'],
  senderType:        raw.sender_type as Message['senderType'],
  senderId:          raw.sender_id as string,
  contentType:       raw.content_type as string,
  content:           raw.content as Record<string, unknown>,
  status:            raw.status as Message['status'],
  providerMessageId: raw.provider_message_id as string | undefined,
  providerTimestamp: raw.provider_timestamp as string | null,
  quotedMessageId:   raw.quoted_message_id as string | null | undefined,
  isDeleted:         (raw.is_deleted as boolean) ?? false,
  createdAt:         raw.created_at as string | null,
});

export const useConversationStore = create<ConversationState>((set, get) => ({
  activeConversationId: null,
  detail:               null,
  messages:             [],
  isLoadingMessages:    false,
  hasMoreMessages:      false,
  oldestCursor:         null,
  typingAgentIds:       [],
  contactIsTyping:      false,

  openConversation: async (id) => {
    // Leave previous conversation room
    const prev = get().activeConversationId;
    if (prev && prev !== id) {
      getSocket().emit('leave:conversation', { conversationId: prev });
    }

    set({ activeConversationId: id, messages: [], isLoadingMessages: true });

    // Join new conversation room
    getSocket().emit('join:conversation', { conversationId: id });

    const [detailRes, msgRes] = await Promise.all([
      api.get(`/conversations/${id}`),
      api.get(`/conversations/${id}/messages`, { params: { limit: 30 } }),
    ]);

    const msgs = (msgRes.data.data as Record<string, unknown>[]).map(mapMsg);
    set({
      detail:            detailRes.data,
      messages:          msgs,
      isLoadingMessages: false,
      hasMoreMessages:   msgRes.data.has_more,
      oldestCursor:      msgs[0]?.id ?? null,
      typingAgentIds:    [],
      contactIsTyping:   false,
    });
  },

  closeConversation: () => {
    const id = get().activeConversationId;
    if (id) getSocket().emit('leave:conversation', { conversationId: id });
    set({ activeConversationId: null, detail: null, messages: [] });
  },

  loadOlderMessages: async () => {
    const { activeConversationId, oldestCursor, isLoadingMessages, hasMoreMessages } = get();
    if (!activeConversationId || !hasMoreMessages || isLoadingMessages) return;

    set({ isLoadingMessages: true });
    try {
      const { data } = await api.get(`/conversations/${activeConversationId}/messages`, {
        params: { limit: 30, before: oldestCursor },
      });
      const older = (data.data as Record<string, unknown>[]).map(mapMsg);
      set((s) => ({
        messages:        [...older, ...s.messages],
        hasMoreMessages: data.has_more,
        oldestCursor:    older[0]?.id ?? s.oldestCursor,
      }));
    } finally {
      set({ isLoadingMessages: false });
    }
  },

  sendMessage: async (contentType, content, replyTo) => {
    const id    = get().activeConversationId;
    if (!id) return;

    const tempId = `temp_${Date.now()}`;
    const optimistic: Message = {
      id:                tempId,
      tempId,
      conversationId:    id,
      direction:         'outbound',
      senderType:        'agent',
      senderId:          '',
      contentType,
      content,
      status:            'pending',
      providerTimestamp: new Date().toISOString(),
      isDeleted:         false,
      createdAt:         new Date().toISOString(),
    };

    set((s) => ({ messages: [...s.messages, optimistic] }));

    try {
      const { data } = await api.post(`/conversations/${id}/messages`, {
        content_type:               contentType,
        content,
        reply_to_provider_msg_id:   replyTo,
      });

      // Replace temp message dengan real message dari server
      set((s) => ({
        messages: s.messages.map((m) =>
          m.tempId === tempId ? mapMsg(data.message) : m
        ),
      }));
    } catch {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.tempId === tempId ? { ...m, status: 'failed' as const } : m
        ),
      }));
    }
  },

  appendMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  updateMessageStatus: (msgId, status) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        (m.id === msgId || m.providerMessageId === msgId) ? { ...m, status } : m
      ),
    })),

  setTypingAgent: (agentId, isTyping) =>
    set((s) => ({
      typingAgentIds: isTyping
        ? [...new Set([...s.typingAgentIds, agentId])]
        : s.typingAgentIds.filter((id) => id !== agentId),
    })),

  setContactTyping: (isTyping) => set({ contactIsTyping: isTyping }),
}));
