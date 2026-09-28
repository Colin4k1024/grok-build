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

// ---- Legacy keys (read once, then the store takes over) ----
const LEGACY_THEME = "gb-theme";
const LEGACY_FONT_SIZE = "gb-font-size";
const LEGACY_ZOOM = "gb-zoom";
const LEGACY_SANDBOX = "gb-sandbox-mode";
const LEGACY_NOTIFICATIONS = "gb-notifications";
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

// ---- Types ----

export type ThemeMode = "light" | "dark" | "auto";
export type FontSizeId = "small" | "medium" | "large" | "xlarge";
export type AgentMode = "code" | "architect" | "debug";
export type VoiceLanguage = "auto" | "zh-CN" | "en-US";

/** Flat data keys that may hydrate from the persisted blob — an allowlist
 *  so a corrupt/hostile blob can never overwrite store actions or inject
 *  unknown state (R4-05 review). */
const HYDRATABLE_KEYS = new Set([
  "theme", "fontSize", "zoom", "sandboxMode", "agentMode", "agentAutonomous",
  "voiceLanguage", "voiceWakeEnabled", "voiceTtsEnabled", "notificationsEnabled",
  "trustedFolders", "projectOverrides",
]);

/** Registry default for a store key (the schema is the only place defaults
 *  are declared — even this store's fallbacks come from it). */
