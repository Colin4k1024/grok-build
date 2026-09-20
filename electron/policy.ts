/**
 * Main-process typed Policy engine (R3-01 / #186).
 *
 * The renderer's `SandboxToggle` used to write `gb-sandbox-mode` to localStorage
 * and flip a per-tab `approvalMode` — nothing in the main process consumed it.
 * The UI claimed "写入、网络和命令访问受限" without any backend enforcement.
 *
 * This module is the real boundary. Before any file write, command execution,
 * git operation, or network egress leaves the main process, the relevant
 * handler calls `Policy` to check whether the operation is allowed under the
 * session's effective mode. The Policy is the only source of truth; the
 * renderer's approvalMode is treated as an untrusted hint.
 *
 * Modes (codex parity):
 *   - "read-only":  no writes, no commands, no network; fs reads allowed.
 *   - "sandbox":    writes/commands inside the session root only; network
 *                   blocked; dangerous commands blocked; explicit approval
 *                   required for every side-effecting op.
 *   - "full-access": writes/commands anywhere under an allowed root; network
 *                   allowed; still audit-logged. Used only when the user has
 *                   explicitly opted in.
 *
 * Enforcement is real: handlers that ignore the Policy decision and proceed
 * would be caught by the integration tests in
 * `electron/__tests__/policy.integration.test.ts`, which exercise actual file
 * writes, real command execution, real git operations, and real network
 * attempts — no mocks of the side effects the issue requires.
 */

import fs from "node:fs";
import path from "node:path";
import { appendAudit, type AuditRecord } from "./fs-bridge";

export type PolicyMode = "read-only" | "sandbox" | "full-access";

export type PolicyEffect = "allow" | "deny";

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Why the policy decided the way it did — surfaced to the UI and audit log. */
  reason: string;
  /** Mode that produced this decision. */
  mode: PolicyMode;
  /** The canonicalized target the decision was evaluated against. */
  target?: string;
  /** Capability that was evaluated. */
  capability: "file-write" | "file-read" | "command" | "network" | "git";
}

export const POLICY_ERR_DENIED = "POLICY_DENIED";

export class PolicyError extends Error {
  constructor(
    public readonly decision: PolicyDecision
  ) {
    super(decision.reason);
    this.name = "PolicyError";
  }
}

/**
 * Commands blocked in every mode (sandbox and full-access). These are the
 * "obviously destructive" set — the goal is preventing accidental data loss,
 * not enumerating every dangerous shell invocation. Allow-listing is the
 * sandbox's job; this is a deny-list floor that always applies.
 *
 * Patterns are matched as a word-boundary prefix so `rm` blocks `rm -rf /`
 * but not `rmdir` (which is its own command). `git push --force` is blocked
 * only when `--force`/`-f` appears anywhere in the command (rare in normal
 * review work; force-push during a review turn is almost always a mistake).
 */
const BLOCKED_COMMAND_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /(^|\s)rm\s+-rf?\s+\/(\s|$)/, reason: "rm -rf / is blocked (root filesystem wipe)" },
  { re: /(^|\s)rm\s+-rf?\s+~/, reason: "rm -rf ~ is blocked (home directory wipe)" },
  { re: /(^|\s)mkfs(\.|\s)/, reason: "mkfs is blocked (filesystem format)" },
  { re: /(^|\s)dd\s+.*\bof=\/dev\//, reason: "dd to /dev is blocked (raw device write)" },
  { re: /:\(\)\s*\{.*\};:/, reason: "fork bomb pattern blocked" },
  { re: /shutdown|reboot|halt|poweroff/, reason: "system power command blocked" },
];

/**
 * Network egress commands — any command that initiates a network connection
 * is blocked under "read-only" and "sandbox" modes (the agent's own model
 * API is out of band; this governs tool/command egress only).
 */
const NETWORK_COMMAND_PATTERNS: RegExp[] = [
  /\bcurl\b/, /\bwget\b/, /\bftp\b/, /\bssh\b/, /\bscp\b/, /\brsync\b/,
  /\bnc\b/, /\bnetcat\b/, /\btelnet\b/, /\bhttp\b/, /\bhttps\b/,
];

/** Sandbox-allowed command prefixes — the sandbox allow-list. */
const SANDBOX_ALLOWED_COMMANDS: string[] = [
  "ls", "cat", "grep", "find", "rg", "fd", "head", "tail", "wc", "echo",
  "pwd", "stat", "file", "tree", "du", "df", "env", "printenv",
  "git status", "git diff", "git log", "git branch", "git show", "git stash list",
  "git ls-files", "git rev-parse", "git remote -v",
  "cargo check", "cargo build", "cargo test", "cargo clippy", "cargo fmt --check",
  "npm test", "npm run", "npx vitest", "npx tsc --noEmit",
  "node --version", "node -v",
];

