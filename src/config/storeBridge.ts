import { getSetting, listSettings, resolveSetting } from "./index";
import { getPreset } from "./presets";
import type { ResolvedSetting } from "./types";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * Store bridge (R4-05 #238): the typed path between the registry and the
 * persisted settings store. UI code must go through here instead of
 * re-declaring defaults or merging scopes by hand.
 */

/** registry id -> flat settingsStore field, derived from each definition's
 *  storeKey in src/config/schema.ts (single declaration site). */
const STORE_KEYS: Record<string, string> = Object.fromEntries(
  listSettings()
    .filter((d) => d.storeKey)
    .map((d) => [d.id, d.storeKey as string]),
);

export class SettingWriteError extends Error {
  code: "unknown_key" | "invalid_value" | "scope_not_allowed";
  constructor(code: SettingWriteError["code"], detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  return false;
}

/** Resolve a setting's effective value + source for a project context.
 *
 *  Provenance rule: the flat legacy store cannot distinguish "never
 *  touched" from "set to the default", so a GLOBAL layer equal to the
 *  default reports as source "default" (compat heuristic, documented).
 *  Project/session layers NEVER get this downgrade — an override entry
 *  exists only because someone wrote it, so its provenance is real even
 *  when its value equals the default. */
export function resolveFromStore<T = unknown>(
  settingId: string,
  projectId?: string,
): ResolvedSetting<T> {
  const def = getSetting(settingId);
  if (!def) throw new SettingWriteError("unknown_key", `unknown setting id: ${settingId}`);
  const s = useSettingsStore.getState();
  const storeKey = STORE_KEYS[settingId];
  const resolved = resolveSetting(def as never, {
    global: storeKey ? (s as unknown as Record<string, unknown>)[storeKey] : undefined,
    project: projectId ? s.projectOverrides[projectId]?.[settingId] : undefined,
  }) as ResolvedSetting<T>;
  if (resolved.source === "global" && deepEqual(resolved.value, def.defaultValue)) {
    return { ...resolved, source: "default", overridden: false };
  }
  return resolved;
}

/** Write a value at the requested scope; validation happens FIRST and a
 *  failed write never touches persisted state. */
export function setScopedValue(
  settingId: string,
  value: unknown,
  scope: "global" | "project",
  projectId?: string,
): void {
  const def = getSetting(settingId);
  if (!def) throw new SettingWriteError("unknown_key", `unknown setting id: ${settingId}`);
  if (!def.scopes.includes(scope)) {
    throw new SettingWriteError(
      "scope_not_allowed",
      `${settingId} does not allow ${scope} scope (allowed: ${def.scopes.join(", ")})`,
    );
  }
  if (!def.validate(value)) {
    throw new SettingWriteError(
      "invalid_value",
      `${settingId}: value failed validation: ${JSON.stringify(value)}`,
    );
  }
  const store = useSettingsStore.getState();
  if (scope === "global") {
    const storeKey = STORE_KEYS[settingId];
    if (!storeKey) {
      throw new SettingWriteError(
        "unknown_key",
        `${settingId} has no global store binding (session-only or unmanaged)`,
      );
    }
    store.setGlobalByKey(storeKey, value);
    return;
  }
  if (!projectId) {
    throw new SettingWriteError("invalid_value", "project scope requires a projectId");
  }
  store.setProjectOverride(projectId, settingId, value);
}

/** Clear one project override, or ALL overrides for a project. Global
 *  values are never touched by a project reset. */
export function resetScopedValue(settingId: string | null, projectId: string): void {
  const store = useSettingsStore.getState();
  if (settingId === null) {
    store.resetProjectOverrides(projectId);
    return;
  }
  if (!getSetting(settingId)) {
    throw new SettingWriteError("unknown_key", `unknown setting id: ${settingId}`);
  }
  store.clearProjectOverride(projectId, settingId);
}

export function listStoreBindings(): Record<string, string> {
  return { ...STORE_KEYS };
}

export interface ApplyResult {
  applied: string[];
  failed: string[];
}

/**
 * Apply a builtin or user preset at a scope (R4-06 #239). Every value goes
 * through the validated typed path; per-key failures are reported, never
 * silently swallowed. Throws on an unknown preset id.
 */
export function applyPreset(
  presetId: string,
  scope: "global" | "project",
  projectId?: string,
): ApplyResult {
  const builtin = getPreset(presetId);
  const user = useSettingsStore.getState().userPresets[presetId];
  const source = builtin ?? user;
  if (!source) throw new Error(`unknown preset: ${presetId}`);
  const values = builtin ? builtin.values : user!.values;
  const applied: string[] = [];
  const failed: string[] = [];
  for (const [settingId, value] of Object.entries(values)) {
    try {
      setScopedValue(settingId, value, scope, projectId);
      applied.push(settingId);
    } catch (e) {
      failed.push(`${settingId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { applied, failed };
}
