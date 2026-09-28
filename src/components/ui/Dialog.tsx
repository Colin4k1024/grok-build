import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Dialog & Sheet (R4-02 #235): focus trap, Escape to close, focus restored
 * to the trigger on close. No external dependency; works in jsdom tests.
 */

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Visible-focusable filter that also works in jsdom (no layout there, so
 * offsetParent is useless). Excludes hidden attributes, hidden inputs,
 * inline display/visibility hiding and inert subtrees.
 */
function isActuallyFocusable(el: HTMLElement): boolean {
  if (el.closest("[hidden], [inert]")) return false;
  if (el.getAttribute("type") === "hidden") return false;
  if (el.style.display === "none" || el.style.visibility === "hidden") return false;
  return true;
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading — also the dialog's accessible name. */
  title: string;
  children: ReactNode;
  /** Optional extra actions rendered in the header row. */
  headerActions?: ReactNode;
}

interface LayerProps extends DialogProps {
  variant: "modal" | "sheet";
}

function Layer({ open, onClose, title, children, headerActions, variant }: LayerProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus management: move focus inside on open, restore it on close.
  // If the trigger unmounted meanwhile (e.g. row action deleted its row),
  // leave focus where the browser put it instead of forcing it to <body>.
  // Body scroll is locked for the lifetime of the dialog.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialogRef.current;
    const first = root && Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find(isActuallyFocusable);
    (first ?? root)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isActuallyFocusable);
    if (focusables.length === 0) {
      e.preventDefault();
      root.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !root.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  const frameClass =
    variant === "modal"
      ? "fixed inset-0 z-gb-modal flex items-center justify-center"
      : "fixed inset-0 z-gb-modal flex justify-end";
  const panelClass =
    variant === "modal"
      ? "gb-motion-modal-enter relative mx-4 w-full max-w-lg rounded-gb-lg border gb-border-hairline bg-gb-surface-1 shadow-gb-modal outline-none"
      : "gb-motion-panel-enter relative h-full w-full max-w-md border-l gb-border-hairline bg-gb-surface-1 shadow-gb-modal outline-none";

  return createPortal(
    <div className={frameClass} onKeyDown={onKeyDown}>
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        data-testid="dialog-overlay"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={panelClass}
      >
        <div className="flex items-center justify-between border-b gb-border-hairline px-4 py-2.5">
          <h2 id={titleId} className="text-gb-sm font-semibold text-gb-text-primary">
            {title}
          </h2>
          {headerActions}
        </div>
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Centered modal dialog. */
export function Dialog(props: DialogProps) {
  return <Layer {...props} variant="modal" />;
}

/** Right-docked sheet — same a11y behavior, for focused editors. */
export function Sheet(props: DialogProps) {
  return <Layer {...props} variant="sheet" />;
}
