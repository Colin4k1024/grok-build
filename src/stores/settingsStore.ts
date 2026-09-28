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
      .catch(() => {});
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
    } catch {}
    getSettingsBridge()
      ?.delete(name)
      .catch(() => {});
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Defaults with legacy fallback on first load
      theme: legacyString(LEGACY_THEME, "dark") as ThemeMode,
      fontSize: legacyString(LEGACY_FONT_SIZE, "medium") as FontSizeId,
      zoom: Number(legacyString(LEGACY_ZOOM, "1.0")),
      sandboxMode: legacyString(LEGACY_SANDBOX, "sandbox") as "sandbox" | "full",
      agentMode: legacyString(LEGACY_AGENT_MODE, "code") as AgentMode,
      agentAutonomous: legacyBool(LEGACY_AGENT_AUTONOMOUS, false),
      voiceLanguage: legacyString(LEGACY_VOICE_LANG, "auto") as VoiceLanguage,
      voiceWakeEnabled: false,
      voiceTtsEnabled: false,
      notificationsEnabled: legacyBool(LEGACY_NOTIFICATIONS, true),
      trustedFolders: legacyJson<string[]>(LEGACY_TRUSTED, []),
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
        const s = get();
        switch (storeKey) {
          case "theme": return s.setTheme(value as ThemeMode);
          case "fontSize": return s.setFontSize(value as FontSizeId);
          case "zoom": return s.setZoom(value as number);
          case "sandboxMode": return s.setSandboxMode(value as "sandbox" | "full");
          case "agentMode": return s.setAgentMode(value as AgentMode);
          case "agentAutonomous": return s.setAgentAutonomous(value as boolean);
          case "voiceLanguage": return s.setVoiceLanguage(value as VoiceLanguage);
          case "voiceWakeEnabled": return s.setVoiceWakeEnabled(value as boolean);
          case "voiceTtsEnabled": return s.setVoiceTtsEnabled(value as boolean);
          case "notificationsEnabled": return s.setNotificationsEnabled(value as boolean);
          case "trustedFolders":
            if (!Array.isArray(value)) throw new Error("trustedFolders must be an array");
            return set({ trustedFolders: value as string[] });
          default:
            throw new Error(`unknown settings store key: ${storeKey}`);
        }
      },
      setProjectOverride: (projectId, settingId, value) =>
        set((s) => ({
          projectOverrides: {
            ...s.projectOverrides,
            [projectId]: { ...(s.projectOverrides[projectId] ?? {}), [settingId]: value },
          },
        })),
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
    }
  )
);

// Multi-window sync: another window's file write rehydrates this store.
// Content-compare guards against any echo loop.
if (typeof window !== "undefined") {
  getSettingsBridge()?.onChanged((doc) => {
    const remote = doc.values["gb-settings"];
    if (typeof remote !== "string") return;
    try {
      if (localStorage.getItem("gb-settings") === remote) return;
      localStorage.setItem("gb-settings", remote);
      useSettingsStore.persist.rehydrate();
    } catch {
      /* storage unavailable */
    }
  });
}