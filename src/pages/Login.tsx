import { useEffect, useRef, useState } from "react";
import { login, onAuthMessage } from "../lib/tauri";
import type { UnlistenFn } from "@tauri-apps/api/event";

export function Login({ onLoginSuccess }: { onLoginSuccess: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    onAuthMessage((msg) => {
      setMessages((prev) => [...prev, msg]);
    }).then((fn) => {
      unlistenRef.current = fn;
    });
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    setMessages([]);
    try {
      await login();
      onLoginSuccess();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-gb-bg">
      <div className="w-96 rounded-xl border border-gb-border bg-gb-surface p-8 text-center">
        <h1 className="mb-2 text-2xl font-bold text-gb-text">Grok Build</h1>
        <p className="mb-6 text-sm text-gb-muted">
          Sign in to start coding with your AI assistant
        </p>

        {error && (
          <div className="mb-4 rounded border border-gb-red/30 bg-gb-red/10 p-2 text-xs text-gb-red">
            {error}
          </div>
        )}

        {messages.length > 0 && (
          <div className="mb-4 max-h-32 overflow-y-auto rounded border border-gb-border bg-gb-bg p-2 text-left text-xs text-gb-muted">
            {messages.map((msg, i) => (
              <div key={i} className="whitespace-pre-wrap">{msg}</div>
            ))}
          </div>
        )}

        <button
          className="w-full rounded-lg bg-gb-accent px-4 py-3 text-sm font-medium text-white hover:opacity-80 disabled:opacity-40"
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? "Opening browser..." : "Sign in with OAuth"}
        </button>

        <p className="mt-4 text-xs text-gb-muted">
          A browser window will open for authentication.
        </p>
      </div>
    </div>
  );
}
