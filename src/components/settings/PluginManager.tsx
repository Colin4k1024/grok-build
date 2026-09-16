import { useState, useEffect, useCallback } from "react";
import { getMcpServers, saveMcpServer, deleteMcpServer, toggleMcpServer } from "../../lib/tauri";
import type { McpServerInfo } from "../../lib/tauri";

interface CatalogEntry {
  name: string;
  description: string;
  category: string;
  command: string;
  args: string[];
  envKeys: string[];
  url?: string;
  icon: string;
}

const CATALOG: CatalogEntry[] = [
  {
    name: "filesystem",
    description: "Read, write, and search files on the local filesystem",
    category: "Development",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/"],
    envKeys: [],
    icon: "📁",
  },
  {
    name: "github",
    description: "Manage GitHub repos, issues, PRs, and code search",
    category: "Development",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    icon: "🐙",
  },
  {
    name: "slack",
    description: "Search and send messages in Slack workspaces",
    category: "Communication",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    envKeys: ["SLACK_BOT_TOKEN"],
    icon: "💬",
  },
  {
    name: "google-drive",
    description: "Search and read files from Google Drive",
    category: "Productivity",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-drive"],
    envKeys: ["GOOGLE_DRIVE_OAUTH_TOKEN"],
    icon: "📁",
  },
  {
    name: "postgres",
    description: "Execute SQL queries against a PostgreSQL database",
    category: "Data",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    envKeys: ["DATABASE_URL"],
    icon: "🗄️",
  },
  {
    name: "brave-search",
    description: "Web and local search via Brave Search API",
    category: "Search",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envKeys: ["BRAVE_API_KEY"],
    icon: "🔍",
  },
  {
    name: "memory",
    description: "Persistent key-value memory store for agent context",
    category: "Utility",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    envKeys: [],
    icon: "🧠",
  },
  {
    name: "puppeteer",
    description: "Browser automation — navigate, screenshot, click, fill forms",
    category: "Automation",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    envKeys: [],
    icon: "🎭",
  },
  {
    name: "sequential-thinking",
    description: "Dynamic problem-solving through thought sequencing",
    category: "Utility",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    envKeys: [],
    icon: "💭",
  },
  {
    name: "time",
    description: "Time zone conversion and current time",
    category: "Utility",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-time"],
    envKeys: [],
    icon: "⏰",
  },
];

const CATEGORIES = ["All", "Development", "Communication", "Productivity", "Data", "Search", "Utility", "Automation"];

export function PluginManager() {
  const [view, setView] = useState<"marketplace" | "installed">("marketplace");
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getMcpServers();
      setServers(list);
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const installedNames = new Set(servers.map((s) => s.name));

  const filtered = CATALOG.filter((entry) => {
    const matchesCategory = category === "All" || entry.category === category;
    const matchesSearch =
      entry.name.toLowerCase().includes(search.toLowerCase()) ||
      entry.description.toLowerCase().includes(search.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  async function handleInstall(entry: CatalogEntry) {
    setInstalling(entry.name);
    setError(null);
    try {
      const env: [string, string][] = entry.envKeys.map((k) => [k, ""]);
      await saveMcpServer({
        name: entry.name,
        command: entry.command,
        args: entry.args,
        url: entry.url || null,
        env,
        enabled: true,
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
    setInstalling(null);
  }

  async function handleToggle(name: string, enabled: boolean) {
    try {
      await toggleMcpServer(name, enabled);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleUninstall(name: string) {
    if (!confirm(`Uninstall "${name}"?`)) return;
    try {
      await deleteMcpServer(name);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setView("marketplace")}
          className={`rounded px-3 py-1.5 text-xs font-medium ${
            view === "marketplace" ? "bg-gb-accent/15 text-gb-text" : "text-gb-muted hover:bg-gb-surface"
          }`}
        >
          Marketplace
        </button>
        <button
          onClick={() => setView("installed")}
          className={`rounded px-3 py-1.5 text-xs font-medium ${
            view === "installed" ? "bg-gb-accent/15 text-gb-text" : "text-gb-muted hover:bg-gb-surface"
          }`}
        >
          Installed ({servers.length})
        </button>
      </div>

      {error && (
        <div className="rounded border border-gb-red/30 bg-gb-red/10 px-3 py-2 text-xs text-gb-red">{error}</div>
      )}

      {view === "marketplace" ? (
        <>
          <div className="flex gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plugins..."
              className="flex-1 rounded border border-gb-border bg-gb-surface px-3 py-1.5 text-xs text-gb-text"
            />
          </div>

          <div className="flex flex-wrap gap-1">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                className={`rounded px-2 py-1 text-[10px] ${
                  category === cat ? "bg-gb-accent/15 text-gb-text" : "bg-gb-surface text-gb-muted"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {filtered.map((entry) => {
              const installed = installedNames.has(entry.name);
              return (
                <div key={entry.name} className="rounded-lg border border-gb-border bg-gb-surface p-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{entry.icon}</span>
                      <div>
                        <p className="text-xs font-medium text-gb-text">{entry.name}</p>
                        <p className="text-[9px] text-gb-muted">{entry.category}</p>
                      </div>
                    </div>
                    {installed ? (
                      <span className="rounded bg-gb-green/10 px-1.5 py-0.5 text-[9px] text-gb-green">INSTALLED</span>
                    ) : (
                      <button
                        onClick={() => handleInstall(entry)}
                        disabled={installing === entry.name}
                        className="rounded bg-gb-accent px-2 py-1 text-[10px] text-white disabled:opacity-50"
                      >
                        {installing === entry.name ? "Installing..." : "Install"}
                      </button>
                    )}
                  </div>
                  <p className="mt-2 text-[10px] text-gb-muted">{entry.description}</p>
                  {entry.envKeys.length > 0 && (
                    <p className="mt-1 text-[9px] text-gb-yellow">Requires: {entry.envKeys.join(", ")}</p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="space-y-2">
          {loading ? (
            <p className="text-xs text-gb-muted">Loading...</p>
          ) : servers.length === 0 ? (
            <p className="py-4 text-center text-xs text-gb-muted">No plugins installed</p>
          ) : (
            servers.map((server) => (
              <div key={server.name} className="rounded-lg border border-gb-border bg-gb-surface p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gb-text">{server.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[9px] ${
                      server.enabled ? "bg-gb-green/10 text-gb-green" : "bg-gb-border text-gb-muted"
                    }`}>
                      {server.enabled ? "ENABLED" : "DISABLED"}
                    </span>
                    <span className="rounded bg-gb-bg px-1.5 py-0.5 text-[9px] text-gb-muted">{server.transport_type}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleToggle(server.name, !server.enabled)}
                      className={`relative h-4 w-7 rounded-full transition-colors ${
                        server.enabled ? "bg-gb-accent" : "bg-gb-border"
                      }`}
                    >
                      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                        server.enabled ? "translate-x-3" : "translate-x-0.5"
                      }`} />
                    </button>
                    <button onClick={() => handleUninstall(server.name)} className="text-[10px] text-gb-red hover:underline">
                      Uninstall
                    </button>
                  </div>
                </div>
                <div className="mt-2 space-y-0.5 text-[10px] text-gb-muted">
                  {server.command && <div>Command: <code className="text-gb-text">{server.command} {server.args.join(" ")}</code></div>}
                  {server.url && <div>URL: <code className="text-gb-text">{server.url}</code></div>}
                  {server.env.length > 0 && (
                    <div>Env: {server.env.map(([k]) => k).join(", ")}</div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
