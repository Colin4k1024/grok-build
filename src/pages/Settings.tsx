import { useState } from "react";
import { ModelManager } from "../components/settings/ModelManager";
import { ApiKeyManager } from "../components/settings/ApiKeyManager";
import { GeneralSettings } from "../components/settings/GeneralSettings";
import { AppearanceSettings } from "../components/settings/AppearanceSettings";
import { McpManager } from "../components/settings/McpManager";
import { PluginManager } from "../components/settings/PluginManager";
import { WorktreeManager } from "../components/settings/WorktreeManager";

type SettingsTab = "models" | "apikeys" | "mcp" | "plugins" | "worktrees" | "appearance" | "general" | "about";

export function Settings({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("models");
  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "models", label: "Models" }, { id: "apikeys", label: "API Keys" }, { id: "mcp", label: "MCP Servers" },
    { id: "plugins", label: "Plugins" }, { id: "worktrees", label: "Worktrees" },
    { id: "appearance", label: "Appearance" }, { id: "general", label: "General" }, { id: "about", label: "About" },
  ];

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-gb-border/8 px-4">
        <h2 className="text-[13px] font-medium">Settings</h2>
        <button className="flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text" onClick={onClose}>← Back</button>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <nav className="w-44 shrink-0 border-r border-gb-border/8 bg-gb-bg-secondary p-1.5">
          {tabs.map(t => (
            <button key={t.id} className={`mb-0.5 w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors ${tab === t.id ? "bg-gb-surface-hover text-gb-text" : "text-gb-muted hover:text-gb-text"}`} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto">
          {tab === "models" && <ModelManager />}
          {tab === "apikeys" && <ApiKeyManager />}
          {tab === "mcp" && <McpManager />}
          {tab === "plugins" && <PluginManager />}
          {tab === "worktrees" && <WorktreeManager />}
          {tab === "appearance" && <AppearanceSettings />}
          {tab === "general" && <GeneralSettings />}
          {tab === "about" && <div className="p-6"><h3 className="mb-2 text-[15px] font-medium">Grok Build</h3><p className="text-[12px] text-gb-muted">Version 0.1.0</p></div>}
        </div>
      </div>
    </div>
  );
}
