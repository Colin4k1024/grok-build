import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

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

export interface CompactionMarker {
  id: string;
  timestamp: number;
  tokensBefore: number | null;
  tokensAfter: number | null;
  summary: string | null;
  rolledBack: boolean;
}

export type ApprovalMode = "full-access" | "ask" | "read-only";
export type WorkMode = "local" | "worktree";

export interface SessionTab {
  id: string;
  /** ACP session id of the underlying agent thread — lets a tab survive app
   *  restarts by re-resuming via session/load. */
  acpSessionId?: string;
  title: string;
  cwd: string;
  model: string;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Codex-style approval gate for tool calls (default "ask"). Optional for
   *  backward compat with persisted tabs; treat missing as "ask". */
  approvalMode?: ApprovalMode;
  /** Where the thread works: current checkout or an isolated worktree.
   *  Optional for backward compat; treat missing as "local". */
  workMode?: WorkMode;
  /** Branch the worktree mode is pinned to. */
  branch?: string;
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
  compacting: Record<string, boolean>;
  compactionMarkers: Record<string, CompactionMarker[]>;
  preCompactSnapshot: Record<string, ChatMessage[]>;
  /** Prompts queued with Tab while a turn is running (codex queue semantics);
   *  flushed automatically on TurnComplete. */
  queuedPrompts: Record<string, string[]>;
  isStreaming: boolean;
  /** Per-thread running flags — sidebar status indicators (ISS-062). */
  streaming: Record<string, boolean>;

  setActiveSession: (id: string | null) => void;
  addTab: (tab: SessionTab) => void;
  removeTab: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  /** Swap a tab's session id in place (e.g. after re-resuming a persisted
   *  thread at boot, the tab keeps its position/title but binds to the new
   *  live session id). */
  rebindTabId: (oldId: string, newId: string, acpSessionId?: string) => void;
  closeOtherTabs: (keepId: string) => void;
  reorderTabs: (from: number, to: number) => void;
  updateTabActivity: (id: string) => void;
  setTabModel: (id: string, model: string) => void;
  setTabEffort: (id: string, effort: SessionTab["reasoningEffort"]) => void;
  setTabCwd: (id: string, cwd: string) => void;
  setTabWorkMode: (id: string, mode: WorkMode, branch?: string) => void;
  setTabApprovalMode: (id: string, mode: ApprovalMode) => void;
  addPendingPermission: (sessionId: string, perm: PendingPermission) => void;
  removePendingPermission: (sessionId: string, requestId: string) => void;
  addSubagent: (sessionId: string, subagent: Subagent) => void;
  updateSubagent: (sessionId: string, id: string, updates: Partial<Subagent>) => void;
  setTodos: (sessionId: string, todos: TodoItem[]) => void;
  toggleTodo: (sessionId: string, id: string) => void;
  setTokenUsage: (sessionId: string, used: number, size: number) => void;
  setCompacting: (sessionId: string, compacting: boolean) => void;
  snapshotForCompaction: (sessionId: string) => void;
  addCompactionMarker: (sessionId: string, marker: Omit<CompactionMarker, "id" | "rolledBack">) => void;
  rollbackCompaction: (sessionId: string) => void;
  setStreaming: (streaming: boolean) => void;
  /** Per-thread streaming flag (background threads keep theirs while the
   *  global flag tracks the active view). */
  setSessionStreaming: (sessionId: string, streaming: boolean) => void;
  addUserMessage: (sessionId: string, content: string) => void;
  /** Replace a session's transcript with disk-persisted history (resume fallback). */
  loadHistoryMessages: (sessionId: string, entries: { role: string; content: string; timestamp: number }[]) => void;
  appendAssistantText: (sessionId: string, delta: string) => void;
  /** Drop the streaming flag from every message — used after a session/load
   *  replay completes so the restored transcript renders as settled history. */
  finalizeMessages: (sessionId: string) => void;
  addToolCall: (sessionId: string, toolName: string) => void;
  addToolResult: (sessionId: string, toolName: string, output: string, success: boolean) => void;
  clearMessages: (sessionId: string) => void;
  enqueueQueuedPrompt: (sessionId: string, text: string) => void;
  /** Pop the oldest queued prompt (codex Tab-queue flush order). */
  shiftQueuedPrompt: (sessionId: string) => string | undefined;
}

