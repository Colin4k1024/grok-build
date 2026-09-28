import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

/**
 * DropdownMenu (R4-02 #235): arrow-key navigation with disabled-item
 * skipping, Enter/Space select, Escape closes (without propagating to an
 * enclosing Dialog) and refocuses the trigger. The menu is portaled to
 * <body> and tracks its trigger across scroll/resize, flipping above the
 * trigger when there is no room below.
 */

export interface MenuPlacement {
  top: number;
  left?: number;
  right?: number;
  /** True when flipped above the trigger (no room below). */
  flipped: boolean;
}

/** Pure placement math, exported for tests. Viewport units throughout. */
export function computeMenuPlacement(
  trigger: { top: number; bottom: number; left: number; right: number },
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
  align: "left" | "right",
): MenuPlacement {
  const gap = 4;
  const below = trigger.bottom + gap;
  const flipped =
    below + menuSize.height > viewport.height - 8 && trigger.top - gap - menuSize.height > 0;
  const unclampedLeft = align === "left" ? trigger.left : undefined;
  return {
    top: flipped ? Math.max(8, trigger.top - gap - menuSize.height) : below,
    left:
      unclampedLeft === undefined
        ? undefined
        : Math.max(8, Math.min(unclampedLeft, viewport.width - menuSize.width - 8)),
    right: align === "right" ? Math.max(8, viewport.width - trigger.right) : undefined,
    flipped,
  };
}

export interface DropdownMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface DropdownMenuProps {
  /** Accessible label for the trigger button. */
  triggerLabel: string;
  items: DropdownMenuItem[];
  /** Optional visible trigger content; defaults to triggerLabel text. */
  trigger?: React.ReactNode;
  align?: "left" | "right";
}

export function DropdownMenu({ triggerLabel, items, trigger, align = "left" }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPlacement>({ top: 0, left: 0, flipped: false });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  itemRefs.current.length = items.length;
  const enabledIndexes = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const focusItem = (index: number) => {
    itemRefs.current[index]?.focus();
  };

  const focusFirst = () => {
    if (enabledIndexes.length > 0) focusItem(enabledIndexes[0]);
  };

  // Position from the trigger rect; track scroll/resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuHeight = menuRef.current?.offsetHeight ?? items.length * 30 + 8;
      const menuWidth = menuRef.current?.offsetWidth ?? 160;
      setPos(
        computeMenuPlacement(
          rect,
          { width: menuWidth, height: menuHeight },
          { width: window.innerWidth, height: window.innerHeight },
          align,
        ),
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, align, items.length]);

  // Focus discipline: when the menu opens, focus moves to the first enabled
  // item; if the item set changes while open (async load, shrink) and the
  // active element fell out of the menu, re-anchor to the first item.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    const justOpened = !wasOpen.current;
    wasOpen.current = true;
    const active = document.activeElement;
    const inside = menuRef.current?.contains(active) ?? false;
    const anchorDisconnected = inside && active instanceof HTMLElement && !active.isConnected;
    if (justOpened || !inside || anchorDisconnected) focusFirst();
  }, [open, items]);

  // Click-away closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = itemRefs.current.findIndex((el) => el === document.activeElement);
    const currentEnabledPos = enabledIndexes.indexOf(currentIndex);
    if (e.key === "Escape") {
      // Topmost-layer rule: closing the menu must not close an enclosing dialog.
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = enabledIndexes[(currentEnabledPos + 1) % enabledIndexes.length];
      if (next !== undefined) focusItem(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const prev =
        enabledIndexes[(currentEnabledPos - 1 + enabledIndexes.length) % enabledIndexes.length];
      if (prev !== undefined) focusItem(prev);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusFirst();
    } else if (e.key === "End") {
      e.preventDefault();
      const last = enabledIndexes[enabledIndexes.length - 1];
      if (last !== undefined) focusItem(last);
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (currentIndex >= 0) {
        const item = items[currentIndex];
        if (!item.disabled) {
          close();
          item.onSelect();
        }
      }
    }
  };

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        className="gb-motion-press inline-flex h-8 items-center gap-1 rounded-gb-md px-2.5 text-gb-xs text-gb-text-secondary transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover hover:text-gb-text-primary"
      >
        {trigger ?? triggerLabel}
        <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="m3 4.5 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={triggerLabel}
              onKeyDown={onMenuKeyDown}
              style={{
                top: pos.top,
                left: pos.left,
                right: pos.right,
              }}
              className="gb-motion-popover-enter fixed z-gb-dropdown max-h-[70vh] min-w-[10rem] overflow-y-auto rounded-gb-md border gb-border-hairline bg-gb-surface-2 p-1 shadow-gb-medium"
            >
              {items.map((item, i) => (
                <button
                  key={item.key}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  tabIndex={-1}
                  onClick={() => {
                    if (item.disabled) return;
                    close();
                    item.onSelect();
                  }}
                  className={[
                    "flex w-full items-center rounded-gb-sm px-2.5 py-1.5 text-left text-gb-xs transition-colors duration-gb-fast ease-gb",
                    item.danger
                      ? "text-gb-danger-text hover:bg-gb-danger/15"
                      : "text-gb-text-primary hover:bg-gb-surface-hover",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                  ].join(" ")}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
