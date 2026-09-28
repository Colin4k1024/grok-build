import { useId, useRef, type KeyboardEvent } from "react";

/**
 * Switch / Select / SegmentedControl (R4-02 #235) — token-driven form
 * controls with full keyboard behavior.
 */

export interface SwitchProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Extra hint rendered under the label. */
  description?: string;
  /** Visually hide the label (still the accessible name) — for rows that
   *  render their own visible label (e.g. SettingsField). */
  hideLabel?: boolean;
}

/** Toggle switch with role="switch"; a real <button>, so Space/Enter work. */
export function Switch({ label, checked, onCheckedChange, disabled, description, hideLabel }: SwitchProps) {
  const labelId = useId();
  const descId = useId();
  if (hideLabel) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={[
          "gb-motion-press relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-gb-fast ease-gb disabled:cursor-not-allowed disabled:opacity-40",
          checked ? "bg-gb-accent" : "bg-gb-control-track",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className="inline-block h-4 w-4 rounded-full bg-gb-accent-fg transition-transform duration-gb-fast ease-gb"
          style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
        />
      </button>
    );
  }
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span id={labelId} className="text-gb-sm text-gb-text-primary">
          {label}
        </span>
        {description ? (
          <p id={descId} className="mt-0.5 text-gb-xs text-gb-text-muted">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={[
          "gb-motion-press relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-gb-fast ease-gb disabled:cursor-not-allowed disabled:opacity-40",
          checked ? "bg-gb-accent" : "bg-gb-control-track",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className="inline-block h-4 w-4 rounded-full bg-gb-accent-fg transition-transform duration-gb-fast ease-gb"
          style={{ transform: checked ? "translateX(18px)" : "translateX(2px)" }}
        />
      </button>
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  id?: string;
  /** Visually hide the label (still the control's accessible name). */
  hideLabel?: boolean;
}

/** Labeled native <select> — full keyboard semantics come for free. */
export function Select({ label, value, onChange, options, disabled, id, hideLabel }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={selectId} className={hideLabel ? "sr-only" : "text-gb-xs font-medium text-gb-text-secondary"}>
        {label}
      </label>
      <select
        id={selectId}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-gb-md border gb-border-control gb-hover-border-control bg-gb-canvas px-2.5 py-1.5 text-gb-sm text-gb-text-primary outline-none transition-colors duration-gb-fast ease-gb focus:border-gb-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface SegmentedControlProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  /** Visually hide the label (still the group's accessible name). */
  hideLabel?: boolean;
}

/**
 * Segmented control as a radiogroup with roving tabindex:
 * Arrow keys move (skipping disabled), Enter/Space selects, Home/End jump.
 */
export function SegmentedControl({ label, value, onChange, options, disabled, hideLabel }: SegmentedControlProps) {
  const labelId = useId();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, delta: number) => {
    // skip disabled options
    let next = from;
    for (let step = 0; step < options.length; step++) {
      next = (next + delta + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    itemRefs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (index === -1) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(index, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(index, -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      itemRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      itemRefs.current[options.length - 1]?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className={hideLabel ? "sr-only" : "text-gb-xs font-medium text-gb-text-secondary"}>
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        className="inline-flex gap-0.5 rounded-gb-md border gb-border-hairline bg-gb-canvas p-0.5"
      >
        {options.map((o, i) => {
          const selected = o.value === value;
          // Roving tabindex with a first-ENABLED-item fallback: if `value`
          // matches no enabled option, the first enabled option stays
          // keyboard-reachable instead of the group becoming unreachable.
          const enabled = options.filter((opt) => !opt.disabled);
          const anySelected = enabled.some((opt) => opt.value === value);
          const tabbable = anySelected ? selected : enabled[0] === o;
          return (
            <button
              key={o.value}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={tabbable ? 0 : -1}
              disabled={disabled || o.disabled}
              onClick={() => onChange(o.value)}
              className={[
                "gb-motion-press rounded-gb-sm px-2.5 py-1 text-gb-xs transition-colors duration-gb-fast ease-gb disabled:cursor-not-allowed disabled:opacity-40",
                selected
                  ? "bg-gb-accent/15 text-gb-accent-text"
                  : "text-gb-text-muted hover:bg-gb-surface-hover hover:text-gb-text-primary",
              ].join(" ")}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
