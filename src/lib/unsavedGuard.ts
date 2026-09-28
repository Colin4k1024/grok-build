/**
 * Unsaved-changes guard registry (R4-07 #240): a page with staged edits
 * registers a guard; navigation consults it before leaving. One guard at a
 * time (only one settings page exists).
 */

let guard: (() => string | null) | null = null;

/** Register (or clear) the unsaved-changes guard. Returns a cleanup fn. */
export function setUnsavedGuard(fn: (() => string | null) | null): () => void {
  guard = fn;
  return () => {
    if (guard === fn) guard = null;
  };
}

/**
 * Consult the guard. Returns true when navigation may proceed. Shows a
 * confirm dialog with the guard's message when edits are pending.
 */
export function confirmLeaveIfDirty(): boolean {
  if (!guard) return true;
  const message = guard();
  if (!message) return true;
  return window.confirm(`${message} — 确定离开？未保存的修改将丢失。`);
}
