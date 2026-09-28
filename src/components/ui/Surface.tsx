import type { HTMLAttributes, ReactNode } from "react";

/**
 * Surface primitives (R4-02 #235): Card and Panel — the only sanctioned
 * containers, so pages stop inventing one-off card/border patterns.
 */

export function Card({
  interactive = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={[
        "rounded-gb-md border border-gb-border bg-gb-surface-1 shadow-gb-low",
        interactive
          ? "transition-colors duration-gb-fast ease-gb hover:border-gb-border-control hover:bg-gb-surface-hover"
          : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Panel({
  title,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={["rounded-gb-md border border-gb-border bg-gb-surface-1", className]
        .filter(Boolean)
        .join(" ")}
    >
      {title || actions ? (
        <header className="flex items-center justify-between border-b border-gb-border/10 px-3 py-2">
          <h3 className="text-gb-xs font-semibold text-gb-text-secondary">{title}</h3>
          {actions}
        </header>
      ) : null}
      <div className="p-3">{children}</div>
    </section>
  );
}
