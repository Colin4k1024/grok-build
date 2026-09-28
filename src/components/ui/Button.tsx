import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * Unified button (R4-02 #235). Variants and states consume R4-01 semantic
 * tokens only; press feedback comes from the motion layer (.gb-motion-press).
 * Compact desktop density keeps a 32px minimum row height.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-gb-accent text-gb-accent-fg hover:opacity-90",
  secondary:
    "border border-gb-border bg-gb-surface-2 text-gb-text-primary hover:bg-gb-surface-hover",
  ghost: "text-gb-text-secondary hover:bg-gb-surface-hover hover:text-gb-text-primary",
  danger: "border border-gb-danger/30 bg-gb-danger/10 text-gb-danger-text hover:bg-gb-danger/20",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-gb-xs",
  md: "h-9 px-3.5 text-gb-sm",
};

const BASE_CLASSES =
  "gb-motion-press inline-flex select-none items-center justify-center gap-1.5 rounded-gb-md font-medium transition-colors duration-gb-fast ease-gb disabled:cursor-not-allowed disabled:opacity-40";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, disables interaction and announces aria-busy. */
  loading?: boolean;
  /** Decorative leading icon (rendered aria-hidden). */
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={[BASE_CLASSES, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name — required because the button has no visible text. */
  label: string;
  icon: ReactNode;
  size?: "sm" | "md";
}

/** Icon-only button: 32px desktop target with a required accessible label. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = "md", className, ...rest },
  ref,
) {
  const sizeClass = size === "sm" ? "h-7 w-7" : "h-8 w-8";
  return (
    <button
      ref={ref}
      aria-label={label}
      title={rest.title ?? label}
      className={[
        "gb-motion-press inline-flex shrink-0 select-none items-center justify-center rounded-gb-md text-gb-text-secondary transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover hover:text-gb-text-primary disabled:cursor-not-allowed disabled:opacity-40",
        sizeClass,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
    </button>
  );
});
