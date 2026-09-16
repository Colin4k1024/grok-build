import { useState, useMemo } from "react";
import { usePermissionsStore, type PermissionRule } from "../../stores/permissionsStore";
import { useSessionStore } from "../../stores/sessionStore";

export function PermissionsManager() {
  const { rules, removeRule, clearAll, clearForSession } = usePermissionsStore();
  const tabs = useSessionStore((s) => s.tabs);
  const [filter, setFilter] = useState("");
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  const sessionTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tabs) map.set(t.id, t.title);
    return map;
  }, [tabs]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return rules;
    const q = filter.toLowerCase();
    return rules.filter(
      (r) =>
        r.toolName.toLowerCase().includes(q) ||
        r.commandPattern.toLowerCase().includes(q)
    );
  }, [rules, filter]);

  const sessionRules = filtered.filter((r) => r.sessionId);
  const globalRules = filtered.filter((r) => !r.sessionId);

  const renderRow = (rule: PermissionRule, idx: number) => (
    <div
      key={`${rule.toolName}|${rule.commandPattern}|${rule.sessionId ?? "global"}|${idx}`}
      className="flex items-center gap-3 rounded-md border border-gb-border/10 bg-gb-surface px-3 py-2"
    >
      <span
        className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
          rule.decision === "allow"
            ? "bg-gb-green/15 text-gb-green"
            : "bg-gb-red/15 text-gb-red"
        }`}
      >
        {rule.decision}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-gb-text">{rule.toolName}</p>
        <p className="truncate font-mono text-[10px] text-gb-muted">{rule.commandPattern}</p>
      </div>
      <span className="shrink-0 text-[10px] text-gb-muted">
        {rule.sessionId
          ? `session: ${sessionTitles.get(rule.sessionId) ?? rule.sessionId.slice(0, 8)}`
          : "global"}
      </span>
      <button
        onClick={() => removeRule(rules.indexOf(rule))}
        className="shrink-0 rounded p-1 text-gb-muted hover:bg-gb-red/10 hover:text-gb-red"
        aria-label="Remove rule"
      >
        ✕
      </button>
    </div>
  );

  return (
    <div className="space-y-4 p-4">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gb-text">Permission boundary</h3>
          {rules.length > 0 && (
            <button
              onClick={() => setConfirmClearAll(true)}
              className="rounded border border-gb-red/30 px-2 py-1 text-[11px] text-gb-red hover:bg-gb-red/10"
            >
              Clear all
            </button>
          )}
        </div>
        <p className="mb-3 text-[11px] leading-relaxed text-gb-muted">
          Commands you've approved or denied are remembered here. Session-scoped
          rules apply only to the conversation where they were granted; global
          rules apply everywhere.
        </p>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by tool or command…"
          className="mb-3 w-full rounded border border-gb-border bg-gb-surface px-3 py-1.5 text-xs text-gb-text"
        />
      </section>

      {rules.length === 0 ? (
        <p className="py-6 text-center text-xs text-gb-muted">
          No remembered permissions yet. The first time a tool asks to run a
          command, choose "Always" to remember your decision here.
        </p>
      ) : (
        <>
          {sessionRules.length > 0 && (
            <section>
              <h4 className="mb-2 text-[11px] font-medium uppercase text-gb-muted">
                Session-scoped ({sessionRules.length})
              </h4>
              <div className="space-y-1.5">{sessionRules.map(renderRow)}</div>
            </section>
          )}
          {globalRules.length > 0 && (
            <section>
              <h4 className="mb-2 text-[11px] font-medium uppercase text-gb-muted">
                Global ({globalRules.length})
              </h4>
              <div className="space-y-1.5">{globalRules.map(renderRow)}</div>
            </section>
          )}
        </>
      )}

      {confirmClearAll && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setConfirmClearAll(false)}
        >
          <div
            className="w-96 rounded-lg border border-gb-border bg-gb-surface-solid p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-sm font-semibold text-gb-text">Clear all permissions?</h3>
            <p className="mb-4 text-xs text-gb-muted">
              Every remembered allow/deny rule will be removed. Future tool
              calls will prompt for approval again.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmClearAll(false)}
                className="rounded border border-gb-border/20 px-3 py-1.5 text-xs text-gb-muted hover:bg-gb-surface-hover"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  clearAll();
                  // Also clear session-scoped rules for every open session so
                  // nothing lingers in-memory.
                  tabs.forEach((t) => clearForSession(t.id));
                  setConfirmClearAll(false);
                }}
                className="rounded bg-gb-red px-3 py-1.5 text-xs font-medium text-white"
              >
                Clear all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
