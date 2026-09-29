import { useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";

/**
 * Trusted folders manager (R4-07 #240): the settings store is the single
 * source of truth (mirrors the legacy gb-trusted-folders key for the
 * non-React trust checks). Subscribed — never a stale copy.
 */
export function TrustedFoldersManager() {
  const folders = useSettingsStore((s) => s.trustedFolders);
  const addTrustedFolder = useSettingsStore((s) => s.addTrustedFolder);
  const removeTrustedFolder = useSettingsStore((s) => s.removeTrustedFolder);
  const [newPath, setNewPath] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = newPath.trim();
    if (!trimmed) return;
    if (folders.includes(trimmed)) {
      setError("该目录已受信任");
      return;
    }
    try {
      addTrustedFolder(trimmed);
      setNewPath("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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
                onClick={() => removeTrustedFolder(path)}
                className="shrink-0 rounded px-2 py-1 text-[11px] text-gb-danger-text hover:bg-gb-red/10"
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
            className="rounded bg-gb-accent px-3 py-1.5 text-xs font-medium text-gb-accent-fg hover:opacity-85 disabled:opacity-30"
          >
            Trust
          </button>
        </div>
        {error && <p className="mt-1 text-[11px] text-gb-danger-text">{error}</p>}
      </section>
    </div>
  );
}