// Streaming throttle buffers (module-level for persistence across renders)
const streamBuffer: Record<string, string> = {};
const streamFlushMap: Record<string, number> = {};
const streamFlushTimerMap: Record<string, number | undefined> = {};

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
  tabs: [],
  activeSessionId: null,
  messages: {},
  pendingPermissions: {},
  subagents: {},
  todos: {},
  tokenUsage: {},
  compacting: {},
  compactionMarkers: {},
  preCompactSnapshot: {},
  queuedPrompts: {},
  isStreaming: false,
  streaming: {},

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
      const { [id]: _m, ...restMessages } = state.messages;
      const { [id]: _pp, ...restPendingPermissions } = state.pendingPermissions;
      const { [id]: _sa, ...restSubagents } = state.subagents;
      const { [id]: _td, ...restTodos } = state.todos;
      const { [id]: _tu, ...restTokenUsage } = state.tokenUsage;
      const { [id]: _co, ...restCompacting } = state.compacting;
      const { [id]: _cm, ...restCompactionMarkers } = state.compactionMarkers;
      const { [id]: _pc, ...restPreCompactSnapshot } = state.preCompactSnapshot;
      const { [id]: _qp, ...restQueuedPrompts } = state.queuedPrompts;
      let newActive = state.activeSessionId;
      if (state.activeSessionId === id) {
        newActive = newTabs.length > 0
          ? newTabs[Math.min(idx, newTabs.length - 1)].id
          : null;
      }
      return {
        tabs: newTabs,
        messages: restMessages,
        pendingPermissions: restPendingPermissions,
        subagents: restSubagents,
        todos: restTodos,
        tokenUsage: restTokenUsage,
        compacting: restCompacting,
        compactionMarkers: restCompactionMarkers,
        preCompactSnapshot: restPreCompactSnapshot,
        queuedPrompts: restQueuedPrompts,
        activeSessionId: newActive,
      };
    }),

  renameTab: (id, title) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),

  rebindTabId: (oldId, newId, acpSessionId) =>
    set((state) => {
      const { [oldId]: _old, ...restMessages } = state.messages;
      // Prefer messages already recorded under the new id (session/load
      // replay emits against the new live id before the rebind happens).
      const migrated =
        state.messages[newId]?.length ? state.messages[newId] : (state.messages[oldId] ?? []);
      return {
        tabs: state.tabs.map((t) =>
          t.id === oldId ? { ...t, id: newId, acpSessionId: acpSessionId ?? t.acpSessionId } : t
        ),
        messages: { ...restMessages, [newId]: migrated },
        activeSessionId: state.activeSessionId === oldId ? newId : state.activeSessionId,
      };
    }),

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

  setTabCwd: (id, cwd) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, cwd } : t)),
    })),

  setTabWorkMode: (id, mode, branch) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, workMode: mode, branch: branch ?? (mode === "local" ? undefined : t.branch) } : t
      ),
    })),

  setTabApprovalMode: (id, mode) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, approvalMode: mode } : t)),
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

  setCompacting: (sessionId, compacting) =>
    set((state) => ({
      compacting: { ...state.compacting, [sessionId]: compacting },
    })),

  snapshotForCompaction: (sessionId) =>
    set((state) => ({
      preCompactSnapshot: {
        ...state.preCompactSnapshot,
        [sessionId]: [...(state.messages[sessionId] || [])],
      },
    })),

  addCompactionMarker: (sessionId, marker) =>
    set((state) => ({
      compactionMarkers: {
        ...state.compactionMarkers,
        [sessionId]: [...(state.compactionMarkers[sessionId] || []), { ...marker, id: genId("compact"), rolledBack: false }],
      },
    })),

  rollbackCompaction: (sessionId) =>
    set((state) => {
      const snapshot = state.preCompactSnapshot[sessionId];
      if (!snapshot) return {};
      const markers = state.compactionMarkers[sessionId] || [];
      const lastMarkerIdx = markers.reduce((acc, m, i) => m.timestamp > markers[acc].timestamp ? i : acc, 0);
      return {
        messages: { ...state.messages, [sessionId]: [...snapshot] },
        compactionMarkers: {
          ...state.compactionMarkers,
          [sessionId]: markers.map((m, i) => i === lastMarkerIdx ? { ...m, rolledBack: true } : m),
        },
      };
    }),

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  setSessionStreaming: (sessionId, streaming) =>
    set((state) => ({
      streaming: { ...state.streaming, [sessionId]: streaming },
    })),

  finalizeMessages: (sessionId) =>
    set((state) => {
      const msgs = state.messages[sessionId];
      if (!msgs || !msgs.some((m) => m.streaming)) return {};
      return {
        messages: {
          ...state.messages,
          [sessionId]: msgs.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        },
      };
    }),

  loadHistoryMessages: (sessionId, entries) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: entries
          .filter((e) => e.role === "user" || e.role === "assistant")
          .map((e) => ({
            id: genId("msg"),
            role: e.role as "user" | "assistant",
            content: e.content,
            timestamp: e.timestamp || Date.now(),
          })),
      },
    })),

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

  appendAssistantText: (sessionId, delta) => {
    const now = Date.now();
    const key = `_stream_${sessionId}`;
    const lastFlush = streamFlushMap[key] || 0;
    const STREAM_INTERVAL = 50;

    if (now - lastFlush < STREAM_INTERVAL) {
      streamBuffer[key] = (streamBuffer[key] || "") + delta;
      // Trailing flush — schedule a timer so the buffered tail isn't lost
      // when the stream ends with a burst of sub-interval deltas.
      if (!streamFlushTimerMap[key]) {
        streamFlushTimerMap[key] = setTimeout(() => {
          streamFlushTimerMap[key] = undefined;
          const pending = streamBuffer[key] || "";
          streamBuffer[key] = "";
          streamFlushMap[key] = Date.now();
          if (!pending) return;
          set((state) => {
            const msgs = state.messages[sessionId] || [];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant" && last.streaming) {
              return {
                messages: {
                  ...state.messages,
                  [sessionId]: [...msgs.slice(0, -1), { ...last, content: last.content + pending }],
                },
              };
            }
            return {
              messages: {
                ...state.messages,
                [sessionId]: [
                  ...msgs,
                  { id: genId("msg"), role: "assistant" as const, content: pending, timestamp: Date.now(), streaming: true },
                ],
              },
            };
          });
        }, STREAM_INTERVAL) as unknown as number;
      }
      return {};
    }

    const buffered = streamBuffer[key] || "";
    streamBuffer[key] = "";
    streamFlushMap[key] = now;
    const combined = buffered + delta;
    if (!combined) return {};

    set((state) => {
      const msgs = state.messages[sessionId] || [];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        return {
          messages: {
            ...state.messages,
            [sessionId]: [...msgs.slice(0, -1), { ...last, content: last.content + combined }],
          },
        };
      }
      return {
        messages: {
          ...state.messages,
          [sessionId]: [
            ...msgs,
            { id: genId("msg"), role: "assistant" as const, content: combined, timestamp: Date.now(), streaming: true },
          ],
        },
      };
    });
    return {};
  },

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

  enqueueQueuedPrompt: (sessionId, text) =>
    set((state) => ({
      queuedPrompts: {
        ...state.queuedPrompts,
        [sessionId]: [...(state.queuedPrompts[sessionId] || []), text],
      },
    })),

  shiftQueuedPrompt: (sessionId) => {
    const queue = get().queuedPrompts[sessionId] || [];
    if (queue.length === 0) return undefined;
    set((state) => ({
      queuedPrompts: { ...state.queuedPrompts, [sessionId]: queue.slice(1) },
    }));
    return queue[0];
  },

  clearMessages: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.messages;
      const { [sessionId]: __, ...restPerm } = state.pendingPermissions;
      const { [sessionId]: _sa, ...restSub } = state.subagents;
      const { [sessionId]: _td, ...restTodos } = state.todos;
      const { [sessionId]: _tu, ...restUsage } = state.tokenUsage;
      const { [sessionId]: _co, ...restCompact } = state.compacting;
      const { [sessionId]: _cm, ...restMarkers } = state.compactionMarkers;
      const { [sessionId]: _pc, ...restSnap } = state.preCompactSnapshot;
      const { [sessionId]: _q, ...restQueued } = state.queuedPrompts;
      return { messages: rest, pendingPermissions: restPerm, subagents: restSub, todos: restTodos, tokenUsage: restUsage, compacting: restCompact, compactionMarkers: restMarkers, preCompactSnapshot: restSnap, queuedPrompts: restQueued };
    }),
    }),
    {
      name: "gb-session-tabs",
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // Persist only the shell state needed to restore tabs across restarts;
      // streaming buffers and per-session message contents stay in memory.
      partialize: (state) => ({
        tabs: state.tabs,
        activeSessionId: state.activeSessionId,
      }),
    }
  )
);
