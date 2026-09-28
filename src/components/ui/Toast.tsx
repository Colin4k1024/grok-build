import { create } from "zustand";
import { IconButton } from "./Button";

/**
 * Toast system (R4-02 #235): success/error/progress feedback through a
 * single polite live region; errors additionally use role="alert".
 * Success auto-dismisses; error and progress stay until dismissed —
 * failures never vanish before the user has seen them.
 */

export type ToastTone = "success" | "error" | "progress";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id">) => number;
  dismiss: (id: number) => void;
}

let nextToastId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextToastId++;
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    return id;
  },
  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

const SUCCESS_TTL_MS = 4000;

function scheduleAutoDismiss(id: number, ttl: number) {
  timers.set(
    id,
    setTimeout(() => useToastStore.getState().dismiss(id), ttl),
  );
}

export const toast = {
  success(message: string, opts?: { action?: ToastItem["action"] }): number {
    const id = useToastStore.getState().push({ tone: "success", message, action: opts?.action });
    scheduleAutoDismiss(id, SUCCESS_TTL_MS);
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
    useToastStore.getState().dismiss(id);
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
  const path =
    tone === "success" ? "m4 8.5 2.5 2.5L12 5" : "M8 4v5m0 3h.01";
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

/** Mount once near the app root. */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={[
            "gb-motion-toast-enter pointer-events-auto flex items-start gap-2 rounded-gb-md border bg-gb-surface-2 px-3 py-2.5 text-gb-sm text-gb-text-primary shadow-gb-medium",
            TONE_CLASSES[t.tone],
          ].join(" ")}
        >
          <ToastIcon tone={t.tone} />
          <div className="min-w-0 flex-1">
            <div>{t.message}</div>
            {t.action ? (
              <button
                type="button"
                onClick={t.action.onClick}
                className="mt-1 text-gb-xs text-gb-accent-text hover:underline"
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
          <IconButton
            label="关闭通知"
            size="sm"
            onClick={() => dismiss(t.id)}
            icon={
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="m3 3 6 6M9 3l-6 6" strokeLinecap="round" />
              </svg>
            }
          />
        </div>
      ))}
    </div>
  );
}
