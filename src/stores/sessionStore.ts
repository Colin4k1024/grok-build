import { create } from "zustand";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolSuccess?: boolean;
  timestamp: number;
  streaming?: boolean;
}

export interface SessionTab {
  id: string;
  title: string;
  cwd: string;
  model: string;
  createdAt: number;
  lastActiveAt: number;
}

interface SessionState {
  tabs: SessionTab[];
  activeSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  isStreaming: boolean;

  setActiveSession: (id: string | null) => void;
  addTab: (tab: SessionTab) => void;
  removeTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  closeOtherTabs: (keepId: string) => void;
  reorderTabs: (from: number, to: number) => void;
  updateTabActivity: (id: string) => void;
  setTabModel: (id: string, model: string) => void;
  setStreaming: (streaming: boolean) => void;
  addUserMessage: (sessionId: string, content: string) => void;
  appendAssistantText: (sessionId: string, delta: string) => void;
  addToolCall: (sessionId: string, toolName: string) => void;
  addToolResult: (sessionId: string, toolName: string, output: string, success: boolean) => void;
  clearMessages: (sessionId: string) => void;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useSessionStore = create<SessionState>((set) => ({
  tabs: [],
  activeSessionId: null,
  messages: {},
  isStreaming: false,

  setActiveSession: (id) => set({ activeSessionId: id }),

  addTab: (tab) =>
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeSessionId: tab.id,
    })),

  removeTab: (id) =>
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      const newTabs = state.tabs.filter((t) => t.id !== id);
      const { [id]: _, ...rest } = state.messages;
      let newActive = state.activeSessionId;
      if (state.activeSessionId === id) {
        newActive = newTabs.length > 0
          ? newTabs[Math.min(idx, newTabs.length - 1)].id
          : null;
      }
      return { tabs: newTabs, messages: rest, activeSessionId: newActive };
    }),

  renameTab: (id, title) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),

  closeOtherTabs: (keepId) =>
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id === keepId);
      const newMessages: Record<string, ChatMessage[]> = {};
      if (state.messages[keepId]) newMessages[keepId] = state.messages[keepId];
      return { tabs: newTabs, messages: newMessages, activeSessionId: keepId };
    }),

  reorderTabs: (from, to) =>
    set((state) => {
      const newTabs = [...state.tabs];
      const [moved] = newTabs.splice(from, 1);
      newTabs.splice(to, 0, moved);
      return { tabs: newTabs };
    }),

  updateTabActivity: (id) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, lastActiveAt: Date.now() } : t)),
    })),

  setTabModel: (id, model) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, model } : t)),
    })),

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  addUserMessage: (sessionId, content) =>
    set((state) => {
      const tabs = state.tabs.map((t) =>
        t.id === sessionId ? { ...t, lastActiveAt: Date.now() } : t
      );
      return {
        tabs,
        messages: {
          ...state.messages,
          [sessionId]: [
            ...(state.messages[sessionId] || []),
            { id: genId("msg"), role: "user" as const, content, timestamp: Date.now() },
          ],
        },
      };
    }),

  appendAssistantText: (sessionId, delta) =>
    set((state) => {
      const msgs = state.messages[sessionId] || [];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        return {
          messages: {
            ...state.messages,
            [sessionId]: [...msgs.slice(0, -1), { ...last, content: last.content + delta }],
          },
        };
      }
      return {
        messages: {
          ...state.messages,
          [sessionId]: [
            ...msgs,
            { id: genId("msg"), role: "assistant" as const, content: delta, timestamp: Date.now(), streaming: true },
          ],
        },
      };
    }),

  addToolCall: (sessionId, toolName) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [
          ...(state.messages[sessionId] || []),
          { id: genId("tool"), role: "tool" as const, content: "", toolName, timestamp: Date.now() },
        ],
      },
    })),

  addToolResult: (sessionId, toolName, output, success) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [
          ...(state.messages[sessionId] || []),
          { id: genId("tool-result"), role: "tool" as const, content: output, toolName, toolSuccess: success, timestamp: Date.now() },
        ],
      },
    })),

  clearMessages: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.messages;
      return { messages: rest };
    }),
}));
