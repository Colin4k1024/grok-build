import { getSetting, listSettings } from "./registry";
import { resolveFromStore, setScopedValue } from "./storeBridge";
import { useSettingsStore } from "../stores/settingsStore";
import { CURRENT_SETTINGS_VERSION } from "./version";

/**
 * Settings import/export (R4-06 #239). Exports are versioned and strip
 * sensitive settings. Imports are validated end-to-end BEFORE anything is
 * applied — a broken document changes nothing; a valid one reports exactly
 * what it will add/change/reset and at which scope.
 */

export interface SettingsExportDoc {
  kind: "gb-settings-export";
  settingsVersion: number;
  exportedAt: string;
  global: Record<string, unknown>;
  projects: Record<string, Record<string, unknown>>;
}

/** Settings marked sensitive never leave the app. */
function exportable(defId: string): boolean {
  const def = getSetting(defId);
  return !!def && !def.sensitive;
}

export function exportSettings(): SettingsExportDoc {
  const s = useSettingsStore.getState();
  const global: Record<string, unknown> = {};
  for (const def of listSettings()) {
    if (!def.storeKey || def.sensitive) continue;
    global[def.id] = (s as unknown as Record<string, unknown>)[def.storeKey];
  }
  const projects: Record<string, Record<string, unknown>> = {};
  for (const [projectId, entries] of Object.entries(s.projectOverrides)) {
    const kept: Record<string, unknown> = {};
    for (const [settingId, value] of Object.entries(entries)) {
      if (exportable(settingId)) kept[settingId] = value;
    }
    if (Object.keys(kept).length > 0) projects[projectId] = kept;
  }
  return {
    kind: "gb-settings-export",
    settingsVersion: CURRENT_SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    global,
    projects,
  };
}

export interface ImportPreview {
  ok: boolean;
  errors: string[];
  /** Keys that would be set and are currently at default. */
  added: string[];
  /** Keys whose effective value would change. */
  changed: string[];
  /** Keys currently overridden that the document would reset (replace mode). */
  reset: string[];
  /** Unknown or out-of-scope keys skipped silently. */
  ignored: string[];
  /** The parsed document — internal handle for applyImport. */
  doc?: SettingsExportDoc;
}

export function previewImport(
  json: string,
  opts: { mode?: "merge" | "replace"; projectId?: string } = {},
): ImportPreview {
  const mode = opts.mode ?? "merge";
  const errors: string[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  const reset: string[] = [];
  const ignored: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, errors: ["不是合法的 JSON 文档"], added, changed, reset, ignored };
  }
  const doc = raw as Partial<SettingsExportDoc>;
  if (!doc || typeof doc !== "object" || doc.kind !== "gb-settings-export") {
    return { ok: false, errors: ["不是 Grok Build 设置导出文档（kind 不匹配）"], added, changed, reset, ignored };
  }
  if (typeof doc.settingsVersion !== "number") {
    return { ok: false, errors: ["缺少 settingsVersion"], added, changed, reset, ignored };
  }
  if (doc.settingsVersion > CURRENT_SETTINGS_VERSION) {
    return {
      ok: false,
      errors: [`文档版本 (${doc.settingsVersion}) 比当前应用 (${CURRENT_SETTINGS_VERSION}) 更新 — 请升级应用后再导入`],
      added, changed, reset, ignored,
    };
  }
  if (!doc.global || typeof doc.global !== "object" || Array.isArray(doc.global)) {
    return { ok: false, errors: ["global 必须是对象"], added, changed, reset, ignored };
  }
  if (doc.projects && (typeof doc.projects !== "object" || Array.isArray(doc.projects))) {
    return { ok: false, errors: ["projects 必须是对象"], added, changed, reset, ignored };
  }

  const current = useSettingsStore.getState();

  const classify = (settingId: string, value: unknown, scope: "global" | "project", projectId?: string) => {
    const def = getSetting(settingId);
    if (!def) {
      ignored.push(settingId);
      return;
    }
    if (!def.scopes.includes(scope)) {
      ignored.push(`${settingId} (${scope} 不允许)`);
      return;
    }
    if (!def.validate(value)) {
      errors.push(`${settingId}: 非法值 ${JSON.stringify(value)}`);
      return;
    }
    const cur = resolveFromStore(settingId, projectId);
    if (cur.source === "default") {
      if (JSON.stringify(cur.value) !== JSON.stringify(value)) added.push(settingId);
    } else if (JSON.stringify(cur.value) !== JSON.stringify(value)) {
      changed.push(settingId);
    }
  };

  for (const [id, value] of Object.entries(doc.global)) classify(id, value, "global");
  if (opts.projectId) {
    for (const [id, value] of Object.entries(doc.projects?.[opts.projectId] ?? {})) {
      classify(id, value, "project", opts.projectId);
    }
  }

  // Replace mode: currently-overridden global keys absent from the document
  // would reset to defaults.
  if (mode === "replace") {
    for (const def of listSettings()) {
      if (!def.storeKey || def.sensitive) continue;
      if (!(def.id in doc.global)) {
        const cur = resolveFromStore(def.id);
        if (cur.overridden) reset.push(def.id);
      }
    }
  }

  void current;
  return {
    ok: errors.length === 0,
    errors, added, changed, reset, ignored,
    doc: errors.length === 0 ? (doc as SettingsExportDoc) : undefined,
  };
}

export interface ApplyResult {
  ok: boolean;
  applied: string[];
  failed: string[];
}

/** Apply a VALID preview. A failed preview is a hard no-op. Per-key write
 *  failures (shouldn't happen — preview validated) are still reported. */
export function applyImport(
  preview: ImportPreview,
  opts: { projectId?: string } = {},
): ApplyResult {
  if (!preview.ok || !preview.doc) return { ok: false, applied: [], failed: preview.errors };
  const doc = preview.doc;
  const applied: string[] = [];
  const failed: string[] = [];

  for (const [id, value] of Object.entries(doc.global)) {
    try {
      setScopedValue(id, value, "global");
      applied.push(id);
    } catch (e) {
      failed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Projects: apply the whole document, or just the given project.
  const projectIds = opts.projectId ? [opts.projectId] : Object.keys(doc.projects);
  for (const pid of projectIds) {
    for (const [id, value] of Object.entries(doc.projects[pid] ?? {})) {
      try {
        setScopedValue(id, value, "project", pid);
        applied.push(`${pid}:${id}`);
      } catch (e) {
        failed.push(`${pid}:${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { ok: failed.length === 0, applied, failed };
}