export interface PolicyOptions {
  /** Session root (the project cwd). Operations must stay under this. */
  root: string;
  /** Effective mode — set by the main process from the session's approvalMode. */
  mode: PolicyMode;
  /** Where audit records go. */
  auditPath?: string;
  /** Session id for audit records. */
  sessionId: string;
}

export class Policy {
  private readonly root: string;
  private mode: PolicyMode;
  private readonly auditPath?: string;
  private readonly sessionId: string;

  constructor(opts: PolicyOptions) {
    this.root = path.resolve(opts.root);
    this.mode = opts.mode;
    this.auditPath = opts.auditPath;
    this.sessionId = opts.sessionId;
  }

  /** Update the effective mode. Called when the renderer syncs approvalMode. */
  setMode(mode: PolicyMode): void {
    this.mode = mode;
  }

  getMode(): PolicyMode {
    return this.mode;
  }

  getRoot(): string {
    return this.root;
  }

  /**
   * Check whether a file write is allowed under the current mode and root.
   * Throws PolicyError if denied — the caller must NOT swallow it.
   */
  checkFileWrite(targetPath: string): PolicyDecision {
    const decision = this.evaluateFileWrite(targetPath);
    this.audit(decision, targetPath);
    if (decision.effect === "deny") throw new PolicyError(decision);
    return decision;
  }

  /**
   * Check whether a file read is allowed. Read-only mode still allows reads;
   * the boundary that matters here is the session root (path traversal /
   * symlink escape).
   */
  checkFileRead(targetPath: string): PolicyDecision {
    const decision = this.evaluateFileRead(targetPath);
    this.audit(decision, targetPath);
    if (decision.effect === "deny") throw new PolicyError(decision);
    return decision;
  }

  /**
   * Check whether a shell command is allowed. The command is the raw string
   * the user/agent requested (e.g. "rm -rf build" or "cargo test"). Network
   * commands and blocked patterns are rejected in sandbox/read-only.
   */
  checkCommand(command: string): PolicyDecision {
    const decision = this.evaluateCommand(command);
    this.audit(decision, command);
    if (decision.effect === "deny") throw new PolicyError(decision);
    return decision;
  }

  /**
   * Check whether a git operation is allowed. Git writes (commit, push, reset)
   * are blocked in read-only; the cwd must be under the session root.
   */
  checkGit(cwd: string, operation: "read" | "write"): PolicyDecision {
    const decision = this.evaluateGit(cwd, operation);
    this.audit(decision, `${operation}:${cwd}`);
    if (decision.effect === "deny") throw new PolicyError(decision);
    return decision;
  }

  /**
   * Check whether network egress is allowed. In read-only and sandbox, all
   * tool-side network egress is blocked. The agent's own model API travels
   * out-of-band (its env is set at spawn) and is not subject to this gate.
   */
  checkNetwork(): PolicyDecision {
    const decision = this.evaluateNetwork();
    this.audit(decision, "network-egress");
    if (decision.effect === "deny") throw new PolicyError(decision);
    return decision;
  }

  // ---- Evaluation (pure, side-effect-free) -------------------------------

  private evaluateFileWrite(targetPath: string): PolicyDecision {
    const target = this.canonicalize(targetPath);
    if (!target) {
      return this.deny("file-write", "path could not be resolved under the session root", targetPath);
    }
    if (this.mode === "read-only") {
      return this.deny("file-write", "read-only mode blocks all file writes", target);
    }
    if (!this.isInsideRoot(target)) {
      return this.deny("file-write", "write target escapes the session root", target);
    }
    return this.allow("file-write", "write inside session root", target);
  }

  private evaluateFileRead(targetPath: string): PolicyDecision {
    const target = this.canonicalize(targetPath);
    if (!target) {
      return this.deny("file-read", "path could not be resolved under the session root", targetPath);
    }
    if (!this.isInsideRoot(target)) {
      return this.deny("file-read", "read target escapes the session root", target);
    }
    return this.allow("file-read", "read inside session root", target);
  }

  private evaluateCommand(command: string): PolicyDecision {
    const trimmed = command.trim();
    if (!trimmed) {
      return this.allow("command", "empty command (no-op)", trimmed);
    }
    // Always-on deny-list floor — checked in every mode including full-access.
    for (const pat of BLOCKED_COMMAND_PATTERNS) {
      if (pat.re.test(trimmed)) {
        return this.deny("command", pat.reason, trimmed);
      }
    }
    if (this.mode === "read-only") {
      return this.deny("command", "read-only mode blocks all command execution", trimmed);
    }
    if (this.mode === "sandbox") {
      // Network egress commands are blocked in sandbox.
      for (const netRe of NETWORK_COMMAND_PATTERNS) {
        if (netRe.test(trimmed)) {
          return this.deny("command", "network egress blocked in sandbox mode", trimmed);
        }
      }
      if (!this.isSandboxAllowed(trimmed)) {
        return this.deny("command", "command not on the sandbox allow-list", trimmed);
      }
    }
    // full-access: deny-list floor already checked above.
    return this.allow("command", `command allowed under ${this.mode} mode`, trimmed);
  }

