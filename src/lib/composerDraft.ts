/**
 * Per-session composer draft persistence (R3-10).
 *
 * Stores the current input text to localStorage so the user's unsent
 * message survives accidental tab switches, window reloads, and crashes.
 *
 * Keys are scoped to session ID so switching tabs restores the right draft.
 */

const DRAFT_PREFIX = "gb-draft-";

export function saveDraft(sessionId: string, text: string): void {
  try {
    if (text.trim()) {
      localStorage.setItem(DRAFT_PREFIX + sessionId, text.slice(0, 4000));
    } else {
      localStorage.removeItem(DRAFT_PREFIX + sessionId);
    }
  } catch { /* storage unavailable */ }
}

export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + sessionId) ?? "";
  } catch {
    return "";
  }
}

export function clearDraft(sessionId: string): void {
  try {
    localStorage.removeItem(DRAFT_PREFIX + sessionId);
  } catch {}
}