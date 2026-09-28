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

/**
 * Tooltip (R4-02 #235): hover (with a short delay, 400 ms by default) and
 * keyboard focus both reveal the tip; Escape or blur hides it. The child's
 * own event handlers are composed, never overwritten. Tooltips annotate —
 * they never carry critical actions.
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

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // No timer may survive unmount.
  useEffect(() => clearTimer, []);

  const showDelayed = () => {
    clearTimer();
    timer.current = setTimeout(() => setVisible(true), delay);
  };
  const showNow = () => {
    clearTimer();
    setVisible(true);
  };
  const hide = () => {
    clearTimer();
    setVisible(false);
  };

  if (!isValidElement(children)) return children;

  const childProps = (children as ReactElement<ChildHandlers>).props;
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
      if ((e as { key?: string }).key === "Escape") hide();
    },
    "aria-describedby": [childProps["aria-describedby"], visible ? tooltipId : null]
      .filter(Boolean)
      .join(" ") || undefined,
  });

  return (
    <span className="relative inline-flex">
      {child}
      {visible ? (
        <span
          role="tooltip"
          id={tooltipId}
          className="gb-motion-popover-enter pointer-events-none absolute bottom-full left-1/2 z-gb-popover mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-gb-sm border gb-border-hairline bg-gb-surface-2 px-2 py-1 text-gb-xs text-gb-text-primary shadow-gb-low"
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
