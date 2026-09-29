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
  status: "spawning" | "running" | "done" | "failed" | "cancelled";
  summary: string;
  toolCallId: string;
  createdAt: number;
  progress?: string;
  progressItems?: { label: string; status: "todo" | "in_progress" | "done" | "failed" }[];
}

/** Turn state machine (R3-09). Every TurnComplete advances the turn counter. */
export type TurnState = "idle" | "streaming" | "queued" | "compacting";

export interface TurnInfo {
  turnId: number;
  state: TurnState;
  startedAt: number;
  /** Messages belonging to this turn (indices into the session's messages array). */
  messageIndices: number[];
}

export interface PendingQuestion {
  requestId: string;
  questions: { question: string; options: { label: string; description: string; preview?: string }[]; multiSelect?: boolean; id?: string }[];
  mode: string;
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

/** Per-session ACP connection status (ISS-187). */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected" | "error";

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
  /** True when the user explicitly picked this session's approval mode
   *  (composer select or home preset) — a global toggle must not clobber
   *  it. The SandboxToggle re-syncs only unpinned tabs (R4-07 #240). */
  approvalPinned?: boolean;
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
  pendingQuestions: Record<string, PendingQuestion[]>;
  subagents: Record<string, Subagent[]>;
  todos: Record<string, TodoItem[]>;
  tokenUsage: Record<string, { used: number; size: number }>;
  /** Rate-limit banner state per session (epoch-ms retry deadline). */
  rateLimits: Record<string, { until: number; message: string }>;
  compacting: Record<string, boolean>;
  compactionMarkers: Record<string, CompactionMarker[]>;
  preCompactSnapshot: Record<string, ChatMessage[]>;
  /** Prompts queued with Tab while a turn is running (codex queue semantics);
   *  flushed automatically on TurnComplete. */
  queuedPrompts: Record<string, string[]>;
  isStreaming: boolean;
  /** Per-thread running flags — sidebar status indicators (ISS-062). */
  streaming: Record<string, boolean>;
  /** Turn counter + per-session turn state (R3-09). */
  turnCounter: Record<string, number>;
  turns: Record<string, TurnInfo[]>;
  /** ACP connection status per session (ISS-187). */
  connectionStatus: Record<string, ConnectionStatus>;
  /** Last connection error message per session. */
  connectionError: Record<string, string | null>;

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
  /** System re-sync without pinning (SandboxToggle/policy enforcement). */
  syncTabApprovalMode: (id: string, mode: ApprovalMode) => void;
  addPendingPermission: (sessionId: string, perm: PendingPermission) => void;
  addPendingQuestion: (sessionId: string, q: PendingQuestion) => void;
  removePendingQuestion: (sessionId: string, requestId: string) => void;
  removePendingPermission: (sessionId: string, requestId: string) => void;
  addSubagent: (sessionId: string, subagent: Subagent) => void;
  updateSubagent: (sessionId: string, id: string, updates: Partial<Subagent>) => void;
  setTodos: (sessionId: string, todos: TodoItem[]) => void;
  toggleTodo: (sessionId: string, id: string) => void;
  setTokenUsage: (sessionId: string, used: number, size: number) => void;
  /** Set/clear the rate-limit banner for a session. */
  setRateLimit: (sessionId: string, limit: { until: number; message: string } | null) => void;
  setCompacting: (sessionId: string, compacting: boolean) => void;
  snapshotForCompaction: (sessionId: string) => void;
  addCompactionMarker: (sessionId: string, marker: Omit<CompactionMarker, "id" | "rolledBack">) => void;
  rollbackCompaction: (sessionId: string) => void;
  setStreaming: (streaming: boolean) => void;
  /** Per-thread streaming flag (background threads keep theirs while the
   *  global flag tracks the active view). */
  setSessionStreaming: (sessionId: string, streaming: boolean) => void;
  addUserMessage: (sessionId: string, content: string) => void;
  /** Transactionally remove the trailing user message (failed sends). */
  removeLastUserMessage: (sessionId: string) => void;
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
  /** Turn tracking (R3-09): start a new turn on user prompt send. */
  startTurn: (sessionId: string) => number;
  /** Complete the current turn. */
  completeTurn: (sessionId: string) => void;
  /** Update a subagent's progress items (R3-09). */
  setSubagentProgress: (sessionId: string, id: string, progress: string, items?: { label: string; status: "todo" | "in_progress" | "done" | "failed" }[]) => void;

  /** Set ACP connection status for a session (ISS-187). */
  setConnectionStatus: (sessionId: string, status: ConnectionStatus, error?: string | null) => void;
}

// Streaming throttle buffers (module-level for persistence across renders)
const streamBuffer: Record<string, string> = {};
const streamFlushMap: Record<string, number> = {};
const streamFlushTimerMap: Record<string, number | undefined> = {};

