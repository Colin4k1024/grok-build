import {
  cloneElement,
  isValidElement,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * Tooltip (R4-02 #235): hover (400ms delay) and keyboard focus both reveal
 * the tip; Escape/Escape-blur hides it. Tooltips never carry critical
 * actions — they annotate, they don't gate.
 */

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  /** Hover delay in ms; keyboard focus shows immediately. */
  delay?: number;
}

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

  const child = cloneElement(children as ReactElement<Record<string, unknown>>, {
    onMouseEnter: showDelayed,
    onMouseLeave: hide,
    onFocus: showNow,
    onBlur: hide,
    "aria-describedby": visible ? tooltipId : undefined,
  });

  return (
    <span className="relative inline-flex">
      {child}
      {visible ? (
        <span
          role="tooltip"
          id={tooltipId}
          className="gb-motion-toast-enter pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-gb-sm border border-gb-border bg-gb-surface-2 px-2 py-1 text-gb-xs text-gb-text-primary shadow-gb-low"
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
