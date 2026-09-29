import { create } from "zustand";
import { MOTION_DURATIONS, exitDuration, prefersReducedMotion, transitionFor } from "../../lib/motion";
import { IconButton } from "./Button";

/**
 * Toast system (R4-02 #235): success/error/progress feedback. Announcement
 * semantics: ONE polite live region for success/progress and ONE assertive
 * region for errors — items themselves carry no role, so live regions are
 * never nested. Success auto-dismisses; error and progress stay until
 * dismissed (failures never vanish before the user has seen them).
 * Dismissal animates out at ~65% of the entry duration (R4-01 exit rule),
 * instantly under reduced motion.
 */

export type ToastTone = "success" | "error" | "progress";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  action?: { label: string; onClick: () => void };
  /** Set while the exit transition runs, right before removal. */
  exiting?: boolean;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id">) => number;
  beginExit: (id: number) => void;
  remove: (id: number) => void;
}

let nextToastId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextToastId++;
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    return id;
  },
  beginExit: (id) =>
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, exiting: true } : t)) })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const EXIT_MS = exitDuration(MOTION_DURATIONS.base);
const SUCCESS_TTL_MS = 4000;

function scheduleDismiss(id: number, ttl: number) {
  clearTimer(id);
  timers.set(
    id,
    setTimeout(() => toast.dismiss(id), ttl),
  );
}

export const toast = {
  success(message: string, opts?: { action?: ToastItem["action"]; ttlMs?: number }): number {
    const id = useToastStore.getState().push({ tone: "success", message, action: opts?.action });
    // Undoable actions get a longer window — 4s is too short to recover.
    scheduleDismiss(id, opts?.ttlMs ?? (opts?.action ? 10_000 : SUCCESS_TTL_MS));
    return id;
  },
  error(message: string, opts?: { action?: ToastItem["action"] }): number {
    // Errors are sticky by design — an unactionable toast that disappears
    // is exactly the failure mode R4 forbids.
    return useToastStore.getState().push({ tone: "error", message, action: opts?.action });
  },
  progress(message: string): number {
    return useToastStore.getState().push({ tone: "progress", message });
  },
  dismiss(id: number): void {
    clearTimer(id);
    const { beginExit, remove } = useToastStore.getState();
    if (prefersReducedMotion()) {
      remove(id);
      return;
    }
    beginExit(id);
    timers.set(
      id,
      setTimeout(() => {
        clearTimer(id);
        remove(id);
      }, EXIT_MS),
    );
  },
};

const TONE_CLASSES: Record<ToastTone, string> = {
  success: "border-gb-success/40",
  error: "border-gb-danger/50",
  progress: "border-gb-accent/40",
};

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === "progress") {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-gb-accent border-t-transparent"
      />
    );
  }
  const path = tone === "success" ? "m4 8.5 2.5 2.5L12 5" : "M8 4v5m0 3h.01";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={
        tone === "success"
          ? "mt-0.5 h-3.5 w-3.5 shrink-0 text-gb-success-text"
          : "mt-0.5 h-3.5 w-3.5 shrink-0 text-gb-danger-text"
      }
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d={path} />
    </svg>
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  return (
    <div
      className={[
        "gb-motion-toast-enter pointer-events-auto flex items-start gap-2 rounded-gb-md border bg-gb-surface-2 px-3 py-2.5 text-gb-sm text-gb-text-primary shadow-gb-medium",
        TONE_CLASSES[item.tone],
      ].join(" ")}
      style={
        item.exiting
          ? { transition: transitionFor(["opacity"], EXIT_MS), opacity: 0 }
          : undefined
      }
    >
      <ToastIcon tone={item.tone} />
      <div className="min-w-0 flex-1">
        <div>{item.message}</div>
        {item.action ? (
          <button
            type="button"
            onClick={item.action.onClick}
            className="mt-1 text-gb-xs text-gb-accent-text hover:underline"
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <IconButton
        label="关闭通知"
        size="sm"
        onClick={() => toast.dismiss(item.id)}
        icon={
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="m3 3 6 6M9 3l-6 6" strokeLinecap="round" />
          </svg>
        }
      />
    </div>
  );
}

/** Mount once near the app root. One fixed stack containing two flat live
 *  regions (assertive errors render above polite items) — never nested,
 *  never overlapping. */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const polite = toasts.filter((t) => t.tone !== "error");
  const assertive = toasts.filter((t) => t.tone === "error");
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-gb-toast flex w-80 flex-col gap-2">
      <div aria-live="assertive" className="flex flex-col gap-2">
        {assertive.map((t) => (
          <ToastCard key={t.id} item={t} />
        ))}
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        {polite.map((t) => (
          <ToastCard key={t.id} item={t} />
        ))}
      </div>
    </div>
  );
}
