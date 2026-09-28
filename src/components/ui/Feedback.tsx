import type { ReactNode } from "react";

/**
 * Feedback primitives (R4-02 #235): InlineNotice, EmptyState, Skeleton.
 * Status is always conveyed by icon + text, never color alone.
 */

export type NoticeTone = "info" | "success" | "warning" | "danger";

const NOTICE_CLASSES: Record<NoticeTone, string> = {
  info: "border-gb-info/40 bg-gb-info/10 text-gb-info-text",
  success: "border-gb-success/40 bg-gb-success/10 text-gb-success-text",
  warning: "border-gb-warning/40 bg-gb-warning/10 text-gb-warning-text",
  danger: "border-gb-danger/40 bg-gb-danger/10 text-gb-danger-text",
};

const NOTICE_ICONS: Record<NoticeTone, string> = {
  info: "M8 7v4m0-7h.01M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z",
  success: "m4 8.5 2.5 2.5L12 5",
  warning: "M8 5v3m0 3h.01M7.1 2.3 1.9 12a1 1 0 0 0 .9 1.5h10.4a1 1 0 0 0 .9-1.5L8.9 2.3a1 1 0 0 0-1.8 0Z",
  danger: "M8 5v3m0 3h.01M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z",
};

export function InlineNotice({
  tone,
  title,
  children,
}: {
  tone: NoticeTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={[
        "flex items-start gap-2 rounded-gb-md border px-3 py-2 text-gb-sm",
        NOTICE_CLASSES[tone],
      ].join(" ")}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="mt-0.5 h-3.5 w-3.5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={NOTICE_ICONS[tone]} />
      </svg>
      <div className="min-w-0">
        {title ? <div className="font-medium">{title}</div> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
      {icon ? (
        <div aria-hidden="true" className="mb-1 text-gb-text-muted">
          {icon}
        </div>
      ) : null}
      <div className="text-gb-sm font-medium text-gb-text-primary">{title}</div>
      {description ? <div className="text-gb-xs text-gb-text-muted">{description}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Loading placeholder; decorative and hidden from assistive tech. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={["gb-skeleton", className].filter(Boolean).join(" ")} />;
}
