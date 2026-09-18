/**
 * Interactive terminal sessions via the Rust-side ptyctl bridge (ISS-075,
 * ADR 0002). The manager owns ONE thing: the lifecycle of `ptyctl run`
 * child processes. Byte flow never touches the main process — the renderer's
 * xterm.js talks to the per-session WebSocket directly
 * (ws://127.0.0.1:<port>/ws, loopback only, port assigned by ptyctl).
 *
 * Lifecycle: spawn → running → exit → disposed. dispose/disposeAll kill the
 * ptyctl child; the PTY process group dies with its controller. The kill
 * signal only ever targets our own children — never a broader group.
 *
 * Rollback: GROK_DESKTOP_PTY=off refuses to spawn; the renderer falls back
 * to the legacy read-only run_command output.
 */

import { spawn as startProcess, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

export const PTY_ERR_DISABLED = -33001;
export const PTY_ERR_BAD_PARAMS = -33002;
export const PTY_ERR_NOT_FOUND = -33003;
export const PTY_ERR_SPAWN = -33004;

export class PtyError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "PtyError";
  }
}

export interface PtySpawnOptions {
  cols?: number;
  rows?: number;
}

export interface PtyEvents {
  /** The ptyctl controller process died (renderer also sees ws 'closed'). */
  onExit: (id: string, code: number) => void;
}

export interface PtySessionInfo {
  id: string;
  /** Loopback port of this session's ptyctl HTTP/ws server. */
  port: number;
  /** pid of the ptyctl controller (not the shell). */
  pid: number;
  cols: number;
  rows: number;
  shell: string;
}

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 300;
const SPAWN_TIMEOUT_MS = 5000;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(v)));
}

export function ptyEnabled(): boolean {
  return process.env.GROK_DESKTOP_PTY !== "off";
}

/** ptyctl resolution mirrors resolveAgentBinary's order. */
export function resolvePtyctlBinary(): string {
  if (process.env.GROK_PTYCTL_BIN) return process.env.GROK_PTYCTL_BIN;
  const exe = process.platform === "win32" ? "ptyctl.exe" : "ptyctl";
  try {
    if (app?.isPackaged) {
      const bundled = path.join(process.resourcesPath, exe);
      if (fs.existsSync(bundled)) return bundled;
    }
  } catch {
    // app not ready yet — fall through
  }
  let appPath = process.cwd();
  try {
    appPath = app.getAppPath();
  } catch {
    // keep cwd
  }
  const release = path.join(appPath, "target", "release", exe);
  const debug = path.join(appPath, "target", "debug", exe);
  if (fs.existsSync(release)) return release;
  if (fs.existsSync(debug)) return debug;
  return exe;
}

function defaultShell(): string {
  const candidate = process.env.SHELL;
  if (candidate && fs.existsSync(candidate)) return candidate;
  return process.platform === "win32" ? "powershell.exe" : "/bin/sh";
}

/** Launch spec for one ptyctl controller process. */
interface ControllerLaunch {
  controllerPath: string;
  workdir: string;
  cols: number;
  rows: number;
  interactiveShell: string;
}

/** Start one ptyctl controller; argv is assembled here, never interpolated. */
function launchController(spec: ControllerLaunch): ChildProcess {
  const argv: string[] = ["run"];
  argv.push("-p", "0"); // ephemeral loopback port; printed on stdout
  argv.push("-q");
  argv.push("-W", String(spec.cols), "-H", String(spec.rows));
  argv.push("-c", spec.workdir);
  argv.push("--", spec.interactiveShell);
  return startProcess(spec.controllerPath, argv, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });
}

interface ManagedSession {
  proc: ChildProcess;
  port: number;
}

export class PtyManager {
  private sessions = new Map<string, ManagedSession>();

  constructor(private readonly events: PtyEvents) {}

  enabled(): boolean {
    return ptyEnabled();
  }

  alive(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Start one interactive session: launches the ptyctl controller and
   *  resolves once its loopback port is known. */
  async open(cwd: string, opts: PtySpawnOptions = {}): Promise<PtySessionInfo> {
    if (!ptyEnabled()) {
      throw new PtyError(PTY_ERR_DISABLED, "PTY disabled (GROK_DESKTOP_PTY=off)");
    }
    if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
      throw new PtyError(PTY_ERR_BAD_PARAMS, "cwd must be a non-empty string");
    }
    let dir = cwd;
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) throw new Error("not a directory");
    } catch {
      dir = os.homedir(); // Terminal on a deleted worktree falls back to home
    }

    const shell = defaultShell();
    const cols = clamp(opts.cols ?? 80, MIN_COLS, MAX_COLS);
    const rows = clamp(opts.rows ?? 24, MIN_ROWS, MAX_ROWS);

    const child = launchController({
      controllerPath: resolvePtyctlBinary(),
      workdir: dir,
      cols,
      rows,
      interactiveShell: shell,
    });

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PtyError(PTY_ERR_SPAWN, "ptyctl did not report a port in time")),
        SPAWN_TIMEOUT_MS
      );
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        const m = buf.match(/(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(parseInt(m[1], 10));
        }
      };
      const fail = (msg: string) => {
        clearTimeout(timer);
        reject(new PtyError(PTY_ERR_SPAWN, msg));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", (c: Buffer) => {
        const s = c.toString("utf-8").trim();
        if (s) fail(`ptyctl stderr: ${s.slice(0, 300)}`);
      });
      child.on("error", (e) => fail(`ptyctl failed to start: ${e.message}`));
      child.on("exit", (code) => fail(`ptyctl exited early (code ${code})`));
    });

    const id = randomUUID();
    this.sessions.set(id, { proc: child, port });
    child.removeAllListeners("exit");
    child.on("exit", (code) => {
      this.sessions.delete(id);
      this.events.onExit(id, code ?? -1);
    });

    return { id, port, pid: child.pid ?? -1, cols, rows, shell: path.basename(shell) };
  }

  /** Kill this session's controller; the PTY group dies with it. Idempotent. */
  dispose(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    try {
      session.proc.kill();
    } catch {
      // already gone
    }
  }

  /** App shutdown: kill every controller; children die with their ptys. */
  disposeAll(): number {
    const n = this.sessions.size;
    for (const id of [...this.sessions.keys()]) this.dispose(id);
    return n;
  }
}
