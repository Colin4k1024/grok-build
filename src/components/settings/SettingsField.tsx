import { useEffect, useMemo, useState } from "react";
import { getSetting } from "../../config/registry";
import { resolveFromStore } from "../../config/storeBridge";
import type { SettingScope, SettingSource } from "../../config/types";
import { useSettingsStore } from "../../stores/settingsStore";
import { Select, SegmentedControl, Switch } from "../ui";
import { SettingSourceBadge } from "./SettingSourceBadge";

/**
 * SettingsField (R4-07 #240): one settings row driven ENTIRELY by the
 * registry — label/description/control/source/validation/reset all come
 * from the setting definition. Pages never redeclare defaults. Subscribes
 * to the exact store slices so preset/reset/import/sync writes re-render
 * the row immediately.
 */

export interface SettingsFieldProps {
  settingId: string;
  /** Current editing scope. */
  scope: "global" | "project";
  /** Active project (for project scope). */
  projectId?: string;
  /** Draft override value (staged editing), if any. */
  draft?: unknown;
  /** Validation error for the draft, if any. */
  error?: string;
  onChange: (settingId: string, value: unknown) => void;
  onReset: (settingId: string) => void;
}

export function SettingsField({
  settingId,
  scope,
  projectId,
  draft,
  error,
  onChange,
  onReset,
}: SettingsFieldProps) {
  const def = getSetting(settingId);
  // Reactive store slices — the row re-renders when either layer changes.
  const flatValue = useSettingsStore((s) =>
    def?.storeKey ? (s as unknown as Record<string, unknown>)[def.storeKey] : undefined,
  );
  const projectValue = useSettingsStore((s) =>
    projectId ? s.projectOverrides[projectId]?.[settingId] : undefined,
  );
  const resolved = useMemo(
    () => (def ? resolveFromStore(settingId, projectId) : null),
    [def, settingId, projectId, flatValue, projectValue],
  );
  // Number fields keep a local text buffer: intermediate keystrokes are
  // never validated/toasted; commit happens on blur/Enter when valid.
  const [numText, setNumText] = useState<string | null>(null);
  const [numError, setNumError] = useState<string | null>(null);
  useEffect(() => {
    setNumText(null);
    setNumError(null);
  }, [flatValue, projectValue, scope, draft]);

  if (!def || !resolved) return null;

  const scopeAllowed = def.scopes.includes(scope as SettingScope);
  const current = draft !== undefined ? draft : resolved.value;
  const shownError = error ?? numError;
  // 重置 is only meaningful where a value exists at THIS scope: in project
  // scope that means a project override (or a draft), not a global layer.
  const hasProjectLayer = projectValue !== undefined && projectValue !== null;
  const showReset =
    draft !== undefined || (scope === "project" ? hasProjectLayer : resolved.overridden);

  const commitNumber = () => {
    if (numText === null) return;
    const v = Number(numText);
    if (numText.trim() === "" || Number.isNaN(v) || !def.validate(v)) {
      setNumError(`有效范围：${def.numberRange?.min ?? "-"} ~ ${def.numberRange?.max ?? "-"}`);
      return; // keep editing — never throw a toast for keystrokes
    }
    setNumError(null);
    setNumText(null);
    onChange(settingId, v);
  };

  return (
    <div
      data-testid={`setting-field-${settingId}`}
      className="flex items-start justify-between gap-4 border-b gb-border-hairline py-2.5 last:border-b-0"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-gb-sm text-gb-text-primary">{def.label}</span>
          <SettingSourceBadge source={draft !== undefined ? (scope as SettingSource) : resolved.source} />
          {draft !== undefined && (
            <span className="rounded-gb-sm bg-gb-warning/15 px-1.5 py-0.5 text-gb-xs text-gb-warning-text">
              未保存
            </span>
          )}
          {def.requiresRestart && (
            <span className="rounded-gb-sm bg-gb-warning/15 px-1.5 py-0.5 text-gb-xs text-gb-warning-text">
              需重启
            </span>
          )}
        </div>
        <p className="mt-0.5 text-gb-xs text-gb-text-muted">{def.description}</p>
        {shownError ? (
          <p role="alert" className="mt-0.5 text-gb-xs text-gb-danger-text">
            {shownError}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!scopeAllowed && (
          <span className="text-gb-xs text-gb-text-muted">仅全局</span>
        )}
        {def.type === "enum" && (
          scopeAllowed ? (
            (def.enumValues?.length ?? 0) <= 3 ? (
              <SegmentedControl
                label={def.label}
                hideLabel
                value={String(current)}
                onChange={(v) => onChange(settingId, v)}
                options={(def.enumValues ?? []).map((v) => ({
                  value: String(v),
                  label: enumLabel(def, String(v)),
                }))}
              />
            ) : (
              <Select
                label={def.label}
                hideLabel
                value={String(current)}
                onChange={(v) => onChange(settingId, v)}
                options={(def.enumValues ?? []).map((v) => ({
                  value: String(v),
                  label: enumLabel(def, String(v)),
                }))}
              />
            )
          ) : (
            <span className="text-gb-sm text-gb-text-secondary">{enumLabel(def, String(current))}</span>
          )
        )}
        {def.type === "boolean" &&
          (scopeAllowed ? (
            <Switch
              label={def.label}
              hideLabel
              checked={Boolean(current)}
              onCheckedChange={(v) => onChange(settingId, v)}
            />
          ) : (
            <span className="text-gb-sm text-gb-text-secondary">{current ? "开" : "关"}</span>
          ))}
        {def.type === "number" && (
          <div className="flex items-center gap-1.5">
            {def.quickValues && (
              <div className="flex gap-0.5">
                {def.quickValues.map((v) => (
                  <button
                    key={v}
                    type="button"
                    disabled={!scopeAllowed}
                    onClick={() => onChange(settingId, v)}
                    className={[
                      "rounded-gb-sm px-1.5 py-0.5 text-gb-xs transition-colors duration-gb-fast ease-gb",
                      Number(current) === v
                        ? "bg-gb-accent/15 text-gb-accent-text"
                        : "text-gb-text-muted hover:bg-gb-surface-hover hover:text-gb-text-primary",
                    ].join(" ")}
                  >
                    {Math.round(v * 100)}%
                  </button>
                ))}
              </div>
            )}
            <input
              type="number"
              aria-label={def.label}
              aria-invalid={shownError ? true : undefined}
              disabled={!scopeAllowed}
              className="w-20 rounded-gb-md border gb-border-control bg-gb-canvas px-2 py-1 text-gb-sm text-gb-text-primary outline-none focus:border-gb-accent"
              value={numText ?? String(current)}
              step={def.numberRange?.step ?? 0.05}
              min={def.numberRange?.min}
              max={def.numberRange?.max}
              onChange={(e) => setNumText(e.target.value)}
              onBlur={commitNumber}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNumber();
                if (e.key === "Escape") {
                  setNumText(null);
                  setNumError(null);
                }
              }}
            />
          </div>
        )}
        {def.type === "string" && (
          <input
            type="text"
            aria-label={def.label}
            disabled={!scopeAllowed}
            className="w-44 rounded-gb-md border gb-border-control bg-gb-canvas px-2 py-1 text-gb-sm text-gb-text-primary outline-none focus:border-gb-accent"
            value={String(current)}
            onChange={(e) => onChange(settingId, e.target.value)}
          />
        )}
        {def.type === "string[]" && (
          <span className="text-gb-xs text-gb-text-muted">
            {Array.isArray(current) ? `${current.length} 项（在分区中管理）` : "—"}
          </span>
        )}
        {showReset && (
          <button
            type="button"
            onClick={() => onReset(settingId)}
            title="重置为默认"
            aria-label={`重置 ${def.label}`}
            className="rounded-gb-sm px-1 py-0.5 text-gb-xs text-gb-text-muted transition-colors duration-gb-fast ease-gb hover:bg-gb-surface-hover hover:text-gb-text-primary"
          >
            重置
          </button>
        )}
      </div>
    </div>
  );
}

/** Enum value → display label from the schema's enumLabels (registry owns
 *  presentation metadata); falls back to the raw value. */
function enumLabel(def: { enumLabels?: Record<string, string> }, v: string): string {
  return def.enumLabels?.[v] ?? v;
}
