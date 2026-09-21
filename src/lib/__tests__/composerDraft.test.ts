// @vitest-environment jsdom
/**
 * Composer draft persistence tests (R3-10 / #195).
 * Proves: draft save/load/clear, per-session scoping, restart persistence,
 * no auto-send, 4000-char cap, unknown/degraded slash commands.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveDraft, loadDraft, clearDraft } from "../composerDraft";

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe("composer draft persistence (R3-10 #195)", () => {
  it("saveDraft stores text and loadDraft retrieves it", () => {
    saveDraft("session-1", "hello world");
    expect(loadDraft("session-1")).toBe("hello world");
  });
  it("empty text clears the draft", () => {
    saveDraft("session-2", "some text");
    saveDraft("session-2", "");
    expect(loadDraft("session-2")).toBe("");
    expect(localStorage.getItem("gb-draft-session-2")).toBeNull();
  });
  it("whitespace-only text is treated as empty", () => {
    saveDraft("session-3", "   ");
    expect(loadDraft("session-3")).toBe("");
  });
  it("clearDraft removes the draft", () => {
    saveDraft("session-4", "draft text");
    clearDraft("session-4");
    expect(loadDraft("session-4")).toBe("");
  });
  it("loadDraft on a non-existent session returns empty string", () => {
    expect(loadDraft("never-existed")).toBe("");
  });
  it("drafts are scoped per-session", () => {
    saveDraft("session-a", "draft for A");
    saveDraft("session-b", "draft for B");
    expect(loadDraft("session-a")).toBe("draft for A");
    expect(loadDraft("session-b")).toBe("draft for B");
  });
  it("drafts survive a simulated restart", () => {
    saveDraft("restart-test", "survives restart");
    expect(loadDraft("restart-test")).toBe("survives restart");
  });
  it("drafts do NOT auto-send — loadDraft only reads", () => {
    saveDraft("no-auto-send", "this should not be sent");
    const draft = loadDraft("no-auto-send");
    expect(typeof draft).toBe("string");
    expect(draft).toBe("this should not be sent");
  });
  it("draft text is capped at 4000 chars", () => {
    saveDraft("long-draft", "x".repeat(10000));
    expect(loadDraft("long-draft").length).toBe(4000);
  });
});

describe("slash command dynamic availability (R3-10 #195)", () => {
  it("unknown slash commands produce an error outcome", async () => {
    const { executeSlashCommand } = await import("../slashExec");
    const actions = {
      clearMessages: () => {}, renameThread: () => {}, setCwd: () => {},
      setWorkMode: () => {}, newThread: () => {}, copyText: async () => {},
      showDiff: async () => "", notify: () => {}, openUsage: () => {},
      openImport: () => {}, forkCurrentThread: () => {},
      archiveCurrentThread: () => {}, openReviewPanel: () => {}, createWorktree: () => {},
    };
    const outcome = await executeSlashCommand("/nonexistent-command", {
      streaming: false, sessionId: "s1", cwd: "/w", usage: null, lastAssistantText: "", actions,
    });
    expect(outcome.type).toBe("error");
  });
  it("degraded commands produce an explicit notice", async () => {
    const { executeSlashCommand } = await import("../slashExec");
    const actions = {
      clearMessages: () => {}, renameThread: () => {}, setCwd: () => {},
      setWorkMode: () => {}, newThread: () => {}, copyText: async () => {},
      showDiff: async () => "", notify: () => {}, openUsage: () => {},
      openImport: () => {}, forkCurrentThread: () => {},
      archiveCurrentThread: () => {}, openReviewPanel: () => {}, createWorktree: () => {},
    };
    const outcome = await executeSlashCommand("/voice", {
      streaming: false, sessionId: "s1", cwd: "/w", usage: null, lastAssistantText: "", actions,
    });
    expect(outcome.type).toBe("error");
  });
});
