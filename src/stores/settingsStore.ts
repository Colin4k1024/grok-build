/**
 * Centralized settings store (R3-11 fix).
 *
 * Before this store, user preferences were scattered across ~15 independent
 * localStorage reads/writes — theme in one hook, font size in a component,
 * sandbox mode in a toggle, voice in another. Multi-window and restart
 * consistency were impossible because each consumer cached its own copy.
 *
 * This store is the single source of truth for all user-facing settings.
 * Zustand's persist middleware writes to one localStorage key
 * ("gb-settings") so any window or reboot always reads the same state.
 *
 * Backward compat: each getter falls back to the legacy key on first read
 * so no existing user loses their preference during migration.
 */

import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import { getSettingsBridge } from "../config/fileSync";
import { getSetting, listSettings } from "../config/registry";
import { migratePersisted } from "../config/migrations";
import { CURRENT_SETTINGS_VERSION } from "../config/version";
import { sanitizePersistedState } from "../config/sanitize";
import { getPreset } from "../config/presets";

// ---- Legacy keys (read once, then the store takes over) ----
const LEGACY_THEME = "gb-theme";
const LEGACY_FONT_SIZE = "gb-font-size";
const LEGACY_ZOOM = "gb-zoom";
const LEGACY_SANDBOX = "gb-sandbox-mode";
const LEGACY_NOTIFICATIONS = "gb-notifications-enabled";
const LEGACY_VOICE_WAKE = "gb-voice-wake";
const LEGACY_VOICE_TTS = "gb-voice-tts";
const LEGACY_AGENT_DEFAULT_MODE = "gb-agent-default-mode";
const LEGACY_AGENT_MODE = "gb-agent-mode";
const LEGACY_AGENT_AUTONOMOUS = "gb-agent-autonomous";
const LEGACY_VOICE_LANG = "gb-voice-lang";
const LEGACY_TRUSTED = "gb-trusted-folders";

function legacyString(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function legacyBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === "true";
  } catch { return fallback; }
}
function legacyJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch { return fallback; }
}

/** storeKey → legacy localStorage key (still mirrored for unmigrated
 *  consumers). Exported so transfers can snapshot/restore them (R4-06). */
export const LEGACY_KEYS: Record<string, string> = {
  theme: LEGACY_THEME,
  fontSize: LEGACY_FONT_SIZE,
  zoom: LEGACY_ZOOM,
  sandboxMode: LEGACY_SANDBOX,
  agentMode: LEGACY_AGENT_MODE,
  agentAutonomous: LEGACY_AGENT_AUTONOMOUS,
  voiceLanguage: LEGACY_VOICE_LANG,
  notificationsEnabled: LEGACY_NOTIFICATIONS,
  trustedFolders: LEGACY_TRUSTED,
};

// ---- Types ----

export type ThemeMode = "light" | "dark" | "auto";
export type FontSizeId = "small" | "medium" | "large" | "xlarge";
export type AgentMode = "code" | "architect" | "debug";
export type VoiceLanguage = "auto" | "zh-CN" | "en-US";

/** Registry default for a store key (the schema is the only place defaults
 *  are declared — even this store's fallbacks come from it). */
function registryDefault(storeKey: string): unknown {
  const def = listSettings().find((d) => d.storeKey === storeKey);
  return def?.defaultValue;
}

/** Throw when a value fails its registry validator. Every write path —
 *  typed setters, setGlobalByKey, project overrides — goes through here. */
function assertValidValue(storeKey: string, value: unknown): void {
  const def = listSettings().find((d) => d.storeKey === storeKey);
  if (def && !def.validate(value)) {
    throw new Error(`invalid value for ${def.id}: ${JSON.stringify(value)}`);
  }
}

/** Initial value for a flat field: legacy localStorage read, but ONLY if it
 *  passes the registry validator — a corrupt/legacy key can never become
 *  live state (R4-05). Falls back to the schema default. */
function initialValue<T>(storeKey: string, legacy: T): T {
  const def = listSettings().find((d) => d.storeKey === storeKey);
  if (def) {
    if (!def.validate(legacy)) return def.defaultValue as T;
  }
  return legacy;
}

