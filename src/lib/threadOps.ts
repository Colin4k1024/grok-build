/**
 * Thread management operations (ISS-079): fork snapshots + rename titles.
 * Pure helpers — orchestration lives in App, persistence in the main process.
 */

import type { ChatMessage } from "../stores/sessionStore";

export interface ForkEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

/**
 * Deterministic fork snapshot (ISS-079): a deep copy taken at the fork click.
 * The source may keep streaming afterwards — the fork point never moves, and
 * later mutations of the source transcript cannot leak into the copy.
 * Tool turns fold into assistant-side bracketed lines so the seeded transcript
 * stays readable while loadHistoryMessages keeps only user/assistant roles.
 */
export function forkSnapshot(messages: ChatMessage[]): ForkEntry[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
    .map((m) => {
      if (m.role === "tool") {
        const status = m.toolSuccess === false ? "failed" : "ok";
        return {
          role: "assistant" as const,
          content: `[tool ${m.toolName ?? "call"} ${status}] ${m.content}`.trim(),
          timestamp: m.timestamp,
        };
      }
      return {
        role: m.role as "user" | "assistant",
        content: `${m.content}`,
        timestamp: m.timestamp,
      };
    });
}
