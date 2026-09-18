import { useCallback, useEffect, useState } from "react";
import {
  listProjects,
  addProject,
  removeProject,
  pickDirectory,
  type ProjectEntry,
} from "../../lib/tauri";

function projectName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

interface ProjectListProps {
  /** Start a new session rooted at the given project directory. */
  onOpenProject: (cwd: string) => void;
  disabled?: boolean;
}

export function ProjectList({ onOpenProject, disabled }: ProjectListProps) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listProjects().then(setProjects).catch(() => {});
  }, []);

  const handleAdd = useCallback(async () => {
    setBusy(true);
    try {
      const dir = await pickDirectory();
      if (dir) {
        setProjects(await addProject(dir));
      }
    } catch (e) {
      console.error("[projects] add failed:", e);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRemove = useCallback(async (path: string) => {
    try {
      setProjects(await removeProject(path));
    } catch (e) {
      console.error("[projects] remove failed:", e);
    }
  }, []);

  return (
    <div className="border-b border-gb-border/8 px-2 pb-1">
      <div className="flex items-center justify-between px-1 py-1">
        <button
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-gb-muted hover:text-gb-text"
          onClick={() => setCollapsed((c) => !c)}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="currentColor"
            className={`transition-transform ${collapsed ? "-rotate-90" : ""}`}
          >
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          </svg>
          Projects
        </button>
        <button
          className="rounded p-0.5 text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text disabled:opacity-30"
          onClick={handleAdd}
          disabled={busy}
          title="添加项目目录"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {!collapsed && (
        <div className="space-y-0.5">
          {projects.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-gb-muted/70">
              No projects yet — click + to add a directory.
            </div>
          )}
          {projects.map((p) => (
            <div
              key={p.path}
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-gb-text hover:bg-gb-surface-hover"
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2"
                onClick={() => onOpenProject(p.path)}
                disabled={disabled}
                title={`${p.path}\nClick to start a session here`}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="shrink-0 text-gb-muted">
                  <path
                    d="M2 4.5A1.5 1.5 0 013.5 3h2.6a1.5 1.5 0 011.06.44l.88.88a1.5 1.5 0 001.06.44H12.5A1.5 1.5 0 0114 6.26v5.24a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                </svg>
                <span className="truncate">{projectName(p.path)}</span>
              </button>
              <button
                className="hidden shrink-0 rounded p-0.5 text-gb-muted hover:bg-gb-bg-primary hover:text-gb-text group-hover:block"
                onClick={() => handleRemove(p.path)}
                title="从项目中移除"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
