import { describe, it, expect } from "vitest";
import { forkSnapshot } from "../threadOps";
import type { ChatMessage } from "../../stores/sessionStore";

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    role: "user",
    content: "",
    timestamp: 1,
    ...partial,
  };
}

describe("forkSnapshot (ISS-079)", () => {
  it("copies user/assistant messages verbatim and folds tool turns", () => {
    const snap = forkSnapshot([
      msg({ role: "user", content: "q", timestamp: 1 }),
      msg({ role: "assistant", content: "a", streaming: true, timestamp: 2 }),
      msg({ role: "tool", toolName: "bash", content: "ls out", toolSuccess: true, timestamp: 3 }),
      msg({ role: "tool", toolName: "bash", content: "boom", toolSuccess: false, timestamp: 4 }),
    ]);
    expect(snap).toEqual([
      { role: "user", content: "q", timestamp: 1 },
      { role: "assistant", content: "a", timestamp: 2 },
      { role: "assistant", content: "[tool bash ok] ls out", timestamp: 3 },
      { role: "assistant", content: "[tool bash failed] boom", timestamp: 4 },
    ]);
  });

  it("is a deterministic deep copy — later source mutations cannot leak in", () => {
    const source = [msg({ role: "user", content: "hello", timestamp: 1 })];
    const snap = forkSnapshot(source);

    // source keeps streaming after the fork click
    source.push(msg({ role: "assistant", content: "late", timestamp: 2 }));
    source[0].content = "MUTATED";

    expect(snap).toEqual([{ role: "user", content: "hello", timestamp: 1 }]);
  });

  it("an empty transcript yields an empty snapshot", () => {
    expect(forkSnapshot([])).toEqual([]);
  });

  it("streaming flags never carry into the fork (settled history)", () => {
    const snap = forkSnapshot([msg({ role: "assistant", content: "x", streaming: true })]);
    expect(Object.prototype.hasOwnProperty.call(snap[0], "streaming")).toBe(false);
  });
});
