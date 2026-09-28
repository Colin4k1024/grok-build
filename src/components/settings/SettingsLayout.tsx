import type { ReactNode } from "react";

/**
 * SettingsLayout (R4-07 #240): category sidebar (grouped) + one stable
 * content region + sticky change bar. Search is handled by the toolbar;
 * the layout just renders what the page gives it.
 */

export interface SettingsCategory {
  id: string;
  label: string;
  /** Group header, e.g. 工作区 / AI / 集成 / 体验 / 安全 / 系统. */
  group: string;
}

export interface SettingsLayoutProps {
  categories: SettingsCategory[];
  active: string;
  onSelect: (id: string) => void;
  toolbar: ReactNode;
  children: ReactNode;
  changeBar?: ReactNode;
}

export function SettingsLayout({
  categories,
  active,
  onSelect,
  toolbar,
  children,
  changeBar,
}: SettingsLayoutProps) {
  const groups: Array<{ group: string; items: SettingsCategory[] }> = [];
  for (const cat of categories) {
    const g = groups.find((x) => x.group === cat.group);
    if (g) g.items.push(cat);
    else groups.push({ group: cat.group, items: [cat] });
  }

  return (
    <div className="flex h-full flex-col bg-gb-canvas text-gb-text-primary">
      {toolbar}
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="设置分类"
          className="w-48 shrink-0 overflow-y-auto border-r gb-border-hairline bg-gb-sidebar p-1.5"
        >
          {groups.map((g) => (
            <div key={g.group} className="mb-2">
              <div className="px-2.5 pb-1 pt-2 text-gb-xs font-medium uppercase tracking-wider text-gb-text-muted">
                {g.group}
              </div>
              {g.items.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  aria-current={active === cat.id ? "page" : undefined}
                  onClick={() => onSelect(cat.id)}
                  className={[
                    "mb-0.5 w-full rounded-gb-md px-2.5 py-1.5 text-left text-gb-xs transition-colors duration-gb-fast ease-gb",
                    active === cat.id
                      ? "bg-gb-accent/15 text-gb-accent-text"
                      : "text-gb-text-secondary hover:bg-gb-surface-hover hover:text-gb-text-primary",
                  ].join(" ")}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {changeBar}
        </div>
      </div>
    </div>
  );
}
