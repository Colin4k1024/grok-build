import type { ReactNode } from "react";

/**
 * PageShell (R4-09 #242): the shared layout frame for full-destination pages
 * (Dashboard, Automations, Agents). It provides consistent canvas padding and
 * an optional toolbar slot above the scrollable content, so every page shares
 * the same title-bar-adjacent chrome (the shell TitleBar already owns the
 * destination label, so pages don't repeat it) and content rhythm.
 *
 * Inspector (RightPanel) is tab-based and doesn't use this shell; it adopts
 * the shared state primitives directly.
 */
export function PageShell({
  toolbar,
  children,
  contentClassName,
}: {
  /** An optional action/filter bar rendered in a stable strip above content. */
  toolbar?: ReactNode;
  children: ReactNode;
  /** Extra classes for the scrollable content region. */
  contentClassName?: string;
}) {
  return (
    <div className="flex h-full flex-col bg-gb-canvas text-gb-text-primary">
      {toolbar ? (
        <div className="flex h-11 shrink-0 items-center gap-2 border-b gb-border-hairline px-4">
          {toolbar}
        </div>
      ) : null}
      {/* contentClassName REPLACES the default (not appends) — Tailwind v3's
         generated CSS order makes appended overrides like `p-0`/`overflow-hidden`
         lose to the base `p-4`/`overflow-y-auto`, so callers that need a
         full-bleed/non-scrolling frame (e.g. master-detail) pass their own
         classes and the default is omitted entirely. */}
      <div className={`flex-1 ${contentClassName ?? "overflow-y-auto p-4"}`}>{children}</div>
    </div>
  );
}

/** A consistent section heading inside a page (replaces ad-hoc `<h3>`s). */
export function PageSectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-gb-xs font-semibold uppercase tracking-wide text-gb-text-muted">
      {children}
    </h3>
  );
}
