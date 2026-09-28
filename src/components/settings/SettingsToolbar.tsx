import { BUILTIN_PRESETS } from "../../config/presets";
import { DropdownMenu, SearchField } from "../ui";
import { ScopeSwitcher } from "./ScopeSwitcher";

/**
 * SettingsToolbar (R4-07 #240): search + basic/advanced disclosure + scope
 * switch + presets + import/export — one toolbar for the whole center.
 */

export interface SettingsToolbarProps {
  query: string;
  onQuery: (q: string) => void;
  matchCount: number;
  advanced: boolean;
  onToggleAdvanced: () => void;
  scope: "global" | "project";
  onScopeChange: (scope: "global" | "project") => void;
  projectName?: string;
  onApplyPreset: (presetId: string) => void;
  onImport: () => void;
  onExport: () => void;
}

export function SettingsToolbar({
  query,
  onQuery,
  matchCount,
  advanced,
  onToggleAdvanced,
  scope,
  onScopeChange,
  projectName,
  onApplyPreset,
  onImport,
  onExport,
}: SettingsToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b gb-border-hairline px-4 py-2">
      <div className="w-56">
        <SearchField
          label="搜索设置"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="搜索设置…"
        />
      </div>
      {query.trim() && (
        <span className="text-gb-xs text-gb-text-muted" role="status">
          {matchCount} 项匹配
        </span>
      )}
      <div className="flex-1" />
      <ScopeSwitcher scope={scope} onScopeChange={onScopeChange} projectName={projectName} />
      <DropdownMenu
        triggerLabel="预设"
        items={BUILTIN_PRESETS.map((p) => ({
          key: p.id,
          label: `${p.label} — ${p.description}`,
          onSelect: () => onApplyPreset(p.id),
        }))}
      />
      <button
        type="button"
        onClick={onToggleAdvanced}
        aria-pressed={advanced}
        className="rounded-gb-md px-2.5 py-1.5 text-gb-xs text-gb-text-secondary transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover hover:text-gb-text-primary"
      >
        高级{advanced ? " ✓" : ""}
      </button>
      <button
        type="button"
        onClick={onExport}
        className="rounded-gb-md px-2.5 py-1.5 text-gb-xs text-gb-text-secondary transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover hover:text-gb-text-primary"
      >
        导出
      </button>
      <button
        type="button"
        onClick={onImport}
        className="rounded-gb-md px-2.5 py-1.5 text-gb-xs text-gb-text-secondary transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover hover:text-gb-text-primary"
      >
        导入
      </button>
    </div>
  );
}