export interface SettingsState {
  // Appearance
  theme: ThemeMode;
  fontSize: FontSizeId;
  zoom: number;
  // Permission
  sandboxMode: "sandbox" | "full";
  // Agent behavior
  agentMode: AgentMode;
  agentAutonomous: boolean;
  // Voice
  voiceLanguage: VoiceLanguage;
  voiceWakeEnabled: boolean;
  voiceTtsEnabled: boolean;
  // Notifications
  notificationsEnabled: boolean;
  // Trusted folders (paths the user has marked as safe)
  trustedFolders: string[];

  // Actions
  setTheme: (theme: ThemeMode) => void;
  setFontSize: (size: FontSizeId) => void;
  setZoom: (zoom: number) => void;
  setSandboxMode: (mode: "sandbox" | "full") => void;
  setAgentMode: (mode: AgentMode) => void;
  setAgentAutonomous: (v: boolean) => void;
  setVoiceLanguage: (lang: VoiceLanguage) => void;
  setVoiceWakeEnabled: (v: boolean) => void;
  setVoiceTtsEnabled: (v: boolean) => void;
  setNotificationsEnabled: (v: boolean) => void;
  addTrustedFolder: (path: string) => void;
  removeTrustedFolder: (path: string) => void;

  /** R4-05 (#238): project-scope overrides, keyed by project path, then by
   *  setting id (e.g. "appearance.theme"). Resolution semantics live in
   *  src/config/resolve.ts — this store only persists the layers. */
  projectOverrides: Record<string, Record<string, unknown>>;

  /** R4-06 (#239): user-saved presets (validated at save time). */
  userPresets: Record<string, { label: string; values: Record<string, unknown> }>;
  saveUserPreset: (id: string, label: string, values: Record<string, unknown>) => void;
  renameUserPreset: (id: string, label: string) => void;
  deleteUserPreset: (id: string) => void;

  /** R4-05: generic typed-setter dispatch by flat store key ("theme", …).
   *  Unknown keys throw instead of silently persisting garbage. */
  setGlobalByKey: (storeKey: string, value: unknown) => void;
  setProjectOverride: (projectId: string, settingId: string, value: unknown) => void;
  clearProjectOverride: (projectId: string, settingId: string) => void;
  /** Project-level reset removes ONLY project overrides — never global. */
  resetProjectOverrides: (projectId: string) => void;
}

/**
 * R4-05 (#238): dual-write storage. localStorage stays the synchronous
 * read path (fast hydration, works in tests); every write is mirrored to
 * the durable settings file over the typed IPC bridge when available.
 */
const dualWriteStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {}
    getSettingsBridge()
      ?.set(name, value)
      .catch((e) => console.warn("[settings] file mirror write failed:", e));
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {}
    getSettingsBridge()
      ?.delete(name)
      .catch((e) => console.warn("[settings] file mirror delete failed:", e));
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Defaults: the registry schema is the ONLY declaration site; legacy
      // keys are honored as one-time migration reads, validated first.
      theme: initialValue("theme", legacyString(LEGACY_THEME, registryDefault("theme") as string)) as ThemeMode,
      fontSize: initialValue("fontSize", legacyString(LEGACY_FONT_SIZE, registryDefault("fontSize") as string)) as FontSizeId,
      zoom: initialValue("zoom", Number(legacyString(LEGACY_ZOOM, String(registryDefault("zoom") ?? 1.0)))) as number,
      sandboxMode: initialValue("sandboxMode", legacyString(LEGACY_SANDBOX, registryDefault("sandboxMode") as string)) as "sandbox" | "full",
      agentMode: initialValue(
        "agentMode",
        legacyString(
          LEGACY_AGENT_DEFAULT_MODE,
          legacyString(LEGACY_AGENT_MODE, registryDefault("agentMode") as string),
        ),
      ) as AgentMode,
      agentAutonomous: initialValue("agentAutonomous", legacyBool(LEGACY_AGENT_AUTONOMOUS, (registryDefault("agentAutonomous") as boolean) ?? false)),
      voiceLanguage: initialValue("voiceLanguage", legacyString(LEGACY_VOICE_LANG, registryDefault("voiceLanguage") as string)) as VoiceLanguage,
      // Legacy migration reads (R4-07): the old VoiceSettings wrote these keys.
      voiceWakeEnabled: initialValue("voiceWakeEnabled", legacyBool(LEGACY_VOICE_WAKE, (registryDefault("voiceWakeEnabled") as boolean) ?? false)),
      voiceTtsEnabled: initialValue("voiceTtsEnabled", legacyBool(LEGACY_VOICE_TTS, (registryDefault("voiceTtsEnabled") as boolean) ?? false)),
      notificationsEnabled: initialValue("notificationsEnabled", legacyBool(LEGACY_NOTIFICATIONS, (registryDefault("notificationsEnabled") as boolean) ?? true)),
      trustedFolders: initialValue("trustedFolders", legacyJson<string[]>(LEGACY_TRUSTED, (registryDefault("trustedFolders") as string[]) ?? [])),
      projectOverrides: {},
      userPresets: {},

      // Every setter validates against the registry BEFORE writing —
      // direct UI use and the storeBridge path share the same gate, so an
      // invalid value can never reach persisted state regardless of caller.
      setTheme: (theme) => {
        assertValidValue("theme", theme);
        set({ theme });
        // Keep legacy key in sync for consumers not yet migrated
        try { localStorage.setItem(LEGACY_THEME, theme); } catch {}
      },
      setFontSize: (fontSize) => {
        assertValidValue("fontSize", fontSize);
        set({ fontSize });
        try { localStorage.setItem(LEGACY_FONT_SIZE, fontSize); } catch {}
      },
      setZoom: (zoom) => {
        assertValidValue("zoom", zoom);
        set({ zoom });
        try { localStorage.setItem(LEGACY_ZOOM, String(zoom)); } catch {}
      },
      setSandboxMode: (sandboxMode) => {
        assertValidValue("sandboxMode", sandboxMode);
        set({ sandboxMode });
        try { localStorage.setItem(LEGACY_SANDBOX, sandboxMode); } catch {}
      },
      setAgentMode: (agentMode) => {
        assertValidValue("agentMode", agentMode);
        set({ agentMode });
        try { localStorage.setItem(LEGACY_AGENT_MODE, agentMode); } catch {}
      },
      setAgentAutonomous: (agentAutonomous) => {
        assertValidValue("agentAutonomous", agentAutonomous);
        set({ agentAutonomous });
        try { localStorage.setItem(LEGACY_AGENT_AUTONOMOUS, String(agentAutonomous)); } catch {}
      },
      setVoiceLanguage: (voiceLanguage) => {
        assertValidValue("voiceLanguage", voiceLanguage);
        set({ voiceLanguage });
        try { localStorage.setItem(LEGACY_VOICE_LANG, voiceLanguage); } catch {}
      },
      setVoiceWakeEnabled: (voiceWakeEnabled) => {
        assertValidValue("voiceWakeEnabled", voiceWakeEnabled);
        set({ voiceWakeEnabled });
      },
      setVoiceTtsEnabled: (voiceTtsEnabled) => {
        assertValidValue("voiceTtsEnabled", voiceTtsEnabled);
        set({ voiceTtsEnabled });
      },
      setNotificationsEnabled: (notificationsEnabled) => {
        assertValidValue("notificationsEnabled", notificationsEnabled);
        set({ notificationsEnabled });
        try { localStorage.setItem(LEGACY_NOTIFICATIONS, String(notificationsEnabled)); } catch {}
      },
      addTrustedFolder: (path) => {
        if (typeof path !== "string" || !path) throw new Error(`invalid trusted folder path: ${JSON.stringify(path)}`);
        set((s) => {
          if (s.trustedFolders.includes(path)) return s;
          const next = [...s.trustedFolders, path];
          try { localStorage.setItem(LEGACY_TRUSTED, JSON.stringify(next)); } catch {}
          return { trustedFolders: next };
        });
      },
      removeTrustedFolder: (path) => {
        if (typeof path !== "string" || !path) throw new Error(`invalid trusted folder path: ${JSON.stringify(path)}`);
        set((s) => {
          const next = s.trustedFolders.filter((p) => p !== path);
          try { localStorage.setItem(LEGACY_TRUSTED, JSON.stringify(next)); } catch {}
          return { trustedFolders: next };
        });
      },

      setGlobalByKey: (storeKey, value) => {
        // Validation is mandatory even for direct store writes — an invalid
        // value must never reach persisted state (R4-05 acceptance).
        const def = listSettings().find((d) => d.storeKey === storeKey);
        if (!def) throw new Error(`unknown settings store key: ${storeKey}`);
        if (!def.validate(value)) {
          throw new Error(`invalid value for ${def.id}: ${JSON.stringify(value)}`);
        }
        const s = get();
        // One dispatch table, co-located with validation. If schema's
        // storeKey drifts from this table the round-trip test in
        // configBridge.test.ts fails ("unbound … key").
        const setters: Record<string, () => void> = {
          theme: () => s.setTheme(value as ThemeMode),
          fontSize: () => s.setFontSize(value as FontSizeId),
          zoom: () => s.setZoom(value as number),
          sandboxMode: () => s.setSandboxMode(value as "sandbox" | "full"),
          agentMode: () => s.setAgentMode(value as AgentMode),
          agentAutonomous: () => s.setAgentAutonomous(value as boolean),
          voiceLanguage: () => s.setVoiceLanguage(value as VoiceLanguage),
          voiceWakeEnabled: () => s.setVoiceWakeEnabled(value as boolean),
          voiceTtsEnabled: () => s.setVoiceTtsEnabled(value as boolean),
          notificationsEnabled: () => s.setNotificationsEnabled(value as boolean),
          trustedFolders: () => set({ trustedFolders: value as string[] }),
        };
        const run = setters[storeKey];
        if (!run) throw new Error(`unbound settings store key: ${storeKey}`);
        run();
      },
      setProjectOverride: (projectId, settingId, value) => {
        const def = getSetting(settingId);
        if (!def) throw new Error(`unknown setting id: ${settingId}`);
        if (!def.scopes.includes("project")) {
          throw new Error(`${settingId} does not allow project scope`);
        }
        if (!def.validate(value)) {
          throw new Error(`invalid value for ${settingId}: ${JSON.stringify(value)}`);
        }
        set((s) => ({
          projectOverrides: {
            ...s.projectOverrides,
            [projectId]: { ...(s.projectOverrides[projectId] ?? {}), [settingId]: value },
          },
        }));
      },
      clearProjectOverride: (projectId, settingId) =>
        set((s) => {
          const current = { ...(s.projectOverrides[projectId] ?? {}) };
          delete current[settingId];
          const next = { ...s.projectOverrides };
          if (Object.keys(current).length === 0) delete next[projectId];
          else next[projectId] = current;
          return { projectOverrides: next };
        }),
      resetProjectOverrides: (projectId) =>
        set((s) => {
          if (!(projectId in s.projectOverrides)) return s;
          const next = { ...s.projectOverrides };
          delete next[projectId];
          return { projectOverrides: next };
        }),

      // ---- User presets (R4-06 #239) — validated at save time ----
      saveUserPreset: (id, label, values) => {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid preset id: ${id}`);
        if (["__proto__", "constructor", "prototype"].includes(id)) {
          throw new Error(`invalid preset id: ${id}`);
        }
        if (!label.trim()) throw new Error("preset label must not be empty");
        // Builtin ids are reserved — a user preset must not shadow them.
        if (getPreset(id)) throw new Error(`preset id "${id}" is reserved by a builtin preset`);
        for (const [settingId, value] of Object.entries(values)) {
          const def = getSetting(settingId);
          if (!def) throw new Error(`invalid preset: unknown setting ${settingId}`);
          if (def.sensitive) throw new Error(`invalid preset: ${settingId} is sensitive`);
          if (!def.validate(value)) {
            throw new Error(`invalid preset: bad value for ${settingId}: ${JSON.stringify(value)}`);
          }
        }
        set((s) => ({ userPresets: { ...s.userPresets, [id]: { label, values: { ...values } } } }));
      },
      renameUserPreset: (id, label) => {
        const cur = Object.prototype.hasOwnProperty.call(get().userPresets, id)
          ? get().userPresets[id]
          : undefined;
        if (!cur) throw new Error(`unknown preset: ${id}`);
        if (!label.trim()) throw new Error("preset label must not be empty");
        set((s) => ({ userPresets: { ...s.userPresets, [id]: { ...cur, label } } }));
      },
      deleteUserPreset: (id) => {
        if (!Object.prototype.hasOwnProperty.call(get().userPresets, id)) {
          throw new Error(`unknown preset: ${id}`);
        }
        set((s) => {
          const next = { ...s.userPresets };
          delete next[id];
          return { userPresets: next };
        });
      },
    }),
    {
      name: "gb-settings",
      storage: createJSONStorage(() => dualWriteStorage),
      version: CURRENT_SETTINGS_VERSION,
      // R4-06: version-gated migration pipeline. A failed migration does
      // NOT adopt the foreign payload (a newer install's blob must never
      // be silently downgraded): the original is quarantined to a backup
      // key and the app boots on registry defaults.
      migrate: (persistedState, version) => {
        const r = migratePersisted({ state: persistedState, version });
        if (!r.ok) {
          console.error(`[settings] migration failed: ${r.error}`);
          try {
            // Quarantine the foreign payload, keeping only the newest 3
            // backups (no unbounded accumulation).
            localStorage.setItem(
              `gb-settings.backup-${Date.now()}`,
              JSON.stringify({ state: persistedState, version }),
            );
            const keys = Object.keys(localStorage)
              .filter((k) => k.startsWith("gb-settings.backup-"))
              .sort();
            for (const k of keys.slice(0, Math.max(0, keys.length - 3))) {
              localStorage.removeItem(k);
            }
          } catch {
            /* storage unavailable */
          }
          return undefined as never; // fall back to initial (defaults)
        }
        return r.state as never;
      },
      // R4-05: hydration sanitization runs on EVERY rehydrate (merge), not
      // only on version bumps. Implementation shared with the migration
      // pipeline (src/config/sanitize.ts): allowlist + per-field registry
      // validation + override/preset entry cleaning.
      merge: (persisted, current) => {
        const state = persisted as Record<string, unknown> | undefined;
        if (!state || typeof state !== "object") return current;
        const merged = { ...current, ...sanitizePersistedState(state) };
        // Preserve a user's notification opt-out across the R4-07 takeover.
        // Before this change the only notification toggle wrote the legacy
        // `gb-notifications-enabled` key directly and never touched the store,
        // so a persisted `gb-settings` blob holds the default `true` for
        // notificationsEnabled. The spread above would let that stale default
        // silently re-enable notifications for anyone who opted out. The
        // legacy key is the user's real preference — honor it on hydration
        // when present (the new setNotificationsEnabled mirrors to it, so
        // post-upgrade writes keep both in sync and this becomes a no-op).
        try {
          const legacyNotif = localStorage.getItem(LEGACY_NOTIFICATIONS);
          if (legacyNotif !== null) merged.notificationsEnabled = legacyNotif === "true";
        } catch {
          /* storage unavailable */
        }
        return merged;
      },
    }
  )
);

// Multi-window sync + boot read-repair: the durable file is canonical.
// Content-compare guards against any echo loop (main broadcasts only to
// non-sender windows, but belt and braces).
/**
 * Apply a remote settings document.
 *
 * mode "boot": the file may simply not exist yet (first launch after
 *   upgrade) — absence of the blob means "no file data", NEVER a reset.
 *   We adopt a present blob, or seed the file from localStorage so the
 *   mirror converges without touching local state.
 * mode "event": fired only by explicit set/delete/reset mutations — a
 *   missing blob there is a real reset, so live state resets to registry
 *   defaults (unconditionally: another window may have cleared the shared
 *   localStorage first while this window's state is still stale).
 */
export function syncFromFileDoc(
  doc: { version?: number; values: Record<string, unknown> },
  mode: "boot" | "event" = "event",
): void {
  try {
    const remote = doc.values["gb-settings"];
    if (typeof remote === "string") {
      if (localStorage.getItem("gb-settings") === remote) return;
      localStorage.setItem("gb-settings", remote);
      useSettingsStore.persist.rehydrate();
      return;
    }
    if (remote !== undefined) return; // unexpected type — ignore
    if (mode === "boot") {
      // Seed the durable file from existing local state (upgrade path).
      const local = localStorage.getItem("gb-settings");
      if (local) {
        getSettingsBridge()
          ?.set("gb-settings", local)
          .catch(() => {});
      }
      return;
    }
    // event mode: real reset
    localStorage.removeItem("gb-settings");
    const defaults: Record<string, unknown> = { projectOverrides: {} };
    for (const def of listSettings()) {
      if (def.storeKey) defaults[def.storeKey] = def.defaultValue;
    }
    useSettingsStore.setState(defaults);
  } catch {
    /* storage unavailable */
  }
}

if (typeof window !== "undefined") {
  const bridge = getSettingsBridge();
  if (bridge) {
    bridge
      .getAll()
      .then((doc) => syncFromFileDoc(doc, "boot"))
      .catch(() => {});
    bridge.onChanged((doc) => syncFromFileDoc(doc, "event"));
  }
}