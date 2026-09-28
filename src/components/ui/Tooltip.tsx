import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Tooltip (R4-02 #235): hover (with a short delay, 400 ms by default) and
 * keyboard focus both reveal the tip; Escape or blur hides it. The child's
 * own event handlers are composed, never overwritten. The tip is portaled
 * to <body> and positioned from the trigger rect, so overflow-hidden
 * ancestors never clip it. Tooltips annotate — they never carry actions.
 * Designed for inline interactive triggers (buttons, links).
 */

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  /** Hover delay in ms; keyboard focus shows immediately. */
  delay?: number;
}

type ChildHandlers = {
  onMouseEnter?: (e: unknown) => void;
  onMouseLeave?: (e: unknown) => void;
  onFocus?: (e: unknown) => void;
  onBlur?: (e: unknown) => void;
  onKeyDown?: (e: unknown) => void;
  "aria-describedby"?: string;
};

export function Tooltip({ content, children, delay = 400 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const tooltipId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top?: number; bottom?: number } | null>(
    null,
  );

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // No timer may survive unmount.
  useEffect(() => clearTimer, []);

  const show = () => {
    const box = anchorRef.current?.getBoundingClientRect();
    if (box) {
      // Flip below the trigger when there is no room above it.
      // 34 = approx tip height (26) + gap (6) + a small safety margin.
      const flipBelow = box.top < 34;
      // Clamp the center horizontally so a long tip never leaves the viewport.
      const center = Math.min(Math.max(box.left + box.width / 2, 80), window.innerWidth - 80);
      setPlacement(
        flipBelow
          ? { left: center, top: box.bottom + 6 }
          : { left: center, bottom: window.innerHeight - box.top + 6 },
      );
    }
    setVisible(true);
  };
  const showDelayed = () => {
    clearTimer();
    timer.current = setTimeout(show, delay);
  };
  const showNow = () => {
    clearTimer();
    show();
  };
  const hide = () => {
    clearTimer();
    setVisible(false);
  };

  // A tooltip is transient context — hide on scroll/resize instead of
  // floating detached from its anchor.
  useEffect(() => {
    if (!visible) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [visible]);

  if (!isValidElement(children)) return children;

  const childProps = (children as ReactElement<ChildHandlers>).props;
  // When the child already has an identical accessible name, the tooltip is
  // purely visual — don't double-announce via aria-describedby.
  const childLabel = (children as ReactElement<Record<string, unknown>>).props["aria-label"];
  const redundant = typeof childLabel === "string" && childLabel === content;
  const compose =
    (ours: () => void, theirs?: (e: unknown) => void) =>
    (e: unknown) => {
      theirs?.(e);
      ours();
    };

  const child = cloneElement(children as ReactElement<ChildHandlers>, {
    onMouseEnter: compose(showDelayed, childProps.onMouseEnter),
    onMouseLeave: compose(hide, childProps.onMouseLeave),
    onFocus: compose(showNow, childProps.onFocus),
    onBlur: compose(hide, childProps.onBlur),
    onKeyDown: (e: unknown) => {
      childProps.onKeyDown?.(e);
      if ((e as { key?: string }).key === "Escape" && visible) {
        // Topmost-layer rule: hiding the tooltip must not close a dialog.
        (e as { stopPropagation?: () => void }).stopPropagation?.();
        hide();
      }
    },
    "aria-describedby": redundant
      ? childProps["aria-describedby"]
      : [childProps["aria-describedby"], visible ? tooltipId : null].filter(Boolean).join(" ") ||
        undefined,
  });

  return (
    <>
      <span ref={anchorRef} className="relative inline-flex">
        {child}
      </span>
      {visible && placement
        ? createPortal(
            <span
              role="tooltip"
              id={tooltipId}
              style={{ top: placement.top, bottom: placement.bottom, left: placement.left }}
              className="gb-motion-popover-enter pointer-events-none fixed z-gb-popover -translate-x-1/2 whitespace-nowrap rounded-gb-sm border gb-border-hairline bg-gb-surface-2 px-2 py-1 text-gb-xs text-gb-text-primary shadow-gb-low"
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