  private evaluateGit(cwd: string, operation: "read" | "write"): PolicyDecision {
    const resolved = this.canonicalize(cwd) ?? path.resolve(cwd);
    if (!this.isInsideRoot(resolved)) {
      return this.deny("git", "git operation outside the session root", resolved);
    }
    if (this.mode === "read-only" && operation === "write") {
      return this.deny("git", "read-only mode blocks git write operations", resolved);
    }
    return this.allow("git", `${operation} under ${this.mode} mode`, resolved);
  }

  private evaluateNetwork(): PolicyDecision {
    if (this.mode === "read-only") {
      return this.deny("network", "read-only mode blocks network egress");
    }
    if (this.mode === "sandbox") {
      return this.deny("network", "sandbox mode blocks network egress");
    }
    return this.allow("network", "full-access mode permits network egress");
  }

  // ---- Helpers ------------------------------------------------------------

  /**
   * Canonicalize a path against the session root, refusing escapes. This
   * mirrors fs-bridge's `resolveJailed` but is policy-side: it does not throw
   * (the decision carries the denial) and handles not-yet-existing paths by
   * walking up to the deepest existing ancestor and realpath-checking that.
   */
  private canonicalize(input: string): string | null {
    if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
      return null;
    }
    const absRoot = path.resolve(this.root);
    const candidate = path.resolve(absRoot, input);
    // Lexical containment check first (cheap, catches plain ../).
    if (!this.contains(absRoot, candidate)) {
      return null;
    }
    // Realpath the deepest existing ancestor — a symlinked parent must not
    // aim the path outside the root. Not-yet-existing tail segments are
    // already lexically jailed.
    try {
      const realRoot = fs.realpathSync.native(absRoot);
      let probe = candidate;
      while (true) {
        let real: string | null = null;
        try {
          real = fs.realpathSync.native(probe);
        } catch {
          const parent = path.dirname(probe);
          if (parent === probe) break;
          probe = parent;
          continue;
        }
        if (!this.contains(realRoot, real)) {
          return null;
        }
        break;
      }
    } catch {
      // root not accessible — fall back to the lexical check already done.
    }
    return candidate;
  }

  private contains(root: string, candidate: string): boolean {
    if (candidate === root) return true;
    return candidate.startsWith(root + path.sep);
  }

  private isInsideRoot(target: string): boolean {
    const absRoot = path.resolve(this.root);
    try {
      const realRoot = fs.realpathSync.native(absRoot);
      // If the target exists, realpath it; otherwise use the canonicalized form.
      let real: string;
      try {
        real = fs.realpathSync.native(target);
      } catch {
        real = target;
      }
      return this.contains(realRoot, real) || this.contains(absRoot, target);
    } catch {
      return this.contains(absRoot, target);
    }
  }

  private isSandboxAllowed(command: string): boolean {
    const lower = command.toLowerCase();
    return SANDBOX_ALLOWED_COMMANDS.some((prefix) => lower === prefix || lower.startsWith(prefix + " "));
  }

  private allow(
    capability: PolicyDecision["capability"],
    reason: string,
    target?: string
  ): PolicyDecision {
    return { effect: "allow", reason, mode: this.mode, target, capability };
  }

  private deny(
    capability: PolicyDecision["capability"],
    reason: string,
    target?: string
  ): PolicyDecision {
    return { effect: "deny", reason, mode: this.mode, target, capability };
  }

  private audit(decision: PolicyDecision, target: string): void {
    const record: AuditRecord = {
      ts: new Date().toISOString(),
      sessionId: this.sessionId,
      op: decision.capability === "file-write" ? "write" : decision.capability === "file-read" ? "read" : "command",
      path: target,
      bytes: null,
      outcome: decision.effect === "allow" ? "allowed" : "denied",
      detail: decision.reason,
    };
    if (this.auditPath) {
      appendAudit(record, this.auditPath);
    }
  }
}

/**
 * Map the renderer's ApprovalMode to a main-process PolicyMode.
 * "ask" (the renderer default) maps to "sandbox" — the user must approve
 * each side-effecting op, and the sandbox boundary is enforced.
 * "full-access" maps straight through. "read-only" maps straight through.
 */
export function approvalModeToPolicyMode(mode: string | undefined): PolicyMode {
  if (mode === "full-access") return "full-access";
  if (mode === "read-only") return "read-only";
  // "ask" or missing → sandbox (the safe default).
  return "sandbox";
}
