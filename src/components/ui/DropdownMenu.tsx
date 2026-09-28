import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

/**
 * DropdownMenu (R4-02 #235): arrow-key navigation with disabled-item
 * skipping, Enter/Space select, Escape closes and refocuses the trigger.
 * Focus is real DOM focus (roving), not aria-activedescendant, so screen
 * readers announce the active item.
 */

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

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

  // Focus the first enabled item once the menu mounts (works in jsdom,
  // unlike requestAnimationFrame).
  useEffect(() => {
    if (open) focusFirst();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Click-away closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      e.preventDefault();
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
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={triggerLabel}
          onKeyDown={onMenuKeyDown}
          className={[
            "gb-motion-panel-enter absolute z-40 mt-1 min-w-[10rem] rounded-gb-md border border-gb-border bg-gb-surface-2 p-1 shadow-gb-medium",
            align === "right" ? "right-0" : "left-0",
          ].join(" ")}
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
        </div>
      ) : null}
    </div>
  );
}
