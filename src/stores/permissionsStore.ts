import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Permissions "boundary" store — tracks which tool+command pairs the user has
 * already approved (or denied) so ApprovalCard can pre-approve without
 * prompting again. Persisted to localStorage; keyed per scope so a command
 * allowed "for this session" doesn't leak into other projects.
 */

export type PermissionScope = "session" | "global";

export interface PermissionRule {
  /** Tool name (e.g. "bash", "write_file"). */
  toolName: string;
  /** Exact command string, or a glob-ish prefix ending in '*' for "starts with". */
  commandPattern: string;
  /** Decision the user made. */
  decision: "allow" | "deny";
  /** When the rule was recorded. */
  createdAt: number;
  /** Session id if scope=session, otherwise undefined. */
  sessionId?: string;
}

interface PermissionsState {
  rules: PermissionRule[];
  addRule: (rule: PermissionRule) => void;
  removeRule: (index: number) => void;
  clearAll: () => void;
  clearForSession: (sessionId: string) => void;
  /** Find a matching rule for the given tool+command in the given scope. */
  lookup: (
    toolName: string,
    command: string,
    sessionId?: string
  ) => { decision: "allow" | "deny"; scope: PermissionScope } | null;
}

function patternMatches(pattern: string, command: string): boolean {
  if (pattern === command) return true;
  if (pattern.endsWith("*")) {
    return command.startsWith(pattern.slice(0, -1));
  }
  return false;
}

export const usePermissionsStore = create<PermissionsState>()(
  persist(
    (set, get) => ({
      rules: [],

      addRule: (rule) =>
        set((state) => {
          // Replace any existing rule for the same (tool, pattern, sessionId) triple.
          const filtered = state.rules.filter(
            (r) =>
              !(
                r.toolName === rule.toolName &&
                r.commandPattern === rule.commandPattern &&
                r.sessionId === rule.sessionId
              )
          );
          return { rules: [...filtered, rule] };
        }),

      removeRule: (index) =>
        set((state) => ({ rules: state.rules.filter((_, i) => i !== index) })),

      clearAll: () => set({ rules: [] }),

      clearForSession: (sessionId) =>
        set((state) => ({
          rules: state.rules.filter((r) => r.sessionId !== sessionId),
        })),

      lookup: (toolName, command, sessionId) => {
        const rules = get().rules;
        // Session-scoped rules win over global ones; within a scope, the most
        // recent rule wins.
        const candidates = rules
          .map((r, i) => ({ rule: r, index: i }))
          .filter(({ rule }) => rule.toolName === toolName);

        const sessionMatch = candidates
          .filter(({ rule }) => rule.sessionId === sessionId && sessionId)
          .reverse()
          .find(({ rule }) => patternMatches(rule.commandPattern, command));
        if (sessionMatch) {
          return { decision: sessionMatch.rule.decision, scope: "session" };
        }

        const globalMatch = candidates
          .filter(({ rule }) => !rule.sessionId)
          .reverse()
          .find(({ rule }) => patternMatches(rule.commandPattern, command));
        if (globalMatch) {
          return { decision: globalMatch.rule.decision, scope: "global" };
        }

        return null;
      },
    }),
    {
      name: "gb-permissions",
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);
