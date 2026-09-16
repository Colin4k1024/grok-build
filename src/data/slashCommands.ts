export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Compress conversation history to save context window", argumentHint: "optional context about what to preserve" },
  { name: "always-approve", description: "Toggle always-approve mode (skip all permission prompts)", argumentHint: "on|off", aliases: ["yolo"] },
  { name: "flush", description: "Flush conversation memory to disk now" },
  { name: "dream", description: "Run memory consolidation (merge session logs into organized topics)" },
  { name: "memory", description: "Browse, view, and manage your memories", argumentHint: "on|off", aliases: ["mem"] },
  { name: "context", description: "Show context window usage and session stats" },
  { name: "hooks-trust", description: "Trust this project for hook execution" },
  { name: "hooks-list", description: "Show hooks loaded in this session" },
  { name: "hooks-add", description: "Add a custom hook file or directory", argumentHint: "path to hook file or directory" },
  { name: "hooks-remove", description: "Remove a custom hook file or directory path", argumentHint: "path to hook file or directory" },
  { name: "hooks-untrust", description: "Remove trust for the current project" },
  { name: "plugins", description: "Manage plugins (list, reload, trust, add, remove)", argumentHint: "list | reload | trust <path> | add <path> | remove <path>", aliases: ["plugin"] },
  { name: "reload-plugins", description: "Reload plugins from disk (alias for /plugins reload)" },
  { name: "session-info", description: "Show session details (model, turns, context usage)", aliases: ["status", "info"] },
  { name: "feedback", description: "Send feedback about the current session", argumentHint: "feedback text" },
  { name: "deep-research", description: "Research with bounded parallel agents, cross-check evidence, and write a cited report", argumentHint: "<query>" },
  { name: "workflow", description: "Launch a saved workflow, list runs, or manage a run", argumentHint: "<name> | list | <run-id> pause|resume|stop|save" },
  { name: "goal", description: "Set, manage, or check an autonomous goal", argumentHint: "<objective> | status | pause | resume | clear" },
  { name: "loop", description: "Run a prompt on a recurring interval", argumentHint: "[interval] <prompt>" },
];

export function fuzzyMatch(command: SlashCommand, query: string): boolean {
  const q = query.toLowerCase();
  if (command.name.includes(q)) return true;
  if (command.aliases?.some((a) => a.includes(q))) return true;
  if (command.description.toLowerCase().includes(q)) return true;
  return false;
}
