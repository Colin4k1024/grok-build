import { useEffect, useRef, useState } from "react";
import {
  login,
  loginWithApiKey,
  listAuthEnvKeys,
  getAuthStatus,
  onAuthMessage,
} from "../lib/tauri";
import type { UnlistenFn } from "../lib/tauri";

export function Login({ onLoginSuccess }: { onLoginSuccess: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [envKeys, setEnvKeys] = useState<string[]>(["XAI_API_KEY"]);
  const [envKey, setEnvKey] = useState("XAI_API_KEY");
  const [apiKey, setApiKey] = useState("");
  const [oauthAvailable, setOauthAvailable] = useState(false);
  const [devMode, setDevMode] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);

  useEffect(() => {
    onAuthMessage((msg) => {
      setMessages((prev) => [...prev, msg]);
    }).then((fn) => {
      unlistenRef.current = fn;
    });
    listAuthEnvKeys().then((keys) => {
      if (keys.length > 0) {
        setEnvKeys(keys);
        if (!keys.includes("XAI_API_KEY")) setEnvKey(keys[0]);
      }
    });
    // Which auth surface applies: dev rollback flag, OAuth endpoint, or
    // API-key first screen (ISS-073).
    getAuthStatus().then((s) => {
      setDevMode(s.mode === "dev");
      setOauthAvailable(!!s.oauthAvailable);
    });
    return () => {
      unlistenRef.current?.();
    };
  }, []);

  const handleOAuth = async () => {
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

  const handleApiKeyLogin = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError("请输入 API Key");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await loginWithApiKey(envKey, trimmed);
      // Auto-complete onboarding on first successful auth
      try { localStorage.setItem("gb-onboarding-completed", "true"); } catch {}
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

        <div className="mb-3 text-left">
          <label className="mb-1 block text-[11px] font-medium text-gb-muted">密钥类型</label>
          <select
            value={envKey}
            onChange={(e) => setEnvKey(e.target.value)}
            className="w-full rounded-lg border border-gb-border/20 bg-gb-bg px-3 py-2 text-sm text-gb-text outline-none"
          >
            {envKeys.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
        <div className="mb-4 text-left">
          <label className="mb-1 block text-[11px] font-medium text-gb-muted">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleApiKeyLogin();
            }}
            placeholder="xai-…"
            className="w-full rounded-lg border border-gb-border/20 bg-gb-bg px-3 py-2 text-sm text-gb-text outline-none focus:border-gb-accent/50"
          />
          <p className="mt-1 text-[10px] text-gb-muted">
            存储于本机（0600 文件 + macOS 钥匙串写穿透），仅用于启动 agent。
          </p>
        </div>

        <button
          className="w-full rounded-lg bg-gb-accent px-4 py-3 text-sm font-medium text-gb-bg hover:opacity-80 disabled:opacity-40"
          onClick={handleApiKeyLogin}
          disabled={loading}
        >
          {loading ? "验证中…" : "使用 API Key 登录"}
        </button>

        {oauthAvailable && (
          <button
            className="mt-2 w-full rounded-lg border border-gb-border/20 px-4 py-2.5 text-xs text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
            onClick={handleOAuth}
            disabled={loading}
          >
            使用 OAuth 登录
          </button>
        )}

        {devMode && (
          <button
            className="mt-2 w-full rounded-lg border border-gb-border/20 px-4 py-2.5 text-xs text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
            onClick={onLoginSuccess}
          >
            Skip for now (dev mode)
          </button>
        )}
      </div>
    </div>
  );
}
