import { forwardRef, useId, type InputHTMLAttributes } from "react";

/**
 * Text inputs with label/description/error wiring (R4-02 #235).
 * Labels are always present — visibly for Input, visually hidden for
 * SearchField (which still exposes a programmatic label).
 */

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Helper text shown under the field. */
  description?: string;
  /** Field-level error; marks the input invalid and is announced. */
  error?: string;
}

const BASE_CLASSES =
  "w-full rounded-gb-md border bg-gb-canvas px-3 py-1.5 text-gb-sm text-gb-text-primary outline-none transition-colors duration-gb-fast ease-gb placeholder:text-gb-text-muted disabled:cursor-not-allowed disabled:opacity-50";
/** Border treatment for a VALID field — control tier + hover + focus accent. */
const VALID_BORDER_CLASSES = "gb-border-control gb-hover-border-control focus:border-gb-accent";
/** Invalid fields get ONLY the danger treatment, so no hover/focus rule can
 *  ever cascade-override the error state (measured in Chromium, R4-02 review). */
const INVALID_BORDER_CLASSES = "gb-border-danger";

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, description, error, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  const descId = `${fieldId}-desc`;
  const errId = `${fieldId}-err`;
  const describedBy = [description ? descId : null, error ? errId : null]
    .filter(Boolean)
    .join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className="text-gb-xs font-medium text-gb-text-secondary">
        {label}
      </label>
      <input
        ref={ref}
        id={fieldId}
        className={[BASE_CLASSES, error ? INVALID_BORDER_CLASSES : VALID_BORDER_CLASSES, className]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {description ? (
        <p id={descId} className="text-gb-xs text-gb-text-muted">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="text-gb-xs text-gb-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export interface SearchFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Programmatic label (visually hidden — the glyph communicates the role). */
  label: string;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { label, id, className, ...rest },
  ref,
) {
  const autoId = useId();
  const fieldId = id ?? autoId;
  return (
    <div className={["relative", className].filter(Boolean).join(" ")}>
      <label htmlFor={fieldId} className="sr-only">
        {label}
      </label>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gb-text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="7" cy="7" r="4.5" />
        <path d="m10.5 10.5 3 3" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        id={fieldId}
        type="search"
        className={[BASE_CLASSES, VALID_BORDER_CLASSES, "pl-8"].join(" ")}
        {...rest}
      />
    </div>
  );
});