// ---- Shell persistence ------------------------------------------------------
//
// zustand's `persist` middleware wrapped `set` and ran a full
// `{ ...get() }` + JSON.stringify + SYNCHRONOUS localStorage write on every
// single state change. During a streaming turn that is 20-100 main-thread
// disk writes per second for data that never changes (only `tabs` and
// `activeSessionId` are persisted). Replaced with a change-detected,
// throttled writer subscribed to the two keys we actually keep.

const STORAGE_KEY = "gb-session-tabs";
const STORAGE_VERSION = 1;
/** Debounce window; a burst of tab edits collapses into one write. */
const WRITE_THROTTLE_MS = 400;
/** Hard ceiling so a continuous stream of edits can never starve the disk. */
const WRITE_MAX_WAIT_MS = 3000;

interface PersistedShell {
  tabs: SessionTab[];
  activeSessionId: string | null;
}

function readPersistedShell(): PersistedShell {
  const empty: PersistedShell = { tabs: [], activeSessionId: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as { state?: Partial<PersistedShell> };
    const state = parsed?.state;
    if (!state) return empty;
    return {
      tabs: Array.isArray(state.tabs) ? state.tabs : [],
      activeSessionId:
        typeof state.activeSessionId === "string" ? state.activeSessionId : null,
    };
  } catch {
    return empty; // corrupt payload — start clean rather than crash at boot
  }
}

