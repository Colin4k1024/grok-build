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
 */
export async function openHistoryThread(session: HistorySession, ui: ResumeUi): Promise<void> {
  const existing = useSessionStore.getState().tabs.find((t) => t.acpSessionId === session.id);
  if (existing) {
    useSessionStore.getState().setActiveSession(existing.id);
    ui.onFocusExisting();
    // Active-writer conflict (ISS-079, codex #43253 semantics): another
    // surface holds the pen — follow the transcript read-only, retry after.
    if (useSessionStore.getState().streaming[existing.id]) ui.onStreamingExisting();
    return;
  }
  if (inFlight.has(session.id)) return;
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

  // Prefetch the on-disk transcript in parallel with the spawn. It is used
  // only when the live replay produced nothing — never merged with a replay
  // (both cover the same history; merging would duplicate the transcript).
  const disk = getSessionHistoryMessages(session.id, session.cwd).catch(() => []);

  try {
    const info = await resumeSession(session.id, session.cwd);
    // The user may have closed the optimistic tab while the spawn was in
    // flight. Honor that immediately: rebinding onto a removed tab would
    // orphan the freshly spawned live session (agent running, no tab).
    if (!useSessionStore.getState().tabs.some((t) => t.id === optimisticId)) {
      closeSession(info.id).catch(() => {});
      return;
    }
    const st = useSessionStore.getState();
    st.finalizeMessages(info.id);
    st.rebindTabId(optimisticId, info.id, info.acp_session_id);
    if (!session.model && info.models[0]?.id) {
      useSessionStore.getState().setTabModel(info.id, info.models[0].id);
    }
    const replayed = useSessionStore.getState().messages[info.id];
    if (!replayed || replayed.length === 0) {
      const historyMsgs = await disk;
      if (historyMsgs.length > 0) {
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
}
