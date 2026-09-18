import { describe, it, expect, vi } from "vitest";
import { executeSlashCommand, type SlashContext } from "../slashExec";
import { SLASH_COMMANDS, findCommand } from "../../data/slashCommands";

function makeCtx(overrides: Partial<SlashContext> = {}): SlashContext {
  const actions = {
    clearMessages: vi.fn(),
    renameThread: vi.fn(),
    setCwd: vi.fn(),
    setWorkMode: vi.fn(),
    newThread: vi.fn(),
    copyText: vi.fn(async () => undefined),
    showDiff: vi.fn(async () => "diff --git a/x b/x\n+hello"),
    openUsage: vi.fn(),
    openImport: vi.fn(),
    notify: vi.fn(),
  };
  return {
    streaming: false,
    sessionId: "s1",
    cwd: "/w/alpha",
    usage: { used: 42000, size: 200000 },
    lastAssistantText: "the answer",
    actions,
    ...overrides,
  };
}

describe("registry (ISS-078 scope)", () => {
  it("covers the codex-verified command set from the issue", () => {
    const names = new Set(SLASH_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    for (const required of [
      "diff", "review", "fork", "rename", "usage", "clear",
      "new", "worktree", "copy", "cd", "pwd", "goal", "recap",
    ]) {
      expect(names.has(required), `missing /${required}`).toBe(true);
    }
  });

  it("non-goal commands are absent (import landed with ISS-083)", () => {
    const names = new Set(SLASH_COMMANDS.map((c) => c.name));
    expect(names.has("voice")).toBe(false); // ISS-082: degraded to dictation, no /voice entry
    expect(names.has("ide")).toBe(false);
    expect(names.has("import")).toBe(true); // delivered in ISS-083
  });

  it("no duplicate names or aliases; every entry is grouped and kinded", () => {
    const seen = new Set<string>();
    for (const c of SLASH_COMMANDS) {
      expect(seen.has(c.name), `duplicate ${c.name}`).toBe(false);
      seen.add(c.name);
      expect(["session", "thread", "review", "info", "agent"]).toContain(c.group);
      expect(["local", "agent", "degraded"]).toContain(c.kind);
      if (c.kind === "degraded") expect(c.requires).toBeTruthy();
    }
  });

  it("findCommand resolves names and aliases case-insensitively", () => {
    expect(findCommand("/STATUS")?.name).toBe("status");
    expect(findCommand("/yolo")?.name).toBe("always-approve");
    expect(findCommand("/nope")).toBeUndefined();
  });
});

describe("routing", () => {
  it("non-slash input passes through untouched", async () => {
    expect(await executeSlashCommand("hello world", makeCtx())).toEqual({ type: "passthrough" });
  });

  it("agent commands pass through as prompts", async () => {
    expect(await executeSlashCommand("/goal status", makeCtx())).toEqual({ type: "passthrough" });
    expect(await executeSlashCommand("/compact", makeCtx())).toEqual({ type: "passthrough" });
  });

  it("degraded commands explain what unlocks them", async () => {
    const r = await executeSlashCommand("/fork", makeCtx());
    expect(r.type).toBe("error");
    expect((r as { notice: string }).notice).toContain("ISS-079");
    const r2 = await executeSlashCommand("/review", makeCtx());
    expect((r2 as { notice: string }).notice).toContain("ISS-080");
  });

  it("unknown commands error loudly instead of being sent", async () => {
    const r = await executeSlashCommand("/definitely-not-a-command", makeCtx());
    expect(r.type).toBe("error");
    expect((r as { notice: string }).notice).toContain("未知命令");
  });
});

describe("local commands", () => {
  it("/clear wipes the transcript when idle", async () => {
    const ctx = makeCtx();
    const r = await executeSlashCommand("/clear", ctx);
    expect(r.type).toBe("handled");
    expect(ctx.actions.clearMessages).toHaveBeenCalledWith("s1");
  });

  it("/clear while streaming is refused — no running ghost", async () => {
    const ctx = makeCtx({ streaming: true });
    const r = await executeSlashCommand("/clear", ctx);
    expect(r.type).toBe("error");
    expect(ctx.actions.clearMessages).not.toHaveBeenCalled();
  });

  it("/copy copies the last assistant reply", async () => {
    const ctx = makeCtx();
    const r = await executeSlashCommand("/copy", ctx);
    expect(r.type).toBe("handled");
    expect(ctx.actions.copyText).toHaveBeenCalledWith("the answer");
  });

  it("/copy without any assistant reply is an error", async () => {
    const r = await executeSlashCommand("/copy", makeCtx({ lastAssistantText: "" }));
    expect(r.type).toBe("error");
  });

  it("/pwd reports the thread cwd", async () => {
    const r = await executeSlashCommand("/pwd", makeCtx());
    expect(r.type).toBe("handled");
    expect((r as { notice?: string }).notice).toBe("/w/alpha");
  });

  it("/cd requires an argument and applies it", async () => {
    const noArg = await executeSlashCommand("/cd", makeCtx());
    expect(noArg.type).toBe("error");

    const ctx = makeCtx();
    const r = await executeSlashCommand("/cd /tmp", ctx);
    expect(r.type).toBe("handled");
    expect(ctx.actions.setCwd).toHaveBeenCalledWith("s1", "/tmp");
  });

  it("/rename joins multi-word titles", async () => {
    const ctx = makeCtx();
    await executeSlashCommand("/rename my cool thread", ctx);
    expect(ctx.actions.renameThread).toHaveBeenCalledWith("s1", "my cool thread");
  });

  it("/usage opens the usage panel (ISS-081)", async () => {
    const ctx = makeCtx();
    const r = await executeSlashCommand("/usage", ctx);
    expect(r.type).toBe("handled");
    expect(ctx.actions.openUsage).toHaveBeenCalled();
  });

  it("/diff surfaces the git diff via the scoped cwd", async () => {
    const ctx = makeCtx();
    const r = await executeSlashCommand("/diff src/main.ts", ctx);
    expect(r.type).toBe("handled");
    expect(ctx.actions.showDiff).toHaveBeenCalledWith("/w/alpha", "src/main.ts");
  });

  it("/diff on a clean tree says so", async () => {
    const ctx = makeCtx();
    ctx.actions.showDiff = vi.fn(async () => "");
    const r = await executeSlashCommand("/diff", ctx);
    expect((r as { notice?: string }).notice).toContain("无改动");
  });

  it("/worktree validates the mode argument", async () => {
    const bad = await executeSlashCommand("/worktree sideways", makeCtx());
    expect(bad.type).toBe("error");

    const ctx = makeCtx();
    await executeSlashCommand("/worktree worktree feat-x", ctx);
    expect(ctx.actions.setWorkMode).toHaveBeenCalledWith("s1", "worktree", "feat-x");

    const ctx2 = makeCtx();
    await executeSlashCommand("/worktree local", ctx2);
    expect(ctx2.actions.setWorkMode).toHaveBeenCalledWith("s1", "local", undefined);
  });

  it("/import opens the preview panel (ISS-083)", async () => {
    const ctx = makeCtx();
    const r = await executeSlashCommand("/import", ctx);
    expect(r.type).toBe("handled");
    expect(ctx.actions.openImport).toHaveBeenCalled();
  });

  it("/new returns to the home screen", async () => {
    const ctx = makeCtx();
    const r = await executeSlashCommand("/new", ctx);
    expect(r.type).toBe("handled");
    expect(ctx.actions.newThread).toHaveBeenCalled();
  });
});

describe("session guards", () => {
  it("thread commands without an active session are explicit errors", async () => {
    for (const cmd of ["/clear", "/cd /tmp", "/rename x", "/worktree local"]) {
      const r = await executeSlashCommand(cmd, makeCtx({ sessionId: null }));
      expect(r.type, cmd).toBe("error");
    }
  });

  it("/diff with a failing git call surfaces the error", async () => {
    const ctx = makeCtx();
    ctx.actions.showDiff = vi.fn(async () => {
      throw new Error("not a git repo");
    });
    const r = await executeSlashCommand("/diff", ctx);
    expect(r.type).toBe("error");
    expect((r as { notice: string }).notice).toContain("not a git repo");
  });
});
