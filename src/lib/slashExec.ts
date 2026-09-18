/**
 * Client-side slash-command executor (ISS-078).
 *
 * Route rules:
 *   - "/" + unknown name            → error notice (never silently sent)
 *   - kind "local"                  → executed here against the injected context
 *   - kind "degraded"               → explicit notice of what unlocks it
 *   - kind "agent"                  → passthrough to the model as a prompt
 *
 * Local commands never flip the session state machine illegally: /clear is
 * refused while a turn is streaming (no "running ghost" transcripts), and
 * every action targets the active thread only.
 */

import { findCommand } from "../data/slashCommands";

export interface SlashContext {
  /** A turn is streaming on the active thread. */
  streaming: boolean;
  /** Active session id (null on Home). */
  sessionId: string | null;
  cwd: string | undefined;
  /** Context usage of the active thread, if known. */
  usage?: { used: number; size: number } | null;
  /** Last assistant text of the active thread ("" when none). */
  lastAssistantText: string;
  actions: {
    clearMessages(sessionId: string): void;
    renameThread(sessionId: string, title: string): void;
    setCwd(sessionId: string, cwd: string): void;
    setWorkMode(sessionId: string, mode: "local" | "worktree", branch?: string): void;
    newThread(): void;
    copyText(text: string): Promise<void>;
    showDiff(cwd: string, path?: string): Promise<string>;
    notify(message: string): void;
    openUsage(): void;
  };
}

export type SlashOutcome =
  | { type: "handled"; notice?: string }
  | { type: "passthrough" }
  | { type: "error"; notice: string };

export async function executeSlashCommand(
  input: string,
  ctx: SlashContext
): Promise<SlashOutcome> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { type: "passthrough" };

  const cmd = findCommand(trimmed);
  if (!cmd) {
    return { type: "error", notice: `未知命令：${trimmed.split(/\s+/)[0]} — 输入 / 查看可用命令` };
  }

  if (cmd.kind === "agent") return { type: "passthrough" };
  if (cmd.kind === "degraded") {
    return {
      type: "error",
      notice: `/${cmd.name} 将在 ${cmd.requires ?? "后续版本"} 补全后可用`,
    };
  }

  // ---- local commands ----
  const argStr = trimmed.replace(/^\/\S+\s*/, "").trim();
  const args = argStr ? argStr.split(/\s+/) : [];

  if ((cmd.minArgs ?? 0) > args.length) {
    return {
      type: "error",
      notice: `/${cmd.name} 需要参数${cmd.argumentHint ? `：${cmd.argumentHint}` : ""}`,
    };
  }

  switch (cmd.name) {
    case "new": {
      ctx.actions.newThread();
      return { type: "handled", notice: "已回到首页 — 开始新会话" };
    }
    case "clear": {
      if (!ctx.sessionId) return { type: "error", notice: "没有活跃会话可清空" };
      if (ctx.streaming) {
        // State-machine guard: clearing mid-turn would leave a running ghost.
        return { type: "error", notice: "回复仍在进行 — 请先停止（Esc）再 /clear" };
      }
      ctx.actions.clearMessages(ctx.sessionId);
      return { type: "handled", notice: "已清空当前会话记录" };
    }
    case "copy": {
      if (!ctx.lastAssistantText) {
        return { type: "error", notice: "没有可复制的助手回复" };
      }
      await ctx.actions.copyText(ctx.lastAssistantText);
      return { type: "handled", notice: "已复制最后一条助手回复" };
    }
    case "pwd": {
      if (!ctx.cwd) return { type: "error", notice: "当前会话没有工作目录" };
      ctx.actions.notify(ctx.cwd);
      return { type: "handled", notice: ctx.cwd };
    }
    case "cd": {
      if (!ctx.sessionId) return { type: "error", notice: "没有活跃会话" };
      ctx.actions.setCwd(ctx.sessionId, args[0]);
      return { type: "handled", notice: `工作目录 → ${args[0]}` };
    }
    case "rename": {
      if (!ctx.sessionId) return { type: "error", notice: "没有活跃会话" };
      ctx.actions.renameThread(ctx.sessionId, argStr);
      return { type: "handled", notice: `已重命名为「${argStr}」` };
    }
    case "usage": {
      // Opens the usage panel (ISS-081); per-thread data with 未知 fallbacks.
      ctx.actions.openUsage();
      return { type: "handled" };
    }
    case "diff": {
      if (!ctx.cwd) return { type: "error", notice: "当前会话没有工作目录" };
      try {
        const diff = await ctx.actions.showDiff(ctx.cwd, args[0]);
        if (!diff.trim()) {
          return { type: "handled", notice: "工作区无改动" };
        }
        ctx.actions.notify(diff.slice(0, 4000));
        return { type: "handled", notice: `diff 已展示（${diff.split("\n").length} 行）` };
      } catch (e) {
        return { type: "error", notice: `读取 diff 失败：${(e as Error).message}` };
      }
    }
    case "worktree": {
      if (!ctx.sessionId) return { type: "error", notice: "没有活跃会话" };
      const mode = args[0] === "worktree" ? "worktree" : args[0] === "local" ? "local" : null;
      if (!mode) {
        return { type: "error", notice: "用法：/worktree local | worktree [branch]" };
      }
      ctx.actions.setWorkMode(ctx.sessionId, mode, args[1]);
      return {
        type: "handled",
        notice: mode === "local" ? "已切回当前 checkout" : `已切换 worktree 模式${args[1] ? `（${args[1]}）` : ""}`,
      };
    }
    default:
      return { type: "error", notice: `/${cmd.name} 尚未接线（内部遗漏）` };
  }
}