// Hydrate synchronously at module load so the very first render already sees
// the restored tabs (no empty-shell flash, no second layout pass).
const bootShell = readPersistedShell();

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useSessionStore = create<SessionState>()(
    (set, get) => ({
  tabs: bootShell.tabs,
  activeSessionId: bootShell.activeSessionId,
  messages: {},
  pendingPermissions: {},
  pendingQuestions: {},
  subagents: {},
  todos: {},
  turnCounter: {},
  turns: {},
  tokenUsage: {},
  rateLimits: {},
  compacting: {},
  compactionMarkers: {},
  preCompactSnapshot: {},
  queuedPrompts: {},
  isStreaming: false,
  streaming: {},
	  connectionStatus: {},
	  connectionError: {},

  // No-op guard: `set` always notifies every subscriber, so writing an
  // identical value used to re-run every selector in the app for nothing.
  setActiveSession: (id) => {
    if (get().activeSessionId === id) return;
    set({ activeSessionId: id });
  },

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
      const { [id]: _pq, ...restPendingQuestions } = state.pendingQuestions;
      const { [id]: _sa, ...restSubagents } = state.subagents;
      const { [id]: _td, ...restTodos } = state.todos;
      const { [id]: _tu, ...restTokenUsage } = state.tokenUsage;
      const { [id]: _rl, ...restRateLimits } = state.rateLimits;
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
        pendingQuestions: restPendingQuestions,
        subagents: restSubagents,
        todos: restTodos,
        tokenUsage: restTokenUsage,
        rateLimits: restRateLimits,
        compacting: restCompacting,
        compactionMarkers: restCompactionMarkers,
        preCompactSnapshot: restPreCompactSnapshot,
        queuedPrompts: restQueuedPrompts,
        activeSessionId: newActive,
      };
    }),

  renameTab: (id, title) =>
    set((state) => {
      const target = state.tabs.find((t) => t.id === id);
      if (!target || target.title === title) return state;
      return { tabs: state.tabs.map((t) => (t.id === id ? { ...t, title } : t)) };
    }),

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
    set((state) => {
      const now = Date.now();
      const target = state.tabs.find((t) => t.id === id);
      if (!target) return state;
      // Coarse-grained: sub-second repeats are indistinguishable to the UI and
      // used to rebuild the tabs array (and re-render the thread tree) each time.
      if (now - target.lastActiveAt < 1000) return state;
      return { tabs: state.tabs.map((t) => (t.id === id ? { ...t, lastActiveAt: now } : t)) };
    }),

  setTabModel: (id, model) =>
    set((state) => {
      const target = state.tabs.find((t) => t.id === id);
      if (!target || target.model === model) return state;
      return { tabs: state.tabs.map((t) => (t.id === id ? { ...t, model } : t)) };
    }),

  setTabEffort: (id, effort) =>
    set((state) => {
      const target = state.tabs.find((t) => t.id === id);
      if (!target || target.reasoningEffort === effort) return state;
      return { tabs: state.tabs.map((t) => (t.id === id ? { ...t, reasoningEffort: effort } : t)) };
    }),

  setTabCwd: (id, cwd) =>
    set((state) => {
      const target = state.tabs.find((t) => t.id === id);
      if (!target || target.cwd === cwd) return state;
      return { tabs: state.tabs.map((t) => (t.id === id ? { ...t, cwd } : t)) };
    }),

  setTabWorkMode: (id, mode, branch) =>
    set((state) => {
      const target = state.tabs.find((t) => t.id === id);
      if (!target) return state;
      const nextBranch = branch ?? (mode === "local" ? undefined : target.branch);
      if (target.workMode === mode && target.branch === nextBranch) return state;
      return {
        tabs: state.tabs.map((t) =>
          t.id === id ? { ...t, workMode: mode, branch: nextBranch } : t
        ),
      };
    }),

  setTabApprovalMode: (id, mode) =>
    set((state) => {
      const target = state.tabs.find((t) => t.id === id);
      if (!target || (target.approvalMode ?? "ask") === mode) return state;
      // A per-tab write is a user choice — pin it against global re-syncs.
      return { tabs: state.tabs.map((t) => (t.id === id ? { ...t, approvalMode: mode, approvalPinned: true } : t)) };
    }),

  /** System re-sync (SandboxToggle / policy push) — updates the display
   *  WITHOUT pinning: the tab still follows global/project changes. */
  syncTabApprovalMode: (id, mode) =>
    set((state) => {
      const target = state.tabs.find((t) => t.id === id);
      if (!target || (target.approvalMode ?? "ask") === mode) return state;
      return { tabs: state.tabs.map((t) => (t.id === id ? { ...t, approvalMode: mode } : t)) };
    }),

  addPendingQuestion: (sessionId, q) =>
    set((state) => ({
      pendingQuestions: {
        ...state.pendingQuestions,
        [sessionId]: [...(state.pendingQuestions[sessionId] || []), q],
      },
    })),

  removePendingQuestion: (sessionId, requestId) =>
    set((state) => ({
      pendingQuestions: {
        ...state.pendingQuestions,
        [sessionId]: (state.pendingQuestions[sessionId] || []).filter(
          (x) => x.requestId !== requestId
        ),
      },
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
    set((state) => {
      const prev = state.todos[sessionId];
      // PlanUpdate re-fires with identical content on every turn tick; skip the
      // new-array churn so TodoPanel/RightPanel don't re-render for nothing.
      if (prev && prev.length === todos.length && prev.every((t, i) => t === todos[i])) {
        return state;
      }
      return { todos: { ...state.todos, [sessionId]: todos } };
    }),

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
    set((state) => {
      const current = state.tokenUsage[sessionId];
      if (current && current.used === used && current.size === size) return state;
      // Monotonic guard (ISS-081): out-of-order or stale usage events must
      // never shrink the counter — drop them instead of showing wrong numbers.
      if (current && used < current.used) {
        return current.size === size ? {} : { tokenUsage: { ...state.tokenUsage, [sessionId]: { used: current.used, size } } };
      }
      return { tokenUsage: { ...state.tokenUsage, [sessionId]: { used, size } } };
    }),

  setRateLimit: (sessionId, limit) =>
    set((state) => {
      if (limit === null) {
        if (!(sessionId in state.rateLimits)) return state;
        const { [sessionId]: _drop, ...rest } = state.rateLimits;
        return { rateLimits: rest };
      }
      return { rateLimits: { ...state.rateLimits, [sessionId]: limit } };
    }),

  setCompacting: (sessionId, compacting) =>
    set((state) => {
      if ((state.compacting[sessionId] ?? false) === compacting) return state;
      return { compacting: { ...state.compacting, [sessionId]: compacting } };
    }),

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
      if (!snapshot) return state;
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

  setStreaming: (streaming) => {
    if (get().isStreaming === streaming) return;
    set({ isStreaming: streaming });
  },

  setSessionStreaming: (sessionId, streaming) =>
    set((state) => {
      // Fires on every text delta; without this guard each one built a new
      // `streaming` record and re-rendered the whole thread tree at token rate.
      if ((state.streaming[sessionId] ?? false) === streaming) return state;
      return { streaming: { ...state.streaming, [sessionId]: streaming } };
    }),

  finalizeMessages: (sessionId) =>
    set((state) => {
      const msgs = state.messages[sessionId];
      if (!msgs || !msgs.some((m) => m.streaming)) return state;
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
      // Only touch `tabs` when the timestamp actually moves — rebuilding the
      // array invalidates every tab-derived selector across the shell.
      const needsActivity = state.tabs.some(
        (t) => t.id === sessionId && Date.now() - t.lastActiveAt >= 1000
      );
      const tabs = needsActivity
        ? state.tabs.map((t) => (t.id === sessionId ? { ...t, lastActiveAt: Date.now() } : t))
        : state.tabs;
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

  removeLastUserMessage: (sessionId) =>
    set((state) => {
      const msgs = state.messages[sessionId];
      if (!msgs || msgs.length === 0) return state;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === "user") {
          return {
            messages: {
              ...state.messages,
              [sessionId]: msgs.slice(0, i),
            },
          };
        }
      }
      return state; // no trailing user message to remove
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

  // ---- Turn tracking (R3-09) ----
  startTurn: (sessionId) => {
    const counter = (get().turnCounter[sessionId] || 0) + 1;
    set((state) => ({
      turnCounter: { ...state.turnCounter, [sessionId]: counter },
      streaming: { ...state.streaming, [sessionId]: true },
      turns: {
        ...state.turns,
        [sessionId]: [
          ...(state.turns[sessionId] || []),
          {
            turnId: counter,
            state: "streaming" as const,
            startedAt: Date.now(),
            messageIndices: (state.messages[sessionId]?.length ? [state.messages[sessionId].length] : []),
          },
        ],
      },
    }));
    return counter;
  },

  completeTurn: (sessionId) =>
    set((state) => {
      const turns = state.turns[sessionId] || [];
      if (turns.length === 0) return {};
      const idx = turns.length - 1;
      return {
        streaming: { ...state.streaming, [sessionId]: false },
        isStreaming: false,
        turns: {
          ...state.turns,
          [sessionId]: turns.map((t, i) => i === idx ? { ...t, state: "idle" as const } : t),
        },
      };
    }),

  setSubagentProgress: (sessionId, id, progress, items) =>
    set((state) => ({
      subagents: {
        ...state.subagents,
        [sessionId]: (state.subagents[sessionId] || []).map((s) =>
          s.id === id ? { ...s, progress, progressItems: items ?? s.progressItems } : s
        ),
      },
    })),

  setConnectionStatus: (sessionId, status, error) =>
    set((state) => ({
      connectionStatus: { ...state.connectionStatus, [sessionId]: status },
      connectionError: {
        ...state.connectionError,
        [sessionId]: error !== undefined ? error : (state.connectionError[sessionId] ?? null),
      },
    })),

  clearMessages: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.messages;
      const { [sessionId]: __, ...restPerm } = state.pendingPermissions;
      const { [sessionId]: _sa, ...restSub } = state.subagents;
      const { [sessionId]: _td, ...restTodos } = state.todos;
      const { [sessionId]: _tu, ...restUsage } = state.tokenUsage;
      const { [sessionId]: _rl, ...restRateLimits } = state.rateLimits;
      const { [sessionId]: _co, ...restCompact } = state.compacting;
      const { [sessionId]: _cm, ...restMarkers } = state.compactionMarkers;
      const { [sessionId]: _pc, ...restSnap } = state.preCompactSnapshot;
      const { [sessionId]: _q, ...restQueued } = state.queuedPrompts;
      return { messages: rest, pendingPermissions: restPerm, subagents: restSub, todos: restTodos, tokenUsage: restUsage, rateLimits: restRateLimits, compacting: restCompact, compactionMarkers: restMarkers, preCompactSnapshot: restSnap, queuedPrompts: restQueued };
    }),
    })
);

