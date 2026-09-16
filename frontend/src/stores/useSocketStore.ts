import { create } from 'zustand';

interface SocketState {
  isConnected: boolean;
  setConnected: (v: boolean) => void;
}

export const useSocketStore = create<SocketState>((set) => ({
  isConnected: false,
  setConnected: (v) => set({ isConnected: v }),
}));
