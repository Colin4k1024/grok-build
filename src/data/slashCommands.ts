export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  /** UI grouping (codex palette order). */
  group: "session" | "thread" | "review" | "info" | "agent";
  /** local = executed client-side; agent = forwarded as a prompt;
   *  degraded = known codex command whose backend lands in a later issue. */
  kind: "local" | "agent" | "degraded";
  /** For degraded entries: what unlocks them. */
  requires?: string;
  /** Minimum word arguments for local commands. */
  minArgs?: number;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // ---- session ----
  { name: "new", description: "Start a new session/thread", group: "session", kind: "local" },
  { name: "clear", description: "Clear this thread's transcript (keeps the session)", group: "session", kind: "local", minArgs: 0 },
  { name: "copy", description: "Copy the last assistant reply to the clipboard", group: "session", kind: "local" },
  { name: "cd", description: "Change this thread's working directory", argumentHint: "<dir>", group: "session", kind: "local", minArgs: 1 },
  { name: "pwd", description: "Show this thread's working directory", group: "session", kind: "local" },
  { name: "usage", description: "Show context-window usage for this thread", group: "session", kind: "local" },

  // ---- thread ----
  { name: "rename", description: "Rename the current thread", argumentHint: "<title>", group: "thread", kind: "local", minArgs: 1 },
  { name: "fork", description: "Fork the current thread at this point", group: "thread", kind: "local" },
  { name: "archive", description: "Archive the current thread", group: "thread", kind: "local" },
  { name: "worktree", description: "Switch thread workspace (local | worktree [branch])", argumentHint: "local | worktree [branch]", group: "thread", kind: "local", minArgs: 1 },

  // ---- review ----
  { name: "diff", description: "Show the working-tree diff (optionally one path)", argumentHint: "[path]", group: "review", kind: "local" },
  { name: "import", description: "Import sessions & instructions from Claude Code (preview + confirm)", group: "review", kind: "local" },
  { name: "review", description: "Open the review workflow for the current changes", group: "review", kind: "local" },

  // ---- info ----
  { name: "status", description: "Show session details (model, turns, context usage)", aliases: ["session-info", "info"], group: "info", kind: "agent" },
  { name: "context", description: "Show context window usage and session stats", group: "info", kind: "agent" },

  // ---- agent-side capabilities (forwarded to the model) ----
  { name: "compact", description: "Compress conversation history to save context window", argumentHint: "optional context about what to preserve", group: "agent", kind: "agent" },
  { name: "always-approve", description: "Toggle always-approve mode (skip all permission prompts)", argumentHint: "on|off", aliases: ["yolo"], group: "agent", kind: "agent" },
  { name: "flush", description: "Flush conversation memory to disk now", group: "agent", kind: "agent" },
  { name: "dream", description: "Run memory consolidation (merge session logs into organized topics)", group: "agent", kind: "agent" },
  { name: "memory", description: "Browse, view, and manage your memories", argumentHint: "on|off", aliases: ["mem"], group: "agent", kind: "agent" },
  { name: "hooks-trust", description: "Trust this project for hook execution", group: "agent", kind: "agent" },
  { name: "hooks-list", description: "Show hooks loaded in this session", group: "agent", kind: "agent" },
  { name: "hooks-add", description: "Add a custom hook file or directory", argumentHint: "path to hook file or directory", group: "agent", kind: "agent" },
  { name: "hooks-remove", description: "Remove a custom hook or directory path", argumentHint: "path", group: "agent", kind: "agent" },
  { name: "hooks-untrust", description: "Remove trust for the current project", group: "agent", kind: "agent" },
  { name: "plugins", description: "Manage plugins (list, reload, trust, add, remove)", argumentHint: "list | reload | trust <path> | add <path> | remove <path>", aliases: ["plugin"], group: "agent", kind: "agent" },
  { name: "reload-plugins", description: "Reload plugins from disk (alias for /plugins reload)", group: "agent", kind: "agent" },
  { name: "feedback", description: "Send feedback about the current session", argumentHint: "feedback text", group: "agent", kind: "agent" },
  { name: "deep-research", description: "Research with bounded parallel agents, cross-check evidence, and write a cited report", argumentHint: "<query>", group: "agent", kind: "agent" },
  { name: "workflow", description: "Launch a saved workflow, list runs, or manage a run", argumentHint: "<name> | list | <run-id> pause|resume|stop|save", group: "agent", kind: "agent" },
  { name: "goal", description: "Set, manage, or check an autonomous goal", argumentHint: "<objective> | status | pause | resume | clear", group: "agent", kind: "agent" },
  { name: "loop", description: "Run a prompt on a recurring interval", argumentHint: "[interval] <prompt>", group: "agent", kind: "agent" },
  { name: "recap", description: "Summarize what happened in this thread so far", group: "agent", kind: "agent" },
];

/** Commands intentionally absent (ISS-078 non-goals): /voice (ISS-082),
 *  /import (ISS-083), /ide (no host integration). */

export function fuzzyMatch(command: SlashCommand, query: string): boolean {
  const q = query.toLowerCase();
  if (command.name.includes(q)) return true;
  if (command.aliases?.some((a) => a.includes(q))) return true;
  if (command.description.toLowerCase().includes(q)) return true;
  return false;
}

export function findCommand(input: string): SlashCommand | undefined {
  const name = input.replace(/^\//, "").split(/\s+/)[0]?.toLowerCase();
  if (!name) return undefined;
  return SLASH_COMMANDS.find(
    (c) => c.name === name || c.aliases?.includes(name)
  );
}
