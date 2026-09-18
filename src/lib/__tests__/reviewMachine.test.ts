import { describe, it, expect } from "vitest";
import { next, canReachClean, ViewVersion } from "../reviewMachine";

describe("review state machine (ISS-080)", () => {
  it("full cycle: clean→modified→reviewing→changes-requested→modified→clean", () => {
    let s = next("clean", { type: "files-changed", hasChanges: true });
    expect(s).toBe("modified");

    s = next(s, { type: "review-opened" });
    expect(s).toBe("reviewing");

    s = next(s, { type: "changes-requested" });
    expect(s).toBe("changes-requested");

    // agent finishes its revision pass
    s = next(s, { type: "agent-turn-completed" });
    expect(s).toBe("modified");

    s = next(s, { type: "committed" });
    expect(s).toBe("clean");
  });

  it("request-changes is legal straight from modified too", () => {
    expect(next("modified", { type: "changes-requested" })).toBe("changes-requested");
  });

  it("illegal events are no-ops, never crashes or jumps", () => {
    expect(next("clean", { type: "changes-requested" })).toBe("clean");
    expect(next("clean", { type: "agent-turn-completed" })).toBe("clean");
    expect(next("clean", { type: "review-opened" })).toBe("clean");
    expect(next("reviewing", { type: "agent-turn-completed" })).toBe("reviewing");
    expect(next("changes-requested", { type: "review-opened" })).toBe("changes-requested");
  });

  it("cleaning the tree only relaxes toward clean from clean", () => {
    expect(next("clean", { type: "files-changed", hasChanges: false })).toBe("clean");
    expect(next("reviewing", { type: "files-changed", hasChanges: false })).toBe("reviewing");
  });

  it("no deadlock: committed reaches clean from every state", () => {
    for (const state of ["clean", "modified", "reviewing", "changes-requested"] as const) {
      expect(canReachClean(state)).toBe(true);
      expect(next(state, { type: "committed" })).toBe("clean");
    }
  });
});

describe("ViewVersion (concurrent diff fetches)", () => {
  it("only the newest fetch may land — stale results are rejected", () => {
    const v = new ViewVersion();
    const t1 = v.begin();
    const t2 = v.begin();
    expect(v.accept(t1)).toBe(false); // superseded mid-flight
    expect(v.accept(t2)).toBe(true);
  });

  it("a third fetch supersedes the second", () => {
    const v = new ViewVersion();
    const t1 = v.begin();
    const t2 = v.begin();
    const t3 = v.begin();
    expect(v.accept(t2)).toBe(false);
    expect(v.accept(t3)).toBe(true);
    void t1;
  });
});