function registryDefault(storeKey: string): unknown {
  const def = listSettings().find((d) => d.storeKey === storeKey);
  return def?.defaultValue;
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
      // keys are still honored as one-time migration reads.
      theme: legacyString(LEGACY_THEME, registryDefault("theme") as string) as ThemeMode,
      fontSize: legacyString(LEGACY_FONT_SIZE, registryDefault("fontSize") as string) as FontSizeId,
      zoom: Number(legacyString(LEGACY_ZOOM, String(registryDefault("zoom") ?? 1.0))),
      sandboxMode: legacyString(LEGACY_SANDBOX, registryDefault("sandboxMode") as string) as "sandbox" | "full",
      agentMode: legacyString(LEGACY_AGENT_MODE, registryDefault("agentMode") as string) as AgentMode,
      agentAutonomous: legacyBool(LEGACY_AGENT_AUTONOMOUS, (registryDefault("agentAutonomous") as boolean) ?? false),
      voiceLanguage: legacyString(LEGACY_VOICE_LANG, registryDefault("voiceLanguage") as string) as VoiceLanguage,
      voiceWakeEnabled: (registryDefault("voiceWakeEnabled") as boolean) ?? false,
      voiceTtsEnabled: (registryDefault("voiceTtsEnabled") as boolean) ?? false,
      notificationsEnabled: legacyBool(LEGACY_NOTIFICATIONS, (registryDefault("notificationsEnabled") as boolean) ?? true),
      trustedFolders: legacyJson<string[]>(LEGACY_TRUSTED, (registryDefault("trustedFolders") as string[]) ?? []),
      projectOverrides: {},

      setTheme: (theme) => {
        set({ theme });
        // Keep legacy key in sync for consumers not yet migrated
        try { localStorage.setItem(LEGACY_THEME, theme); } catch {}
      },
      setFontSize: (fontSize) => {
        set({ fontSize });
        try { localStorage.setItem(LEGACY_FONT_SIZE, fontSize); } catch {}
      },
      setZoom: (zoom) => {
        set({ zoom });
        try { localStorage.setItem(LEGACY_ZOOM, String(zoom)); } catch {}
      },
      setSandboxMode: (sandboxMode) => {
        set({ sandboxMode });
        try { localStorage.setItem(LEGACY_SANDBOX, sandboxMode); } catch {}
      },
      setAgentMode: (agentMode) => {
        set({ agentMode });
        try { localStorage.setItem(LEGACY_AGENT_MODE, agentMode); } catch {}
      },
      setAgentAutonomous: (agentAutonomous) => {
        set({ agentAutonomous });
        try { localStorage.setItem(LEGACY_AGENT_AUTONOMOUS, String(agentAutonomous)); } catch {}
      },
      setVoiceLanguage: (voiceLanguage) => {
        set({ voiceLanguage });
        try { localStorage.setItem(LEGACY_VOICE_LANG, voiceLanguage); } catch {}
      },
      setVoiceWakeEnabled: (voiceWakeEnabled) => set({ voiceWakeEnabled }),
      setVoiceTtsEnabled: (voiceTtsEnabled) => set({ voiceTtsEnabled }),
      setNotificationsEnabled: (notificationsEnabled) => {
        set({ notificationsEnabled });
        try { localStorage.setItem(LEGACY_NOTIFICATIONS, String(notificationsEnabled)); } catch {}
      },
      addTrustedFolder: (path) =>
        set((s) => {
          if (s.trustedFolders.includes(path)) return s;
          const next = [...s.trustedFolders, path];
          try { localStorage.setItem(LEGACY_TRUSTED, JSON.stringify(next)); } catch {}
          return { trustedFolders: next };
        }),
      removeTrustedFolder: (path) =>
        set((s) => {
          const next = s.trustedFolders.filter((p) => p !== path);
          try { localStorage.setItem(LEGACY_TRUSTED, JSON.stringify(next)); } catch {}
          return { trustedFolders: next };
        }),

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
    }),
    {
      name: "gb-settings",
      storage: createJSONStorage(() => dualWriteStorage),
      version: 1,
      // R4-05: hydration sanitization runs on EVERY rehydrate (merge), not
      // only on version bumps. Two layers of defense:
      //   1. allowlist — only known DATA keys may hydrate (a blob can never
      //      overwrite store actions or inject unknown state);
      //   2. per-field registry validation — invalid values fall back to
      //      the schema default; invalid override entries are dropped.
      merge: (persisted, current) => {
        const state = persisted as Record<string, unknown> | undefined;
        if (!state || typeof state !== "object") return current;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(state)) {
          if (HYDRATABLE_KEYS.has(key)) out[key] = state[key];
        }
        for (const def of listSettings()) {
          if (!def.storeKey) continue;
          const key = def.storeKey;
          if (key in out && !def.validate(out[key])) out[key] = def.defaultValue;
        }
        // Normalize projectOverrides: always an object of objects with
        // validated entries (never null / array / garbage).
        const raw = out.projectOverrides;
        const cleaned: Record<string, Record<string, unknown>> = {};
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [projectId, entries] of Object.entries(raw as Record<string, unknown>)) {
            if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
            const kept: Record<string, unknown> = {};
            for (const [settingId, value] of Object.entries(entries as Record<string, unknown>)) {
              const def = getSetting(settingId);
              if (def && def.scopes.includes("project") && def.validate(value)) {
                kept[settingId] = value;
              }
            }
            if (Object.keys(kept).length > 0) cleaned[projectId] = kept;
          }
        }
        out.projectOverrides = cleaned;
        return { ...current, ...out };
      },
    }
  )
);

// Multi-window sync + boot read-repair: the durable file is canonical.
// Content-compare guards against any echo loop (main broadcasts only to
// non-sender windows, but belt and braces). A document WITHOUT the blob key
// means the file was reset — local state resets to defaults too.
if (typeof window !== "undefined") {
  const applyRemoteDoc = (doc: { values: Record<string, unknown> }) => {
    try {
      const remote = doc.values["gb-settings"];
      if (typeof remote === "string") {
        if (localStorage.getItem("gb-settings") === remote) return;
        localStorage.setItem("gb-settings", remote);
        useSettingsStore.persist.rehydrate();
      } else if (remote === undefined) {
        if (localStorage.getItem("gb-settings") === null) return;
        localStorage.removeItem("gb-settings");
        useSettingsStore.persist.rehydrate();
      }
    } catch {
      /* storage unavailable */
    }
  };
  const bridge = getSettingsBridge();
  if (bridge) {
    bridge
      .getAll()
      .then((doc) => applyRemoteDoc(doc))
      .catch(() => {});
    bridge.onChanged((doc) => applyRemoteDoc(doc));
  }
}