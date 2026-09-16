import { useState } from "react";
import { ModelManager } from "../components/settings/ModelManager";
import { ApiKeyManager } from "../components/settings/ApiKeyManager";
import { GeneralSettings } from "../components/settings/GeneralSettings";
import { McpManager } from "../components/settings/McpManager";
import { PluginManager } from "../components/settings/PluginManager";

type SettingsTab = "models" | "apikeys" | "mcp" | "plugins" | "general" | "about";

export function Settings({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("models");

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: "models", label: "Models" },
    { id: "apikeys", label: "API Keys" },
    { id: "mcp", label: "MCP Servers" },
    { id: "plugins", label: "Plugins" },
    { id: "general", label: "General" },
    { id: "about", label: "About" },
  ];

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-gb-border bg-gb-surface px-4">
        <h2 className="text-sm font-semibold">Settings</h2>
        <button
          className="rounded px-2 py-1 text-xs text-gb-muted hover:bg-gb-bg hover:text-gb-text"
          onClick={onClose}
        >
          ← Back to Chat
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Tab sidebar */}
        <nav className="w-40 shrink-0 border-r border-gb-border bg-gb-surface p-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`mb-1 w-full rounded-md px-3 py-2 text-left text-xs transition-colors ${
                tab === t.id
                  ? "bg-gb-accent/15 text-gb-text font-medium"
                  : "text-gb-muted hover:bg-gb-bg hover:text-gb-text"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {tab === "models" && <ModelManager />}
          {tab === "apikeys" && <ApiKeyManager />}
          {tab === "mcp" && <McpManager />}
          {tab === "plugins" && <PluginManager />}
          {tab === "general" && <GeneralSettings />}
          {tab === "about" && (
            <div className="p-4">
              <h3 className="mb-2 text-sm font-semibold text-gb-text">Grok Build Desktop</h3>
              <p className="text-xs text-gb-muted">Version 0.1.0</p>
              <p className="mt-2 text-xs text-gb-muted">
                A Tauri-based desktop application for the grok-build AI coding agent.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