// ---- Throttled shell writer -------------------------------------------------

let lastSerialized = "";
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let firstDirtyAt = 0;

/** Serialize + write the persisted slice. Skips the write entirely when the
 *  JSON is byte-identical to what is already on disk. */
export function flushPersistedShell(): void {
  const { tabs, activeSessionId } = useSessionStore.getState();
  let next: string;
  try {
    next = JSON.stringify({
      state: { tabs, activeSessionId },
      version: STORAGE_VERSION,
    });
  } catch {
    return; // unserializable state — keep the previous snapshot
  }
  if (next === lastSerialized) return;
  lastSerialized = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* quota exceeded — in-memory state is still authoritative */
  }
}

function scheduleShellWrite(): void {
  const now = Date.now();
  if (!firstDirtyAt) firstDirtyAt = now;
  if (writeTimer) {
    // Guarantee a bounded staleness window under continuous edits.
    if (now - firstDirtyAt < WRITE_MAX_WAIT_MS) return;
    clearTimeout(writeTimer);
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    firstDirtyAt = 0;
    flushPersistedShell();
  }, WRITE_THROTTLE_MS);
}

// Only the two persisted keys can dirty the snapshot. Message/streaming churn
// — the 20-100 Hz path — never touches localStorage at all now.
useSessionStore.subscribe((state, prev) => {
  if (state.tabs !== prev.tabs || state.activeSessionId !== prev.activeSessionId) {
    scheduleShellWrite();
  }
});

// Seed the change-detector with what we just hydrated so a no-op edit does
// not rewrite the identical payload.
try {
  lastSerialized =
    localStorage.getItem(STORAGE_KEY) ??
    JSON.stringify({ state: bootShell, version: STORAGE_VERSION });
} catch {
  lastSerialized = "";
}

if (typeof window !== "undefined") {
  // A pending debounce must not be lost when the window goes away.
  const flush = () => {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
      firstDirtyAt = 0;
    }
    flushPersistedShell();
  };
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
}
