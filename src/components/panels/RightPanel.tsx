import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { SubagentPanel } from "./SubagentPanel";
import { TodoPanel } from "./TodoPanel";
import { ThreadSummaryPanel } from "./ThreadSummaryPanel";
import { DiffViewer } from "../chat/DiffViewer";
import { useSessionStore } from "../../stores/sessionStore";
import {
  getMcpServers, gitStatus, gitDiff, runCommand, createSession, sendMessage,
  onAcpEvent, respondPermission, gitCommit, listWorktrees, removeWorktree, closeSession,
  type McpServerInfo, type GitStatusEntry, type SessionInfo, type AcpEventPayload,
} from "../../lib/tauri";

interface RightPanelProps {
  collapsed: boolean;
}

type MainTab = "files" | "review" | "terminal" | "sidechat";
type ExtraTab = "subagents" | "todo" | "context" | "mcp";

function useActiveCwd(): string | undefined {
  return useSessionStore((s) => s.tabs.find((t) => t.id === s.activeSessionId)?.cwd);
}

const TRIAGE_READ_KEY = "gb-triage-read";
const isWorktreeCwd = (cwd: string) => /-wt-/.test(cwd);

function markTriageRead(cwd: string) {
  try {
    const raw = localStorage.getItem(TRIAGE_READ_KEY);
    const set = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    set.add(cwd);
    localStorage.setItem(TRIAGE_READ_KEY, JSON.stringify([...set]));
    window.dispatchEvent(new CustomEvent("gb-triage-changed"));
  } catch { /* storage unavailable */ }
}

function autoArchiveIfEmpty(cwd: string, entries: GitStatusEntry[]) {
  // Codex triage: runs with no findings are auto-archived (never unread).
  if (entries.length === 0) markTriageRead(cwd);
}

// ---- Files ------------------------------------------------------------------

