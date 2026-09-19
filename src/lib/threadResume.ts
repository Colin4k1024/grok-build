import { useSessionStore } from "../stores/sessionStore";
import {
  resumeSession,
  closeSession,
  getSessionHistoryMessages,
  type HistorySession,
} from "./tauri";

// One in-flight resume per persisted thread. The optimistic tab already makes
// double-clicks focus the pending tab (the existing-tab check below sees its
// acpSessionId), but this lock is the belt-and-braces guard against
// programmatic double-fire in the same frame — observed in the wild as the
// same thread resumed 4x with concurrent agent spawns.
const inFlight = new Set<string>();

export function isResumeInFlight(sessionId: string): boolean {
  return inFlight.has(sessionId);
}

export interface ResumeUi {
  /** The optimistic tab landed — switch the view off Home immediately. */
  onOptimisticOpen: () => void;
  /** An existing live tab was focused instead of spawning. */
  onFocusExisting: () => void;
  /** The focused tab is mid-turn — caller shows the read-only-follow notice. */
  onStreamingExisting: () => void;
  /** Resume failed — caller surfaces the error and restores navigation. */
  onError: (message: string) => void;
}

/**
 * Open a persisted thread with an optimistic tab: the view switches on the
 * click itself and the agent spawn (seconds) proceeds behind a "restoring"
 * state. The tab is created under a pending id and rebound to the live id
 * once resume resolves — the same rebindTabId migration the boot re-resume
 * uses, including its "prefer messages recorded under the new id" rule for
 * replay events that race the rebind.
 *
 * Returns "started" when THIS invocation launched the resume (it owns the
 * restoring-state cleanup — it settles exactly when the spawn settles), or
 * "focused" when it merely focused an existing/in-flight tab (must not
 * clear another invocation's restoring state).
 */
export async function openHistoryThread(
  session: HistorySession,
  ui: ResumeUi
): Promise<"started" | "focused"> {
  const existing = useSessionStore.getState().tabs.find((t) => t.acpSessionId === session.id);
  if (existing) {
    useSessionStore.getState().setActiveSession(existing.id);
    ui.onFocusExisting();
    // Active-writer conflict (ISS-079, codex #43253 semantics): another
    // surface holds the pen — follow the transcript read-only, retry after.
    if (useSessionStore.getState().streaming[existing.id]) ui.onStreamingExisting();
    return "focused";
  }
  if (inFlight.has(session.id)) return "focused";
  inFlight.add(session.id);

  const optimisticId = `pending:${session.id}`;
  const title = session.title.slice(0, 40) + (session.title.length > 40 ? "…" : "");

  useSessionStore.getState().addTab({
    id: optimisticId,
    acpSessionId: session.id,
    title,
    cwd: session.cwd,
    model: session.model || "",
    reasoningEffort: "medium",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });
  ui.onOptimisticOpen();

  // Disk transcript paints into the pending tab immediately — the read is
  // local and fast, so the thread is readable long before the agent spawn
  // finishes. Replay notifications for session/load complete before the
  // resume RPC resolves, so they cannot append on top of this later; if
  // replay content did land, rebindTabId prefers it and discards this copy.
  getSessionHistoryMessages(session.id, session.cwd)
    .then((historyMsgs) => {
      if (historyMsgs.length === 0) return;
      const st = useSessionStore.getState();
      // The rebind may already have run — then this write would target a
      // dead key; the resolve-time fallback below owns that case instead.
      if (st.tabs.some((t) => t.id === optimisticId) && (st.messages[optimisticId] || []).length === 0) {
        st.loadHistoryMessages(optimisticId, historyMsgs);
      }
    })
    .catch(() => {});

  try {
    const info = await resumeSession(session.id, session.cwd);
    // The user may have closed the optimistic tab while the spawn was in
    // flight. Honor that immediately: rebinding onto a removed tab would
    // orphan the freshly spawned live session (agent running, no tab).
    if (!useSessionStore.getState().tabs.some((t) => t.id === optimisticId)) {
      closeSession(info.id).catch(() => {});
      return "started";
    }
    const st = useSessionStore.getState();
    st.finalizeMessages(info.id);
    st.rebindTabId(optimisticId, info.id, info.acp_session_id);
    if (!session.model && info.models[0]?.id) {
      useSessionStore.getState().setTabModel(info.id, info.models[0].id);
    }
    // Fallback for the race where the disk read was slower than the spawn:
    // only when neither replay nor the immediate load produced anything.
    const replayed = useSessionStore.getState().messages[info.id];
    if (!replayed || replayed.length === 0) {
      const historyMsgs = await getSessionHistoryMessages(session.id, session.cwd).catch(() => []);
      if (
        historyMsgs.length > 0 &&
        (useSessionStore.getState().messages[info.id] || []).length === 0
      ) {
        useSessionStore.getState().loadHistoryMessages(info.id, historyMsgs);
      }
    }
  } catch (e) {
    // Roll the optimistic tab back so retry works: a leftover dead tab would
    // shadow every future click through the existing-tab focus path above.
    useSessionStore.getState().removeTab(optimisticId);
    ui.onError(String(e));
  } finally {
    inFlight.delete(session.id);
  }
  return "started";
}
