import { useState } from "react";
import { BUILTIN_PRESETS } from "../../config/presets";
import { useSettingsStore } from "../../stores/settingsStore";
import { Button, Dialog, DropdownMenu, Input, SearchField } from "../ui";
import { ScopeSwitcher } from "./ScopeSwitcher";

/**
 * SettingsToolbar (R4-07 #240): search + basic/advanced disclosure + scope
 * switch + presets (builtin + user) + layered reset + import/export.
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
  onSavePreset: (name: string, label: string) => void;
  onDeletePreset: (presetId: string) => void;
  onResetScope: () => void;
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
  onSavePreset,
  onDeletePreset,
  onResetScope,
  onImport,
  onExport,
}: SettingsToolbarProps) {
  const userPresets = useSettingsStore((s) => s.userPresets);
  const [saveOpen, setSaveOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  const presetItems = [
    ...BUILTIN_PRESETS.map((p) => ({
      key: p.id,
      label: `${p.label} — ${p.description}`,
      onSelect: () => onApplyPreset(p.id),
    })),
    ...Object.entries(userPresets).map(([id, p]) => ({
      key: `user:${id}`,
      label: `${p.label}（自定义）`,
      onSelect: () => onApplyPreset(id),
    })),
    ...Object.keys(userPresets).map((id) => ({
      key: `del:${id}`,
      label: `删除预设「${userPresets[id].label}」`,
      danger: true,
      onSelect: () => onDeletePreset(id),
    })),
    {
      key: "__save",
      label: "将当前保存为预设…",
      onSelect: () => setSaveOpen(true),
    },
  ];

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
      <DropdownMenu triggerLabel="预设" items={presetItems} />
      <DropdownMenu
        triggerLabel="重置"
        items={[
          scope === "project"
            ? {
                key: "reset-project",
                label: "重置当前项目的全部覆盖",
                danger: true,
                onSelect: onResetScope,
              }
            : {
                key: "reset-global",
                label: "重置全部全局设置…",
                danger: true,
                onSelect: onResetScope,
              },
        ]}
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

      <Dialog open={saveOpen} onClose={() => setSaveOpen(false)} title="保存为预设">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = presetName.trim();
            if (!name) return;
            onSavePreset(name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"), name);
            setPresetName("");
            setSaveOpen(false);
          }}
          className="space-y-3"
        >
          <Input
            label="预设名称"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            description="保存当前生效的全部设置为可复用预设"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSaveOpen(false)}>
              取消
            </Button>
            <Button size="sm" type="submit" disabled={!presetName.trim()}>
              保存
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