function FilesPanel({ cwd }: { cwd: string }) {
  const [entries, setEntries] = useState<GitStatusEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    gitStatus(cwd).then(setEntries).catch((e) => setError(String(e)));
  }, [cwd]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (selected) gitDiff(cwd, selected).then(setDiff).catch(() => setDiff(""));
    else setDiff("");
  }, [cwd, selected]);

  if (error) return <p className="px-3 py-8 text-center text-xs text-gb-red">{error}</p>;
  if (entries.length === 0)
    return <p className="py-8 text-center text-xs text-gb-muted">No file changes in this project.</p>;

  return (
    <div className="flex h-full flex-col">
      <div className="max-h-1/2 overflow-y-auto border-b border-gb-border/8 p-1">
        {entries.map((e) => (
          <button
            key={e.file}
            onClick={() => setSelected(e.file)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] ${
              selected === e.file ? "bg-gb-surface-hover text-gb-text" : "text-gb-text-secondary hover:bg-gb-surface-hover"
            }`}
            title={e.file}
          >
            <span className={`w-6 shrink-0 rounded px-1 text-center font-mono text-[9px] ${
              e.status.includes("D") ? "bg-gb-red/15 text-gb-red" : e.status.includes("?") ? "bg-gb-yellow/15 text-gb-yellow" : "bg-gb-green/15 text-gb-green"
            }`}>
              {e.status || "M"}
            </span>
            <span className="truncate">{e.file}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <div className="text-xs">
            <p className="border-b border-gb-border/8 px-2 py-1 font-mono text-[10px] text-gb-muted">{selected}</p>
            {diff ? <DiffViewer oldContent="" newContent={diff} /> : <p className="py-4 text-center text-[11px] text-gb-muted">No tracked diff (untracked or binary?).</p>}
          </div>
        ) : (
          <p className="py-4 text-center text-[11px] text-gb-muted">Select a file to view its diff.</p>
        )}
      </div>
    </div>
  );
}

// ---- Review -----------------------------------------------------------------

function ReviewPanel({ cwd }: { cwd: string }) {
  const [view, setView] = useState<"all" | "last-turn">("all");
  const [diff, setDiff] = useState("");
  const [lastTurnFiles, setLastTurnFiles] = useState<string[]>([]);
  const [lastDiff, setLastDiff] = useState("");
  const [action, setAction] = useState<"none" | "approve" | "revise">("none");
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const prevFilesRef = useRef<Set<string> | null>(null);
  const wasStreaming = useRef(false);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const inTriage = isWorktreeCwd(cwd);

  // Snapshot the change-set when a turn finishes; the delta vs. the previous
  // snapshot is the "last turn" view.
  useEffect(() => {
    if (isStreaming) {
      wasStreaming.current = true;
      return;
    }
    if (!wasStreaming.current) return;
    wasStreaming.current = false;
    gitStatus(cwd)
      .then(async (entries) => {
        autoArchiveIfEmpty(cwd, entries);
        const files = new Set(entries.map((e) => e.file));
        if (prevFilesRef.current) {
          const delta = [...files].filter((f) => !prevFilesRef.current!.has(f));
          setLastTurnFiles(delta);
          if (delta.length > 0) {
            const parts: string[] = [];
            for (const f of delta.slice(0, 20)) {
              try {
                parts.push(await gitDiff(cwd, f));
              } catch { /* file vanished */
              }
            }
            setLastDiff(parts.join("\n"));
          }
        }
        prevFilesRef.current = files;
      })
      .catch(() => {});
  }, [isStreaming, cwd]);

  useEffect(() => {
    if (view === "all") gitDiff(cwd).then(setDiff).catch(() => setDiff(""));
    if (inTriage) markTriageRead(cwd);
  }, [cwd, view, inTriage]);

  const runApprove = async () => {
    try {
      const result = await gitCommit(cwd, input.trim() || "Approved via review queue");
      setNote(result === "nothing-to-commit" ? "Nothing to commit — already clean." : "Committed on the worktree branch.");
      setAction("none");
      setInput("");
      refreshAfterMutation();
    } catch (e) {
      setNote(String(e));
    }
  };

  const runRevise = async () => {
    if (!activeSessionId || !input.trim()) return;
    try {
      useSessionStore.getState().addUserMessage(activeSessionId, input.trim());
      useSessionStore.getState().setStreaming(true);
      await sendMessage(activeSessionId, input.trim());
      setNote("Revision sent to the thread.");
      setAction("none");
      setInput("");
    } catch (e) {
      setNote(String(e));
    }
  };

  const runReject = async () => {
    if (!window.confirm("Discard ALL changes in this worktree and archive the thread?")) return;
    try {
      const wts = await listWorktrees(cwd);
      const main = wts.find((w) => w.is_main);
      if (main) await removeWorktree(main.path, cwd, true);
      if (activeSessionId) {
        await closeSession(activeSessionId);
        useSessionStore.getState().removeTab(activeSessionId);
      }
      markTriageRead(cwd);
      refreshAfterMutation();
      setNote("Worktree removed and thread archived.");
      setAction("none");
    } catch (e) {
      setNote(String(e));
    }
  };

  // Re-poll status/diff so approve/reject reflect immediately.
  const refreshAfterMutation = useCallback(() => {
    gitDiff(cwd).then(setDiff).catch(() => {});
  }, [cwd]);

  if (view === "last-turn") {
    return (
      <div className="flex h-full flex-col">
        <ViewToggle view={view} onChange={setView} />
        <div className="min-h-0 flex-1 overflow-auto p-1 text-xs">
          {lastTurnFiles.length === 0 ? (
            <p className="py-6 text-center text-[11px] text-gb-muted">No turn captured yet — the view fills after the next turn completes.</p>
          ) : (
            <>
              <p className="px-1 pb-1 text-[10px] text-gb-muted">{lastTurnFiles.length} file(s) changed in the last turn</p>
              {lastDiff ? <DiffViewer oldContent="" newContent={lastDiff} /> : null}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ViewToggle view={view} onChange={setView} />
      {inTriage && (
        <div className="border-b border-gb-border/8 p-1.5">
          {action === "none" ? (
            <div className="flex gap-1">
              <button onClick={runApprove} className="flex-1 rounded bg-gb-green/15 px-2 py-1 text-[10px] font-medium text-gb-green hover:bg-gb-green/25" title="Stage all + commit">Approve</button>
              <button onClick={() => setAction("revise")} className="flex-1 rounded bg-gb-accent/15 px-2 py-1 text-[10px] font-medium text-gb-accent hover:bg-gb-accent/25" title="Send changes back to the thread">Revise</button>
              <button onClick={runReject} className="flex-1 rounded bg-gb-red/15 px-2 py-1 text-[10px] font-medium text-gb-red hover:bg-gb-red/25" title="Discard the worktree">Reject</button>
            </div>
          ) : (
            <div className="space-y-1">
              <textarea
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={2}
                placeholder={action === "approve" ? "Commit message…" : "What should change?…"}
                className="w-full rounded border border-gb-border/10 bg-gb-bg px-2 py-1 text-[11px] text-gb-text outline-none focus:border-gb-accent/50"
              />
              <div className="flex gap-1">
                <button onClick={action === "approve" ? runApprove : runRevise} className="flex-1 rounded bg-gb-accent px-2 py-1 text-[10px] font-medium text-white disabled:opacity-40" disabled={!input.trim()}>
                  {action === "approve" ? "Commit" : "Send"}
                </button>
                <button onClick={() => setAction("none")} className="flex-1 rounded border border-gb-border/20 px-2 py-1 text-[10px] text-gb-muted hover:bg-gb-surface-hover">Cancel</button>
              </div>
            </div>
          )}
          {note && <p className="mt-1 text-[10px] text-gb-muted">{note}</p>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {diff ? <DiffViewer oldContent="" newContent={diff} /> : <p className="py-6 text-center text-[11px] text-gb-muted">No changes vs HEAD.</p>}
      </div>
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: "all" | "last-turn"; onChange: (v: "all" | "last-turn") => void }) {
  return (
    <div className="flex gap-0.5 border-b border-gb-border/8 p-1">
      {([["all", "All changes"], ["last-turn", "Last turn"]] as const).map(([id, label]) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`rounded px-2 py-0.5 text-[10px] font-medium ${
            view === id ? "bg-gb-accent/15 text-gb-accent" : "text-gb-muted hover:bg-gb-surface-hover hover:text-gb-text"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ---- Terminal ---------------------------------------------------------------

function TerminalPanel({ cwd }: { cwd: string }) {
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || running) return;
    setRunning(true);
    setHistory((h) => [cmd, ...h].slice(0, 50));
    setHistIdx(-1);
    setOutput((o) => `${o}$ ${cmd}\n`);
    setCommand("");
    try {
      const r = await runCommand(cwd, cmd);
      setOutput((o) => o + (r.stdout || "") + (r.stderr || "") + "\n");
    } catch (e) {
      setOutput((o) => o + String(e) + "\n");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-[#1c1c1c]">
      <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed text-gb-text whitespace-pre-wrap">
        {output || "Commands run in the project directory. Output is capped; not an interactive PTY.\n"}
      </div>
      <div className="flex items-center gap-1 border-t border-gb-border/8 px-2 py-1.5">
        <span className="shrink-0 font-mono text-[11px] text-gb-accent">$</span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
            else if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const i = Math.min(histIdx + 1, history.length - 1);
              setHistIdx(i);
              setCommand(history[i]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const i = histIdx - 1;
              setHistIdx(i);
              setCommand(i >= 0 ? history[i] : "");
            }
          }}
          placeholder="e.g. npm test"
          className="flex-1 bg-transparent font-mono text-[11px] text-gb-text outline-none placeholder:text-gb-muted"
        />
        <button onClick={run} disabled={running} className="shrink-0 rounded bg-gb-surface-hover px-2 py-0.5 text-[10px] text-gb-text disabled:opacity-40">
          {running ? "…" : "Run"}
        </button>
      </div>
    </div>
  );
}

// ---- Side chat --------------------------------------------------------------

interface SideChatMessage {
  role: "user" | "assistant";
  content: string;
}

function SideChatPanel({ cwd }: { cwd: string }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [messages, setMessages] = useState<SideChatMessage[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  // Own event listener: events for the side session render here and are
  // filtered out of the main thread by the tab-membership guard.
  useEffect(() => {
    if (!session) return;
    const unlisten = onAcpEvent((event: AcpEventPayload) => {
      if (event.session_id !== session.id) return;
      if (event.type === "TextDelta" && event.delta) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, content: last.content + event.delta! }];
          }
          return [...prev, { role: "assistant", content: event.delta! }];
        });
      } else if (event.type === "PermissionRequest" && event.request_id) {
        // Side chat is read-only Q&A — auto-allow to keep it friction-free.
        const allow = (event.options ?? []).find((o) => o.kind.toLowerCase().startsWith("allow"));
        if (allow) respondPermission(session.id, event.request_id, allow.id, false).catch(() => {});
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [session]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      let sid = session;
      if (!sid) {
        sid = await createSession(cwd);
        setSession(sid);
      }
      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      setText("");
      await sendMessage(sid.id, trimmed);
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${String(e)}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {messages.length === 0 && (
          <p className="py-6 text-center text-[11px] text-gb-muted">
            Side questions that don't derail the main thread. Uses its own agent session in this project.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`rounded-md px-2 py-1.5 text-[11px] ${m.role === "user" ? "gb-user-bubble text-gb-text" : "bg-gb-surface text-gb-text"}`}>
            <p className="mb-0.5 text-[9px] uppercase text-gb-muted">{m.role}</p>
            <p className="whitespace-pre-wrap">{m.content}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 border-t border-gb-border/8 p-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask sideways…"
          className="flex-1 rounded border border-gb-border/10 bg-gb-bg px-2 py-1 text-[11px] text-gb-text outline-none focus:border-gb-accent/50"
        />
        <button onClick={send} disabled={busy || !text.trim()} className="shrink-0 rounded bg-gb-accent px-2 py-1 text-[10px] font-medium text-white disabled:opacity-40">
          Send
        </button>
      </div>
    </div>
  );
}

// ---- Legacy extras (capability preservation) --------------------------------

function McpPanel() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getMcpServers()
      .then((list) => {
        if (!cancelled) setServers(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="py-8 text-center text-xs text-gb-muted">Loading MCP servers…</p>;
  if (error) return <p className="py-8 px-3 text-center text-xs text-gb-red">{error}</p>;
  if (servers.length === 0)
    return (
      <p className="py-8 px-3 text-center text-xs text-gb-muted">
        No MCP servers configured.
        <br />
        Add one under Settings → MCP Servers.
      </p>
    );
  return (
    <div className="space-y-1 p-2">
      {servers.map((s) => (
        <div key={s.name} className="rounded-md border border-gb-border/10 bg-gb-surface px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gb-text">{s.name}</span>
            <span className={`rounded px-1 text-[9px] ${s.enabled ? "bg-gb-green/15 text-gb-green" : "bg-gb-border text-gb-muted"}`}>
              {s.enabled ? "on" : "off"}
            </span>
            <span className="ml-auto rounded bg-gb-bg px-1 text-[9px] text-gb-muted">{s.transport_type}</span>
          </div>
          {s.command && (
            <p className="mt-1 truncate font-mono text-[10px] text-gb-muted">
              {s.command} {s.args.join(" ")}
            </p>
          )}
          {s.url && <p className="mt-1 truncate font-mono text-[10px] text-gb-muted">{s.url}</p>}
        </div>
      ))}
    </div>
  );
}

export function RightPanel({ collapsed }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<MainTab>("files");
  const [showExtras, setShowExtras] = useState(false);
  const [extraTab, setExtraTab] = useState<ExtraTab>("todo");
  const cwd = useActiveCwd();

  // ⌘J opens the panel directly on the Terminal tab; Triage items open Review.
  useEffect(() => {
    const openTerminal = () => {
      setShowExtras(false);
      setActiveTab("terminal");
    };
    const openReview = () => {
      setShowExtras(false);
      setActiveTab("review");
    };
    window.addEventListener("gb-open-terminal", openTerminal);
    window.addEventListener("gb-open-review", openReview);
    return () => {
      window.removeEventListener("gb-open-terminal", openTerminal);
      window.removeEventListener("gb-open-review", openReview);
    };
  }, []);

  if (collapsed) return null;

  const tabs: { id: MainTab; label: string }[] = [
    { id: "files", label: "Files" },
    { id: "review", label: "Review" },
    { id: "terminal", label: "Terminal" },
    { id: "sidechat", label: "Side chat" },
  ];

  let content: ReactNode;
  if (!cwd) {
    content = <p className="py-8 px-3 text-center text-xs text-gb-muted">Open a thread to use the side panel.</p>;
  } else {
    switch (activeTab) {
      case "files":
        content = <FilesPanel cwd={cwd} />;
        break;
      case "review":
        content = <ReviewPanel cwd={cwd} />;
        break;
      case "terminal":
        content = <TerminalPanel cwd={cwd} />;
        break;
      case "sidechat":
        content = <SideChatPanel cwd={cwd} />;
        break;
    }
  }

  let extraContent: ReactNode;
  switch (extraTab) {
    case "subagents":
      extraContent = <SubagentPanel />;
      break;
    case "todo":
      extraContent = <TodoPanel />;
      break;
    case "context":
      extraContent = <ThreadSummaryPanel />;
      break;
    case "mcp":
      extraContent = <McpPanel />;
      break;
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-gb-border bg-gb-surface">
      <div className="flex items-center border-b border-gb-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`flex-1 px-1 py-2 text-[11px] font-medium transition-colors ${
              activeTab === tab.id ? "border-b-2 border-gb-accent text-gb-text" : "text-gb-muted hover:text-gb-text"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <button
          className={`px-1.5 py-2 text-[10px] transition-colors ${showExtras ? "text-gb-accent" : "text-gb-muted hover:text-gb-text"}`}
          onClick={() => setShowExtras((v) => !v)}
          title="Plans, subagents, context, MCP"
        >
          ▾
        </button>
      </div>
      {showExtras && (
        <div className="flex border-b border-gb-border/8 bg-gb-bg-secondary">
          {(["todo", "subagents", "context", "mcp"] as ExtraTab[]).map((id) => (
            <button
              key={id}
              className={`flex-1 px-1 py-1 text-[10px] capitalize ${
                extraTab === id ? "text-gb-accent" : "text-gb-muted hover:text-gb-text"
              }`}
              onClick={() => setExtraTab(id)}
            >
              {id === "context" ? "summary" : id}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {showExtras ? extraContent : content}
      </div>
    </aside>
  );
}
