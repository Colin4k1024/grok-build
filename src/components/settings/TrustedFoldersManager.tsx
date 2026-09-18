import { useState, useEffect, useCallback } from "react";

const TRUSTED_KEY = "gb-trusted-folders";

export function getTrustedFolders(): string[] {
  try {
    return JSON.parse(localStorage.getItem(TRUSTED_KEY) || "[]");
  } catch {
    return [];
  }
}

export function isFolderTrusted(path: string): boolean {
  return getTrustedFolders().includes(path);
}

export function trustFolder(path: string) {
  const list = getTrustedFolders();
  if (!list.includes(path)) {
    localStorage.setItem(TRUSTED_KEY, JSON.stringify([...list, path]));
  }
}

export function untrustFolder(path: string) {
  localStorage.setItem(
    TRUSTED_KEY,
    JSON.stringify(getTrustedFolders().filter((p) => p !== path))
  );
}

export function TrustedFoldersManager() {
  const [folders, setFolders] = useState<string[]>(getTrustedFolders());
  const [newPath, setNewPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Keep local state in sync if other tabs mutate the list.
    const onStorage = (e: StorageEvent) => {
      if (e.key === TRUSTED_KEY) setFolders(getTrustedFolders());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const handleAdd = useCallback(() => {
    const trimmed = newPath.trim();
    if (!trimmed) return;
    if (folders.includes(trimmed)) {
      setError("该目录已受信任");
      return;
    }
    trustFolder(trimmed);
    setFolders(getTrustedFolders());
    setNewPath("");
    setError(null);
  }, [newPath, folders]);

  const handleRemove = useCallback((path: string) => {
    untrustFolder(path);
    setFolders(getTrustedFolders());
  }, []);

  return (
    <div className="space-y-4 p-4">
      <section>
        <h3 className="mb-2 text-sm font-semibold text-gb-text">受信任目录</h3>
        <p className="mb-3 text-[11px] leading-relaxed text-gb-muted">
          Sessions running inside a trusted folder skip the "Trust this
          directory?" prompt and can execute pre-approved commands without an
          extra confirmation step. Be selective.
        </p>
      </section>

      <section className="space-y-1.5">
        {folders.length === 0 ? (
          <p className="rounded-lg border border-gb-border bg-gb-surface px-4 py-6 text-center text-xs text-gb-muted">
            No trusted folders yet.
          </p>
        ) : (
          folders.map((path) => (
            <div
              key={path}
              className="flex items-center justify-between gap-2 rounded-lg border border-gb-border bg-gb-surface px-3 py-2"
            >
              <span className="truncate font-mono text-xs text-gb-text">{path}</span>
              <button
                onClick={() => handleRemove(path)}
                className="shrink-0 rounded px-2 py-1 text-[11px] text-gb-red hover:bg-gb-red/10"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </section>

      <section>
        <h4 className="mb-2 text-[11px] font-medium uppercase text-gb-muted">添加目录</h4>
        <div className="flex gap-2">
          <input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            placeholder="/绝对路径/到/项目"
            className="flex-1 rounded border border-gb-border bg-gb-surface px-3 py-1.5 font-mono text-xs text-gb-text outline-none focus:border-gb-accent/50"
          />
          <button
            onClick={handleAdd}
            disabled={!newPath.trim()}
            className="rounded bg-gb-accent px-3 py-1.5 text-xs font-medium text-gb-bg hover:opacity-85 disabled:opacity-30"
          >
            Trust
          </button>
        </div>
        {error && <p className="mt-1 text-[11px] text-gb-red">{error}</p>}
      </section>
    </div>
  );
}
