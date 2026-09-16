import { useState, useMemo, useEffect } from "react";
import { ModelManager } from "../components/settings/ModelManager";
import { ApiKeyManager } from "../components/settings/ApiKeyManager";
import { GeneralSettings } from "../components/settings/GeneralSettings";
import { AppearanceSettings } from "../components/settings/AppearanceSettings";
import { McpManager } from "../components/settings/McpManager";
import { PluginManager } from "../components/settings/PluginManager";
import { WorktreeManager } from "../components/settings/WorktreeManager";
import { PermissionsManager } from "../components/settings/PermissionsManager";
import { AgentSettings } from "../components/settings/AgentSettings";
import { TrustedFoldersManager } from "../components/settings/TrustedFoldersManager";
import { VoiceSettings } from "../components/settings/VoiceSettings";

type SettingsTab = "models" | "apikeys" | "mcp" | "plugins" | "worktrees" | "appearance" | "permissions" | "agent" | "trusted" | "voice" | "general" | "about";

const TAB_LABELS: Record<SettingsTab, string> = {
  models: "Models",
  apikeys: "API Keys",
  mcp: "MCP Servers",
  plugins: "Plugins",
  worktrees: "Worktrees",
  appearance: "Appearance",
  permissions: "Permissions",
  agent: "Agent",
  trusted: "Trusted Folders",
  voice: "Voice",
  general: "General",
  about: "About",
};

/** Keyword aliases so search hits on common synonyms (e.g. "theme" matches
 *  Appearance, "login" matches API Keys). */
const TAB_KEYWORDS: Record<SettingsTab, string[]> = {
  models: ["model", "llm", "provider", "openai", "anthropic", "grok", "xai", "dashscope", "qwen"],
  apikeys: ["api", "key", "token", "secret", "credential", "login", "auth"],
  mcp: ["mcp", "model context protocol", "server"],
  plugins: ["plugin", "marketplace", "extension", "addon"],
  worktrees: ["worktree", "git", "branch", "checkout"],
  appearance: ["theme", "dark", "light", "font", "size", "zoom", "color"],
  permissions: ["permission", "allow", "deny", "approve", "boundary", "whitelist"],
  agent: ["agent", "subagent", "autonomous", "effort", "reasoning"],
  trusted: ["trust", "folder", "directory", "workspace", "safe"],
  voice: ["voice", "speech", "stt", "tts", "microphone", "audio"],
  general: ["general", "startup", "autostart", "notification", "update", "shortcut", "tray"],
  about: ["about", "version", "info"],
};

export function Settings({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) {
  const [tab, setTab] = useState<SettingsTab>(
    (initialTab as SettingsTab | undefined) && initialTab! in TAB_LABELS
      ? (initialTab as SettingsTab)
      : "models"
  );
  const [query, setQuery] = useState("");

  const visibleTabs = useMemo(() => {
    if (!query.trim()) return Object.keys(TAB_LABELS) as SettingsTab[];
    const q = query.toLowerCase();
    return (Object.keys(TAB_LABELS) as SettingsTab[]).filter((id) => {
      const label = TAB_LABELS[id].toLowerCase();
      if (label.includes(q)) return true;
      return TAB_KEYWORDS[id].some((k) => k.includes(q));
    });
  }, [query]);

  // If the active tab is filtered out, jump to the first visible one.
  useEffect(() => {
    if (!visibleTabs.includes(tab) && visibleTabs.length > 0) {
      setTab(visibleTabs[0]);
    }
  }, [visibleTabs, tab]);

  // Honor deep-link changes while the page is open.
  useEffect(() => {
    if (initialTab && initialTab in TAB_LABELS && initialTab !== tab) {
      setTab(initialTab as SettingsTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab]);

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-gb-border/8 px-4">
        <h2 className="text-[13px] font-medium">Settings</h2>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          className="max-w-[240px] flex-1 rounded-md border border-gb-border/10 bg-gb-surface px-2.5 py-1 text-[12px] text-gb-text placeholder:text-gb-muted focus:border-gb-accent/40 focus:outline-none"
          aria-label="Search settings"
        />
        <button className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text" onClick={onClose}>← Back</button>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <nav className="w-44 shrink-0 overflow-y-auto border-r border-gb-border/8 bg-gb-bg-secondary p-1.5">
          {visibleTabs.length === 0 ? (
            <p className="px-2 py-4 text-center text-[11px] text-gb-muted">
              No settings match "{query}"
            </p>
          ) : (
            visibleTabs.map((id) => (
              <button
                key={id}
                className={`mb-0.5 w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                  tab === id ? "bg-gb-surface-hover text-gb-text" : "text-gb-muted hover:text-gb-text"
                }`}
                onClick={() => setTab(id)}
              >
                {TAB_LABELS[id]}
              </button>
            ))
          )}
        </nav>
        <div className="flex-1 overflow-y-auto">
          {tab === "models" && <ModelManager />}
          {tab === "apikeys" && <ApiKeyManager />}
          {tab === "mcp" && <McpManager />}
          {tab === "plugins" && <PluginManager />}
          {tab === "worktrees" && <WorktreeManager />}
          {tab === "appearance" && <AppearanceSettings />}
          {tab === "permissions" && <PermissionsManager />}
          {tab === "agent" && <AgentSettings />}
          {tab === "trusted" && <TrustedFoldersManager />}
          {tab === "voice" && <VoiceSettings />}
          {tab === "general" && <GeneralSettings />}
          {tab === "about" && <div className="p-6"><h3 className="mb-2 text-[15px] font-medium">Grok Build</h3><p className="text-[12px] text-gb-muted">Version 0.1.0</p></div>}
        </div>
      </div>
    </div>
  );
}
