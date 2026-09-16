import { useState, useEffect } from "react";
import { getAuthStatus, getConfig, type AuthStatus, type ConfigSnapshot } from "./lib/tauri";

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [config, setConfig] = useState<ConfigSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAuthStatus().then(setAuth).catch((e) => setError(String(e)));
    getConfig().then(setConfig).catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="flex h-full flex-col bg-gb-bg text-gb-text">
      {/* Title bar */}
      <header className="flex h-12 items-center justify-between border-b border-gb-border bg-gb-surface px-4">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold">Grok Build</h1>
          {config && (
            <span className="text-xs text-gb-muted">
              {config.default_model}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {auth?.authenticated ? (
            <span className="text-xs text-gb-green">● Connected</span>
          ) : (
            <span className="text-xs text-gb-yellow">● Not logged in</span>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-60 border-r border-gb-border bg-gb-surface p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase text-gb-muted">
            Sessions
          </h2>
          <p className="text-sm text-gb-muted">No active sessions</p>
          <button className="mt-3 w-full rounded bg-gb-accent px-3 py-1.5 text-sm text-white hover:opacity-80">
            + New Session
          </button>
        </aside>

        {/* Chat area */}
        <div className="flex flex-1 flex-col">
          <div className="flex-1 overflow-y-auto p-4">
            {error ? (
              <p className="text-gb-red">{error}</p>
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-gb-muted">
                  Welcome to Grok Build Desktop. Create a session to start.
                </p>
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="border-t border-gb-border p-4">
            <div className="flex items-end gap-2">
              <textarea
                className="flex-1 resize-none rounded border border-gb-border bg-gb-surface px-3 py-2 text-sm outline-none focus:border-gb-accent"
                rows={2}
                placeholder="Type a message... (Cmd+Enter to send)"
                disabled
              />
              <button
                className="rounded bg-gb-accent px-4 py-2 text-sm text-white hover:opacity-80 disabled:opacity-40"
                disabled
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* Status bar */}
      <footer className="flex h-6 items-center justify-between border-t border-gb-border bg-gb-surface px-4 text-xs text-gb-muted">
        <span>Grok Build Desktop v0.1.0</span>
        <span>sandbox: workspace</span>
      </footer>
    </div>
  );
}
