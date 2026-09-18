/**
 * Review-loop state machine (ISS-080), codex semantics:
 *
 *   clean → modified        (working tree changed)
 *   modified → reviewing    (review opened / turn started)
 *   reviewing → changes-requested  (reviewer sends comments back)
 *   changes-requested → modified   (agent turn completes after the request)
 *   modified → clean        (changes committed / reverted)
 *
 * Deadlock-free by construction: from any state, `committed` reaches clean.
 * Unknown/illegal events are no-ops — the machine never crashes the loop.
 */

export type ReviewState = "clean" | "modified" | "reviewing" | "changes-requested";

export type ReviewEvent =
  | { type: "files-changed"; hasChanges: boolean }
  | { type: "review-opened" }
  | { type: "changes-requested" }
  | { type: "agent-turn-completed" }
  | { type: "committed" };

export function next(state: ReviewState, event: ReviewEvent): ReviewState {
  switch (event.type) {
    case "files-changed":
      return event.hasChanges ? "modified" : state === "clean" ? "clean" : state;
    case "review-opened":
      // Re-opening the review pane mid-request doesn't cancel the request.
      if (state === "clean") return "clean";
      if (state === "changes-requested") return "changes-requested";
      return "reviewing";
    case "changes-requested":
      return state === "reviewing" || state === "modified" ? "changes-requested" : state;
    case "agent-turn-completed":
      // The agent finished a revision pass after our request.
      return state === "changes-requested" ? "modified" : state;
    case "committed":
      return "clean";
    default:
      return state;
  }
}

/** Every state can reach clean (no deadlock). */
export function canReachClean(state: ReviewState): boolean {
  return state === "clean" || state === "modified" || state === "reviewing" || state === "changes-requested";
}

/**
 * Versioned async-view guard (ISS-080 concurrency): the agent may keep
 * editing while a diff fetch is in flight — only the newest fetch's result
 * may land, so the view never tears.
 */
export class ViewVersion {
  private current = 0;

  begin(): number {
    this.current += 1;
    return this.current;
  }

  accept(token: number): boolean {
    return token === this.current;
  }
}
