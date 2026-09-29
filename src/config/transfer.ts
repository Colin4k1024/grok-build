import { getSetting, listSettings } from "./registry";
import { resolveFromStore, setScopedValue } from "./storeBridge";
import { useSettingsStore, LEGACY_KEYS } from "../stores/settingsStore";
import { CURRENT_SETTINGS_VERSION } from "./version";

/**
 * Settings import/export (R4-06 #239). Exports are versioned and strip
 * sensitive settings. Imports validate the WHOLE document before anything
 * is applied — a broken document changes nothing; a valid preview shows
 * exactly what will be added/changed/reset and at which scope.
 * applyImport rolls back to a snapshot if any write fails mid-apply.
 */

export interface SettingsExportDoc {
  kind: "gb-settings-export";
  settingsVersion: number;
  exportedAt: string;
  global: Record<string, unknown>;
  /** Optional — older/simpler exports may omit project overrides entirely. */
  projects?: Record<string, Record<string, unknown>>;
}

/** Settings marked sensitive never leave the app. */
function exportable(defId: string): boolean {
  const def = getSetting(defId);
  return !!def && !def.sensitive;
}

export function exportSettings(opts: { includeProjects?: boolean } = {}): SettingsExportDoc {
  const s = useSettingsStore.getState();
  const global: Record<string, unknown> = {};
  for (const def of listSettings()) {
    if (!def.storeKey || def.sensitive) continue;
    global[def.id] = (s as unknown as Record<string, unknown>)[def.storeKey];
  }
  // Project overrides are EXCLUDED by default: their keys are absolute
  // filesystem paths — the same layout leak that makes trustedFolders
  // sensitive. Opt in explicitly for advanced backup flows.
  const projects: SettingsExportDoc["projects"] = {};
  if (opts.includeProjects) {
    for (const [projectId, entries] of Object.entries(s.projectOverrides)) {
      const kept: Record<string, unknown> = {};
      for (const [settingId, value] of Object.entries(entries)) {
        if (exportable(settingId)) kept[settingId] = value;
      }
      if (Object.keys(kept).length > 0) projects[projectId] = kept;
    }
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
  /** Keys that would be set and are currently at default. Entries are
   *  scope-tagged: "appearance.theme" or "/proj:appearance.theme". */
  added: string[];
  /** Keys whose effective value would change. */
  changed: string[];
  /** Keys currently overridden that the document would reset (replace mode). */
  reset: string[];
  /** Unknown, sensitive, or out-of-scope keys the import would skip. */
  ignored: string[];
  /** The parsed document — internal handle for applyImport. */
  doc?: SettingsExportDoc;
}

export function previewImport(
  json: string,
  opts: { mode?: "merge" | "replace" } = {},
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

  // Every entry applyImport would write is classified HERE — preview and
  // apply never disagree about scope (R4-06 review).
  const classify = (
    settingId: string,
    value: unknown,
    scope: "global" | "project",
    projectId: string | undefined,
  ) => {
    const tag = projectId ? `${projectId}:${settingId}` : settingId;
    const def = getSetting(settingId);
    if (!def) {
      ignored.push(`${tag}（未知配置项）`);
      return;
    }
    if (def.sensitive) {
      ignored.push(`${tag}（敏感项不导入）`);
      return;
    }
    if (!def.scopes.includes(scope)) {
      ignored.push(`${tag}（${scope} 作用域不允许）`);
      return;
    }
    if (!def.validate(value)) {
      errors.push(`${tag}: 非法值 ${JSON.stringify(value)}`);
      return;
    }
    const cur = resolveFromStore(settingId, projectId);
    if (cur.source === "default") {
      if (JSON.stringify(cur.value) !== JSON.stringify(value)) added.push(tag);
    } else if (JSON.stringify(cur.value) !== JSON.stringify(value)) {
      changed.push(tag);
    }
  };

  for (const [id, value] of Object.entries(doc.global)) classify(id, value, "global", undefined);
  for (const [pid, entries] of Object.entries(doc.projects ?? {})) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      errors.push(`projects.${pid}: 必须是对象`);
      continue;
    }
    for (const [id, value] of Object.entries(entries)) classify(id, value, "project", pid);
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

  return {
    ok: errors.length === 0,
    errors, added, changed, reset, ignored,
    doc: errors.length === 0 ? (doc as SettingsExportDoc) : undefined,
  };
}

