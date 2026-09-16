import { create } from 'zustand';
import type { AgentPresence, AgentStatus } from '../types';

interface PresenceState {
  agents: Record<string, AgentPresence>;

  setOnline: (agentId: string) => void;
  setOffline: (agentId: string) => void;
  updateStatus: (agentId: string, status: AgentStatus) => void;
  setAgents: (agents: AgentPresence[]) => void;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  agents: {},

  setOnline: (agentId) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [agentId]: { ...(s.agents[agentId] ?? { agentId, name: '', avatarUrl: null, lastSeen: null }), status: 'online' },
      },
    })),

  setOffline: (agentId) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [agentId]: { ...(s.agents[agentId] ?? { agentId, name: '', avatarUrl: null, lastSeen: null }), status: 'offline' },
      },
    })),

  updateStatus: (agentId, status) =>
    set((s) => ({
      agents: {
        ...s.agents,
        [agentId]: { ...(s.agents[agentId] ?? { agentId, name: '', avatarUrl: null, lastSeen: null }), status },
      },
    })),

  setAgents: (agents) =>
    set({ agents: Object.fromEntries(agents.map((a) => [a.agentId, a])) }),
}));
