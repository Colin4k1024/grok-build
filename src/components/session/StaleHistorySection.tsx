import { useMemo, useState } from "react";
import { deleteHistorySession, type HistorySession } from "../../lib/tauri";
import { toast } from "../ui";

/**
 * Stale-workspace governance section (R5-02 / #258): history records whose
 * cwd no longer exists on disk are grouped here, out of the normal project
 * groups. Nothing is deleted automatically — the user multi-selects, gets
 * an explicit count + irreversibility warning, and confirms twice. The
 * gb-acp-* shortcut only SELECTS matching leftover test records; deletion
 * always stays a deliberate second action.
 */

/** Basenames of cwds produced by the old un-isolated ACP test suites. */
const TEST_LEFTOVER_RE = /^gb-acp-(transport|recovery)-/;

function cwdBasename(cwd: string): string {
  const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

interface Props {
  entries: HistorySession[];
  /** Archive ids via the caller's existing localStorage archive path. */
  onArchive: (ids: string[]) => void;
  /** Reload history after deletions. */
  onChanged: () => void;
}

export function StaleHistorySection({ entries, onArchive, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const testLeftovers = useMemo(
    () => entries.filter((e) => TEST_LEFTOVER_RE.test(cwdBasename(e.cwd))),
    [entries]
  );

  if (entries.length === 0) return null;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const archiveSelected = () => {
    const ids = [...selected];
    onArchive(ids);
    toast.success(`已归档 ${ids.length} 条记录`);
    setSelected(new Set());
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    setBusy(true);
    let ok = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await deleteHistorySession(id, "");
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    setConfirming(false);
    setSelected(new Set());
    if (failed > 0) {
      toast.error(`删除完成：成功 ${ok} 条，失败 ${failed} 条（失败的记录仍保留在列表中）`);
    } else {
      toast.success(`已永久删除 ${ok} 条记录`);
    }
    onChanged();
  };

  return (
    <div className="mb-2" data-testid="stale-history-section">
      <button
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-gb-muted"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="currentColor"
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          <path d="M2 1l4 3-4 3V1z" />
        </svg>
        不可用工作区
        <span className="ml-1 rounded bg-gb-bg px-1 text-[9px] text-gb-muted">{entries.length}</span>
      </button>

      {open && (
        <div className="px-1">
          <p className="px-2 py-1 text-[10px] leading-relaxed text-gb-muted">
            这些会话的工作目录已不存在。可以勾选后批量归档或永久删除。
          </p>
          <div className="mb-1 flex items-center gap-1 px-2">
            {testLeftovers.length > 0 && (
              <button
                className="rounded bg-gb-bg px-1.5 py-0.5 text-[10px] text-gb-accent-text hover:bg-gb-surface-hover"
                onClick={() => setSelected(new Set(testLeftovers.map((e) => e.id)))}
                title="仅选中旧版测试遗留的会话（不会自动删除）"
              >
                筛出测试遗留（{testLeftovers.length}）
              </button>
            )}
            {selected.size > 0 && (
              <button
                className="rounded px-1.5 py-0.5 text-[10px] text-gb-muted hover:text-gb-text"
                onClick={() => setSelected(new Set())}
              >
                清除选择
              </button>
            )}
          </div>

          {entries.map((e) => (
            <label
              key={e.id}
              className="group mb-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-gb-muted hover:bg-gb-surface-hover"
            >
              <input
                type="checkbox"
                checked={selected.has(e.id)}
                onChange={() => toggle(e.id)}
                aria-label={`选择 ${e.title}`}
              />
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              <span className="shrink-0 truncate text-[9px] text-gb-muted/70" title={e.cwd}>
                {cwdBasename(e.cwd)}
              </span>
            </label>
          ))}

          {selected.size > 0 && !confirming && (
            <div className="mt-1 flex items-center gap-2 px-2 pb-1">
              <button
                className="rounded bg-gb-surface-2 px-2 py-1 text-[11px] text-gb-text hover:bg-gb-surface-hover"
                onClick={archiveSelected}
              >
                归档所选（{selected.size}）
              </button>
              <button
                className="rounded bg-gb-danger/15 px-2 py-1 text-[11px] text-gb-danger-text hover:bg-gb-danger/25"
                onClick={() => setConfirming(true)}
              >
                永久删除所选（{selected.size}）…
              </button>
            </div>
          )}

          {confirming && (
            <div className="mt-1 rounded-md border border-gb-danger/30 bg-gb-danger/5 px-2 py-2" role="alert">
              <p className="text-[11px] text-gb-danger-text">
                将永久删除 {selected.size} 条会话记录，磁盘文件不可恢复。确认删除？
              </p>
              <div className="mt-1.5 flex gap-2">
                <button
                  className="rounded bg-gb-danger px-2 py-1 text-[11px] text-white disabled:opacity-50"
                  onClick={deleteSelected}
                  disabled={busy}
                >
                  {busy ? "删除中…" : `确认删除 ${selected.size} 条`}
                </button>
                <button
                  className="rounded px-2 py-1 text-[11px] text-gb-muted hover:text-gb-text"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
