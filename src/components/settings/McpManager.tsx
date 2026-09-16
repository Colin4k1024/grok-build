import { useState, useEffect, useCallback } from "react";
import { getMcpServers, saveMcpServer, deleteMcpServer, toggleMcpServer } from "../../lib/tauri";
import type { McpServerInfo } from "../../lib/tauri";

export function McpManager() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function handleToggle(name: string, enabled: boolean) {
    try {
      await toggleMcpServer(name, enabled);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete MCP server "${name}"?`)) return;
    try {
      await deleteMcpServer(name);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gb-text">MCP Servers</h3>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded border border-gb-border px-3 py-1 text-xs text-gb-muted hover:bg-gb-surface hover:text-gb-text"
        >
          {showForm ? "Cancel" : "+ Add Server"}
        </button>
      </div>

      {error && (
        <div className="rounded border border-gb-red/30 bg-gb-red/10 px-3 py-2 text-xs text-gb-red">
          {error}
        </div>
      )}

      {showForm && (
        <McpServerForm
          onSave={async (form) => {
            try {
              await saveMcpServer(form);
              setShowForm(false);
              await refresh();
            } catch (e) {
              setError(String(e));
            }
          }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {loading ? (
        <p className="text-xs text-gb-muted">Loading...</p>
      ) : servers.length === 0 ? (
        <p className="py-4 text-center text-xs text-gb-muted">No MCP servers configured</p>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => (
            <div
              key={server.name}
              className="rounded-lg border border-gb-border bg-gb-surface p-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gb-text">{server.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[9px] ${
                    server.enabled
                      ? "bg-gb-green/10 text-gb-green"
                      : "bg-gb-border text-gb-muted"
                  }`}>
                    {server.enabled ? "ENABLED" : "DISABLED"}
                  </span>
                  <span className="rounded bg-gb-bg px-1.5 py-0.5 text-[9px] text-gb-muted">
                    {server.transport_type}
                  </span>
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
                  <button
                    onClick={() => handleDelete(server.name)}
                    className="text-[10px] text-gb-red hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="mt-2 space-y-0.5 text-[10px] text-gb-muted">
                {server.command && <div>Command: <code className="text-gb-text">{server.command}</code></div>}
                {server.args.length > 0 && <div>Args: <code className="text-gb-text">{server.args.join(" ")}</code></div>}
                {server.url && <div>URL: <code className="text-gb-text">{server.url}</code></div>}
                {server.env.length > 0 && (
                  <div>Env: {server.env.map(([k, v]) => `${k}=${v}`).join(", ")}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function McpServerForm({ onSave, onCancel }: {
  onSave: (form: {
    name: string;
    command: string | null;
    args: string[];
    url: string | null;
    env: [string, string][];
    enabled: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");

  const argList = args.trim() ? args.trim().split(/\s+/) : [];
  const envList: [string, string][] = envText
    .trim()
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    });

  return (
    <div className="rounded-lg border border-gb-border bg-gb-surface p-4 space-y-3">
      <div>
        <label className="mb-1 block text-[10px] font-medium text-gb-muted">Server Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-server"
          className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-xs text-gb-text"
        />
      </div>

      <div>
        <label className="mb-1 block text-[10px] font-medium text-gb-muted">Transport</label>
        <div className="flex gap-2">
          <button
            onClick={() => setType("stdio")}
            className={`rounded px-3 py-1 text-xs ${type === "stdio" ? "bg-gb-accent/15 text-gb-text" : "bg-gb-bg text-gb-muted"}`}
          >
            stdio (command)
          </button>
          <button
            onClick={() => setType("http")}
            className={`rounded px-3 py-1 text-xs ${type === "http" ? "bg-gb-accent/15 text-gb-text" : "bg-gb-bg text-gb-muted"}`}
          >
            http (URL)
          </button>
        </div>
      </div>

      {type === "stdio" ? (
        <>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-gb-muted">Command</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-xs text-gb-text"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-medium text-gb-muted">Arguments (space-separated)</label>
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
              className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-xs text-gb-text"
            />
          </div>
        </>
      ) : (
        <div>
          <label className="mb-1 block text-[10px] font-medium text-gb-muted">URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com/sse"
            className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-xs text-gb-text"
          />
        </div>
      )}

      <div>
        <label className="mb-1 block text-[10px] font-medium text-gb-muted">Environment Variables (KEY=value per line)</label>
        <textarea
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          placeholder={"API_KEY=your-key-here"}
          rows={2}
          className="w-full rounded border border-gb-border bg-gb-bg px-3 py-1.5 text-xs text-gb-text"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onSave({
            name,
            command: type === "stdio" ? command || null : null,
            args: argList,
            url: type === "http" ? url || null : null,
            env: envList,
            enabled: true,
          })}
          disabled={!name || (type === "stdio" && !command) || (type === "http" && !url)}
          className="rounded bg-gb-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          Save Server
        </button>
        <button
          onClick={onCancel}
          className="rounded border border-gb-border px-3 py-1.5 text-xs text-gb-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