export interface ImportResult {
  ok: boolean;
  applied: string[];
  failed: string[];
  /** True when a mid-apply failure rolled everything back. */
  rolledBack?: boolean;
}

export interface SettingsSnapshot {
  flat: Record<string, unknown>;
  projectOverrides: Record<string, Record<string, unknown>>;
  legacy: Record<string, string | null>;
}

/** Snapshot the full settings state (store + legacy mirror keys). */
export function snapshotSettings(): SettingsSnapshot {
  const s = useSettingsStore.getState();
  const flat = Object.fromEntries(
    listSettings()
      .filter((d) => d.storeKey)
      .map((d) => [d.storeKey as string, (s as unknown as Record<string, unknown>)[d.storeKey as string]]),
  );
  const legacy: Record<string, string | null> = {};
  for (const key of Object.values(LEGACY_KEYS)) {
    try {
      legacy[key] = localStorage.getItem(key);
    } catch {
      legacy[key] = null;
    }
  }
  return {
    flat,
    projectOverrides: JSON.parse(JSON.stringify(s.projectOverrides)) as Record<string, Record<string, unknown>>,
    legacy,
  };
}

/** Restore a snapshot (store + legacy mirrors). */
export function restoreSettings(snap: SettingsSnapshot): void {
  useSettingsStore.setState({ ...snap.flat, projectOverrides: snap.projectOverrides });
  for (const [key, value] of Object.entries(snap.legacy)) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  }
}

function snapshotState() {
  return snapshotSettings();
}

/** Apply a VALID preview. A failed preview is a hard no-op. If any write
 *  fails mid-apply, the store rolls back to the pre-apply snapshot —
 *  imports are atomic. Replace mode additionally applies preview.reset
 *  (currently-overridden keys absent from the document → defaults). */
export function applyImport(
  preview: ImportPreview,
  opts: { mode?: "merge" | "replace" } = {},
): ImportResult {
  if (!preview.ok || !preview.doc) {
    return { ok: false, applied: [], failed: preview.errors };
  }
  const doc = preview.doc;
  const mode = opts.mode ?? "merge";
  const before = snapshotState();
  const applied: string[] = [];
  const failed: string[] = [];

  const rollback = () => restoreSettings(before);

  const writes: Array<() => string | null> = [];
  const pushWrite = (
    id: string,
    value: unknown,
    scope: "global" | "project",
    pid?: string,
  ) => {
    writes.push(() => {
      const tag = pid ? `${pid}:${id}` : id;
      const def = getSetting(id);
      // Mirror preview's ignored list exactly: unknown / sensitive /
      // out-of-scope entries are SKIPPED, never written.
      if (!def || def.sensitive || !def.scopes.includes(scope)) return null;
      // No-op writes are not "applied" — the report reflects real changes.
      const cur = resolveFromStore(id, pid);
      if (JSON.stringify(cur.value) === JSON.stringify(value)) return null;
      setScopedValue(id, value, scope, pid);
      return tag;
    });
  };
  for (const [id, value] of Object.entries(doc.global)) pushWrite(id, value, "global");
  for (const [pid, entries] of Object.entries(doc.projects ?? {})) {
    for (const [id, value] of Object.entries(entries)) pushWrite(id, value, "project", pid);
  }
  // Replace mode resets the GLOBAL layer only — project layers are
  // merge-only (resetting projects you can't see would be a trap).
  // The reset list is RECOMPUTED at apply time (state may have moved
  // since preview).
  if (mode === "replace") {
    for (const def of listSettings()) {
      if (!def.storeKey || def.sensitive) continue;
      if (def.id in doc.global) continue;
      const cur = resolveFromStore(def.id);
      if (!cur.overridden) continue;
      writes.push(() => {
        setScopedValue(def.id, def.defaultValue, "global");
        return `${def.id}（重置）`;
      });
    }
  }

  for (const write of writes) {
    try {
      const tag = write();
      if (tag !== null) applied.push(tag);
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
      rollback();
      return { ok: false, applied: [], failed, rolledBack: true };
    }
  }
  return { ok: true, applied, failed };
}
