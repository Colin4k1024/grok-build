import { useEffect, useState } from "react";
import { getAuthStatus, type AuthStatus } from "../lib/tauri";

/**
 * Auth handoff page — rendered at /auth-handoff (or when the URL carries
 * ?auth=handoff). Waits for the OAuth callback to complete by polling the
 * backend's auth status, then either returns the user to the main window or
 * shows a manual fallback.
 */
export function AuthHandoff() {
  const [status, setStatus] = useState<"waiting" | "success" | "failed">("waiting");
  const [elapsed, setElapsed] = useState(0);
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    const poll = async () => {
      try {
        const s = await getAuthStatus();
        if (cancelled) return;
        setAuth(s);
        if (s.authenticated) {
          setStatus("success");
          return;
        }
      } catch {
        /* backend still starting */
      }
      if (!cancelled && Date.now() - startedAt < 120_000) {
        setTimeout(poll, 1500);
      } else if (!cancelled) {
        setStatus("failed");
      }
    };
    poll();

    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Auto-redirect shortly after success so the "Redirecting…" copy is honest.
  useEffect(() => {
    if (status !== "success") return;
    const t = setTimeout(() => {
      window.location.href = "/";
    }, 1500);
    return () => clearTimeout(t);
  }, [status]);

  const handleFinish = () => {
    window.location.href = "/";
  };

  return (
    <div className="flex h-screen items-center justify-center bg-gb-bg">
      <div className="w-full max-w-md rounded-lg border border-gb-border/10 bg-gb-surface-solid p-8 text-center shadow-2xl">
        {status === "waiting" && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gb-accent/15">
              <svg className="h-6 w-6 animate-spin text-gb-accent" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
            </div>
            <h1 className="mb-1 text-lg font-semibold text-gb-text">Waiting for sign-in…</h1>
            <p className="mb-4 text-[13px] text-gb-muted">
              Complete the sign-in flow in your browser. This page will update automatically.
            </p>
            <p className="text-[11px] tabular-nums text-gb-muted">{elapsed}s elapsed</p>
          </>
        )}

        {status === "success" && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gb-green/15">
              <svg className="h-6 w-6 text-gb-green" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h1 className="mb-1 text-lg font-semibold text-gb-text">Signed in</h1>
            <p className="mb-4 text-[13px] text-gb-muted">
              Welcome back{auth?.username ? `, ${auth.username}` : ""}. Redirecting…
            </p>
            <button
              onClick={handleFinish}
              className="rounded-md bg-gb-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
            >
              Continue
            </button>
          </>
        )}

        {status === "failed" && (
          <>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gb-red/15">
              <span className="text-xl text-gb-red">✗</span>
            </div>
            <h1 className="mb-1 text-lg font-semibold text-gb-text">Sign-in timed out</h1>
            <p className="mb-4 text-[13px] text-gb-muted">
              We didn't receive confirmation within 2 minutes. Please try again.
            </p>
            <button
              onClick={handleFinish}
              className="rounded-md border border-gb-border/20 px-4 py-2 text-[13px] text-gb-text hover:bg-gb-surface-hover"
            >
              Back to app
            </button>
          </>
        )}
      </div>
    </div>
  );
}
