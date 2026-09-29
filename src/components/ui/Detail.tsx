import { useId, useState, type ReactNode } from "react";
import { IconButton } from "./Button";

/**
 * Inspector/detail primitives (R4-09 #242): CollapsibleSection + CopyButton.
 * The Inspector (RightPanel) renders high-density technical detail; these give
 * it layered, collapsible, keyboard-accessible sections and a one-click copy
 * for ids/paths/commands so dense info stays reachable and copyable.
 */

/** A disclosure section with a button heading; collapsed content is kept in
 *  the DOM (aria-hidden) so collapsed state is robust in jsdom. Keyboard:
 *  the heading is a real <button>, so Enter/Space toggle it. */
export function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  actions,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Optional controls rendered in the header (e.g. a refresh button). */
  actions?: ReactNode;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-gb-md border gb-border-hairline bg-gb-surface-1">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-gb-xs font-semibold text-gb-text-secondary"
        >
          <span aria-hidden="true" className="text-gb-text-muted">
            {open ? "▾" : "▸"}
          </span>
          {title}
        </button>
        {actions}
      </div>
      {open ? (
        <div id={panelId} className="border-t gb-border-hairline px-3 py-2">
          {children}
        </div>
      ) : (
        <div id={panelId} hidden>
          {children}
        </div>
      )}
    </section>
  );
}

/** Copies a value to the clipboard; announces success/failure via aria-label
 *  title rotation (no toast spam for per-row copy). Keyboard-accessible. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <IconButton
      label={copied ? "已复制" : (label ?? "复制")}
      size="sm"
      onClick={onCopy}
      title={value}
      icon={
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
          {copied ? (
            <path d="m4 8.5 2.5 2.5L12 5" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <>
              <rect x="5" y="5" width="8" height="8" rx="1.5" />
              <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H4a1.5 1.5 0 0 0-1.5 1.5V10A1.5 1.5 0 0 0 4 11.5h1" strokeLinecap="round" />
            </>
          )}
        </svg>
      }
    />
  );
}
