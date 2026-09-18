import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { SubagentPanel } from "./SubagentPanel";
import { TodoPanel } from "./TodoPanel";
import { ThreadSummaryPanel } from "./ThreadSummaryPanel";
import { DiffViewer } from "../chat/DiffViewer";
import { useSessionStore } from "../../stores/sessionStore";
import {
  getMcpServers, gitStatus, gitDiff, runCommand, createSession, sendMessage,
  onAcpEvent, respondPermission, gitCommit, listWorktrees, removeWorktree, closeSession,
  gitTurnSnapshot, gitDiffSince, gitConflicted,
  ptySpawn, ptyDispose, ptyEnabled,
  type McpServerInfo, type GitStatusEntry, type SessionInfo, type AcpEventPayload,
  type PtySession,
} from "../../lib/tauri";
import { InteractiveTerminal } from "./InteractiveTerminal";
import { next as reviewNext, ViewVersion, type ReviewState } from "../../lib/reviewMachine";

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
    return <p className="py-8 text-center text-xs text-gb-muted">此项目暂无文件变更。</p>;

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
            {diff ? <DiffViewer oldContent="" newContent={diff} /> : <p className="py-4 text-center text-[11px] text-gb-muted">没有可追踪的 diff（未跟踪或为二进制文件？）。</p>}
          </div>
        ) : (
          <p className="py-4 text-center text-[11px] text-gb-muted">选择一个文件查看 diff。</p>
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
  // ISS-080: review-loop state machine + true turn-base snapshots.
  const [reviewState, setReviewState] = useState<ReviewState>("clean");
  const turnBaseRef = useRef<string | null>(null);
  const diffVersionRef = useRef(new ViewVersion());
  const [conflicts, setConflicts] = useState<string[]>([]);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const inTriage = isWorktreeCwd(cwd);

  // Snapshot the change-set when a turn finishes; the delta vs. the previous
  // snapshot is the "last turn" view.
  useEffect(() => {
    if (isStreaming) {
      if (!wasStreaming.current) {
        // Turn START (ISS-080): capture a dangling worktree snapshot as this
        // turn's diff base; `git stash create` touches nothing on disk.
        gitTurnSnapshot(cwd).then((r) => { turnBaseRef.current = r.sha; }).catch(() => {});
        setReviewState((st) => reviewNext(st, { type: "review-opened" }));
      }
      wasStreaming.current = true;
      return;
    }
    if (!wasStreaming.current) return;
    wasStreaming.current = false;
    setReviewState((st) => reviewNext(st, { type: "agent-turn-completed" }));
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
    if (inTriage) markTriageRead(cwd);
  }, [cwd, inTriage]);

  // Versioned diff fetches (ISS-080): the agent may keep editing mid-fetch —
  // only the newest fetch's result may land, the view never tears.
  useEffect(() => {
    const token = diffVersionRef.current.begin();
    if (view === "all") {
      gitDiff(cwd)
        .then((d) => { if (diffVersionRef.current.accept(token)) setDiff(d); })
        .catch(() => { if (diffVersionRef.current.accept(token)) setDiff(""); });
    } else {
      gitDiffSince(cwd, turnBaseRef.current)
        .then((d) => {
          if (!diffVersionRef.current.accept(token)) return;
          setLastDiff(d);
          setLastTurnFiles(d ? d.split("\n").filter((l) => l.startsWith("diff --git ")) : []);
        })
        .catch(() => { if (diffVersionRef.current.accept(token)) setLastDiff(""); });
    }
    gitConflicted(cwd)
      .then((f) => { if (diffVersionRef.current.accept(token)) setConflicts(f); })
      .catch(() => {});
    gitStatus(cwd)
      .then((entries) => {
        if (!diffVersionRef.current.accept(token)) return;
        setReviewState((st) => reviewNext(st, { type: "files-changed", hasChanges: entries.length > 0 }));
      })
      .catch(() => {});
  }, [cwd, view, isStreaming]);

  const runApprove = async () => {
    const msg = input.trim() || "已通过审查队列批准";
    if (!window.confirm(`将执行:\n  git add -A && git commit -m "${msg}"\n确认提交？`)) return;
    try {
      const result = await gitCommit(cwd, msg);
      setReviewState((st) => reviewNext(st, { type: "committed" }));
      setNote(result === "nothing-to-commit" ? "没有可提交的内容 —— 工作区已是干净的。" : "已在 worktree 分支上提交。");
      setAction("none");
      setInput("");
      refreshAfterMutation();
    } catch (e) {
      setNote(String(e));
    }
  };

  const runRevise = async () => {
    if (!activeSessionId || !input.trim()) return;
    const prompt = `请根据以下 review 意见修订当前改动：\n${input.trim()
      .split("\n")
      .map((l, i) => `${i + 1}. ${l}`)
      .join("\n")}`;
    try {
      setReviewState((st) => reviewNext(st, { type: "changes-requested" }));
      useSessionStore.getState().addUserMessage(activeSessionId, prompt);
      useSessionStore.getState().setStreaming(true);
      await sendMessage(activeSessionId, prompt);
      setNote("修改意见已发送到会话（changes-requested）。");
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
      setNote("Worktree 已移除，会话已归档。");
      setAction("none");
    } catch (e) {
      setNote(String(e));
    }
  };

  // PR helpers (ISS-080): every remote-touching action shows the exact
  // command and requires an explicit second confirmation — never silent.
  const runCommandConfirmed = async (label: string, command: string) => {
    if (!window.confirm(`${label}\n将执行:\n  ${command}\n确认？`)) return;
    try {
      const r = await runCommand(cwd, command);
      setNote(`${label} 完成。${(r.stderr || "").slice(0, 200)}`);
      if (/git push/.test(command)) setNote(`${label} 完成：${(r.stdout || r.stderr || "").slice(0, 300)}`);
    } catch (e) {
      setNote(`${label} 失败：${String(e)}`);
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
            <p className="py-6 text-center text-[11px] text-gb-muted">尚未捕获本轮内容 —— 下一轮完成后将自动填充。</p>
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
              <button onClick={runApprove} className="flex-1 rounded bg-gb-green/15 px-2 py-1 text-[10px] font-medium text-gb-green hover:bg-gb-green/25" title="暂存全部并提交">批准</button>
              <button onClick={() => setAction("revise")} className="flex-1 rounded bg-gb-accent/15 px-2 py-1 text-[10px] font-medium text-gb-accent hover:bg-gb-accent/25" title="将修改意见发回会话">打回修改</button>
              <button onClick={runReject} className="flex-1 rounded bg-gb-red/15 px-2 py-1 text-[10px] font-medium text-gb-red hover:bg-gb-red/25" title="丢弃该 worktree">拒绝</button>
            </div>
          ) : (
            <div className="space-y-1">
              <textarea
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={2}
                placeholder={action === "approve" ? "提交信息…" : "需要修改什么？…"}
                className="w-full rounded border border-gb-border/10 bg-gb-bg px-2 py-1 text-[11px] text-gb-text outline-none focus:border-gb-accent/50"
              />
              <div className="flex gap-1">
                <button onClick={action === "approve" ? runApprove : runRevise} className="flex-1 rounded bg-gb-accent px-2 py-1 text-[10px] font-medium text-gb-bg disabled:opacity-40" disabled={!input.trim()}>
                  {action === "approve" ? "提交" : "发送"}
                </button>
                <button onClick={() => setAction("none")} className="flex-1 rounded border border-gb-border/20 px-2 py-1 text-[10px] text-gb-muted hover:bg-gb-surface-hover">取消</button>
              </div>
            </div>
          )}
          {note && <p className="mt-1 text-[10px] text-gb-muted">{note}</p>}
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="border-b border-gb-red/30 bg-gb-red/10 px-2 py-1 text-[10px] text-gb-red">
          合并冲突 — 以下文件未解决：{conflicts.join("、")}
        </div>
      )}
      <div className="flex items-center gap-1.5 border-b border-gb-border/8 px-2 py-0.5 text-[9px] text-gb-muted">
        <span>review: {reviewState}</span>
        <span className="flex-1" />
        {inTriage && (
          <>
            <button
              onClick={() => runCommandConfirmed("推送分支", "git push -u origin HEAD")}
              className="rounded bg-gb-surface-hover px-1.5 py-0.5 hover:opacity-80"
              title="git push -u origin HEAD（需确认）"
            >
              推送
            </button>
            <button
              onClick={() => runCommandConfirmed("创建 PR", "gh pr create --fill")}
              className="rounded bg-gb-surface-hover px-1.5 py-0.5 hover:opacity-80"
              title="gh pr create --fill（需确认）"
            >
              开 PR
            </button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {diff ? <DiffViewer oldContent="" newContent={diff} /> : <p className="py-6 text-center text-[11px] text-gb-muted">与 HEAD 相比没有变更。</p>}
      </div>
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: "all" | "last-turn"; onChange: (v: "all" | "last-turn") => void }) {
  return (
    <div className="flex gap-0.5 border-b border-gb-border/8 p-1">
      {([["all", "全部变更"], ["last-turn", "本轮变更"]] as const).map(([id, label]) => (
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

/**
 * Interactive PTY terminal (ISS-075): a persistent ptyctl session per open
 * panel; xterm.js streams over its loopback WebSocket. Falls back to the
 * legacy read-only run_command output when PTY is unavailable or disabled
 * (GROK_DESKTOP_PTY=off — the documented rollback).
 */
function TerminalPanel({ cwd }: { cwd: string }) {
  const [mode, setMode] = useState<"probing" | "live" | "legacy">("probing");
  const [session, setSession] = useState<PtySession | null>(null);
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    let sessionId: string | null = null;
    (async () => {
      try {
        if (!(await ptyEnabled())) throw new Error("pty disabled");
        const s = await ptySpawn(cwd, 80, 24);
        if (disposed) {
          ptyDispose(s.id).catch(() => {});
          return;
        }
        sessionId = s.id;
        setSession(s);
        setMode("live");
      } catch {
        if (!disposed) setMode("legacy");
      }
    })();
    return () => {
      disposed = true;
      if (sessionId) ptyDispose(sessionId).catch(() => {});
    };
  }, [cwd, restartKey]);

  const restart = () => {
    setSession(null);
    setMode("probing");
    setRestartKey((k) => k + 1);
  };

  if (mode === "live" && session) {
    return (
      <div className="flex h-full flex-col bg-[#1c1c1c]">
        <div className="min-h-0 flex-1">
          <InteractiveTerminal
            key={session.id}
            session={session}
            onClosed={() => {
              /* banner handled inside InteractiveTerminal */
            }}
          />
        </div>
        <div className="flex items-center justify-between border-t border-gb-border/8 px-2 py-1">
          <span className="font-mono text-[10px] text-gb-muted">
            {session.shell} · pid {session.pid}（真实 PTY）
          </span>
          <button
            onClick={restart}
            className="rounded bg-gb-surface-hover px-2 py-0.5 text-[10px] text-gb-text hover:opacity-80"
          >
            Restart
          </button>
        </div>
      </div>
    );
  }

  if (mode === "probing") {
    return (
      <div className="flex h-full items-center justify-center bg-[#1c1c1c] text-[11px] text-gb-muted">
        正在启动交互式终端…
      </div>
    );
  }

  return <LegacyTerminalPanel cwd={cwd} />;
}

function LegacyTerminalPanel({ cwd }: { cwd: string }) {
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
          placeholder="例如 npm test"
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
          placeholder="顺带提问…"
          className="flex-1 rounded border border-gb-border/10 bg-gb-bg px-2 py-1 text-[11px] text-gb-text outline-none focus:border-gb-accent/50"
        />
        <button onClick={send} disabled={busy || !text.trim()} className="shrink-0 rounded bg-gb-accent px-2 py-1 text-[10px] font-medium text-gb-bg disabled:opacity-40">
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

  if (loading) return <p className="py-8 text-center text-xs text-gb-muted">加载 MCP 服务器中…</p>;
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
    { id: "files", label: "文件" },
    { id: "review", label: "审查" },
    { id: "terminal", label: "终端" },
    { id: "sidechat", label: "旁路对话" },
  ];

  let content: ReactNode;
  if (!cwd) {
    content = <p className="py-8 px-3 text-center text-xs text-gb-muted">打开一个会话以使用侧边面板。</p>;
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
          title="计划、子代理、上下文、MCP"
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
              {id === "todo" ? "待办" : id === "subagents" ? "子代理" : id === "context" ? "摘要" : "MCP"}
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
