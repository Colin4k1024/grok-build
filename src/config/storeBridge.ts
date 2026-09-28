import { getSetting, resolveSetting } from "./index";
import type { ResolvedSetting } from "./types";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * Store bridge (R4-05 #238): the typed path between the registry and the
 * persisted settings store. UI code must go through here instead of
 * re-declaring defaults or merging scopes by hand.
 */

/** registry id -> flat settingsStore field (global layer). */
const STORE_KEYS: Record<string, string> = {
  "appearance.theme": "theme",
  "appearance.fontSize": "fontSize",
  "appearance.zoom": "zoom",
  "permissions.sandboxMode": "sandboxMode",
  "agent.mode": "agentMode",
  "agent.autonomous": "agentAutonomous",
  "voice.language": "voiceLanguage",
  "voice.wakeEnabled": "voiceWakeEnabled",
  "voice.ttsEnabled": "voiceTtsEnabled",
  "notifications.enabled": "notificationsEnabled",
  "general.trustedFolders": "trustedFolders",
};

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
 *  The flat legacy store always holds a value, so a global layer equal to
 *  the default is reported as "default" (the user never meaningfully
 *  overrode it) — matching how the settings UI should present source. */
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
  if (resolved.source !== "default" && deepEqual(resolved.value, def.defaultValue)) {
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
