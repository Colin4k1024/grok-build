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

export interface TodoItem {
  id: string;
  content: string;
  status: "Pending" | "InProgress" | "Completed";
  priority: string;
}

export interface Subagent {
  id: string;
  name: string;
  status: "spawning" | "running" | "done" | "failed";
  summary: string;
  toolCallId: string;
  createdAt: number;
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  command: string;
  options: { id: string; label: string; kind: string }[];
}

export interface SessionTab {
  id: string;
  title: string;
  cwd: string;
  model: string;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  createdAt: number;
  lastActiveAt: number;
}

interface SessionState {
  tabs: SessionTab[];
  activeSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  pendingPermissions: Record<string, PendingPermission[]>;
  subagents: Record<string, Subagent[]>;
  todos: Record<string, TodoItem[]>;
  tokenUsage: Record<string, { used: number; size: number }>;
  isStreaming: boolean;

  setActiveSession: (id: string | null) => void;
  addTab: (tab: SessionTab) => void;
  removeTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  closeOtherTabs: (keepId: string) => void;
  reorderTabs: (from: number, to: number) => void;
  updateTabActivity: (id: string) => void;
  setTabModel: (id: string, model: string) => void;
  setTabEffort: (id: string, effort: SessionTab["reasoningEffort"]) => void;
  addPendingPermission: (sessionId: string, perm: PendingPermission) => void;
  removePendingPermission: (sessionId: string, requestId: string) => void;
  addSubagent: (sessionId: string, subagent: Subagent) => void;
  updateSubagent: (sessionId: string, id: string, updates: Partial<Subagent>) => void;
  setTodos: (sessionId: string, todos: TodoItem[]) => void;
  toggleTodo: (sessionId: string, id: string) => void;
  setTokenUsage: (sessionId: string, used: number, size: number) => void;
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
  pendingPermissions: {},
  subagents: {},
  todos: {},
  tokenUsage: {},
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

  setTabEffort: (id, effort) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, reasoningEffort: effort } : t)),
    })),

  addPendingPermission: (sessionId, perm) =>
    set((state) => ({
      pendingPermissions: {
        ...state.pendingPermissions,
        [sessionId]: [...(state.pendingPermissions[sessionId] || []), perm],
      },
    })),

  removePendingPermission: (sessionId, requestId) =>
    set((state) => ({
      pendingPermissions: {
        ...state.pendingPermissions,
        [sessionId]: (state.pendingPermissions[sessionId] || []).filter(
          (p) => p.requestId !== requestId
        ),
      },
    })),

  addSubagent: (sessionId, subagent) =>
    set((state) => ({
      subagents: {
        ...state.subagents,
        [sessionId]: [...(state.subagents[sessionId] || []), subagent],
      },
    })),

  updateSubagent: (sessionId, id, updates) =>
    set((state) => ({
      subagents: {
        ...state.subagents,
        [sessionId]: (state.subagents[sessionId] || []).map((s) =>
          s.id === id ? { ...s, ...updates } : s
        ),
      },
    })),

  setTodos: (sessionId, todos) =>
    set((state) => ({
      todos: { ...state.todos, [sessionId]: todos },
    })),

  toggleTodo: (sessionId, id) =>
    set((state) => ({
      todos: {
        ...state.todos,
        [sessionId]: (state.todos[sessionId] || []).map((t) =>
          t.id === id
            ? { ...t, status: t.status === "Completed" ? "Pending" : "Completed" }
            : t
        ),
      },
    })),

  setTokenUsage: (sessionId, used, size) =>
    set((state) => ({
      tokenUsage: { ...state.tokenUsage, [sessionId]: { used, size } },
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
      const { [sessionId]: __, ...restPerm } = state.pendingPermissions;
      const { [sessionId]: _sa, ...restSub } = state.subagents;
      const { [sessionId]: _td, ...restTodos } = state.todos;
      const { [sessionId]: _tu, ...restUsage } = state.tokenUsage;
      return { messages: rest, pendingPermissions: restPerm, subagents: restSub, todos: restTodos, tokenUsage: restUsage };
    }),
}));
