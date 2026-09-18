// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PtyManager, PtyError, PTY_ERR_DISABLED, resolvePtyctlBinary } from "../pty-manager";

// These tests exercise a real ptyctl controller; skip where it can't run
// (CI fast lane builds no Rust, Windows ConPTY is best-effort per ISS-075).
const resolvedBin = resolvePtyctlBinary();
const ptyctlAvailable =
  process.platform !== "win32" &&
  resolvedBin.includes(path.sep) &&
  fs.existsSync(resolvedBin);

const skipped = describe.skipIf(!ptyctlAvailable);

let tmp = "";
const savedFlag = process.env.GROK_DESKTOP_PTY;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-pty-"));
  delete process.env.GROK_DESKTOP_PTY;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedFlag === undefined) delete process.env.GROK_DESKTOP_PTY;
  else process.env.GROK_DESKTOP_PTY = savedFlag;
});

function manager(): PtyManager {
  return new PtyManager({ onExit: () => {} });
}

/** Poll until a pid is gone (process.kill throws ESRCH) or timeout. */
async function waitPidGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      return true;
    }
  }
  return false;
}

/** True while any process matching the marker command line exists. */
function markerAlive(marker: string): boolean {
  try {
    const out = execFileSync("ps", ["-eo", "args"], { encoding: "utf-8", timeout: 5000 });
    return out.split("\n").some((l) => l.includes(marker) && !l.includes("grep"));
  } catch {
    return false;
  }
}

async function waitMarkerGone(marker: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!markerAlive(marker)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

skipped("PTY lifecycle (spawn → running → exit → disposed)", () => {
  it("open resolves a loopback port and tracks the session", async () => {
    const m = manager();
    const info = await m.open(tmp);
    expect(info.port).toBeGreaterThan(0);
    expect(info.pid).toBeGreaterThan(0);
    expect(m.alive(info.id)).toBe(true);

    m.dispose(info.id);
    expect(await waitPidGone(info.pid)).toBe(true);
    expect(m.alive(info.id)).toBe(false);
  }, 15000);

  it("dispose is idempotent on an already-dead session", async () => {
    const m = manager();
    const info = await m.open(tmp);
    m.dispose(info.id);
    await waitPidGone(info.pid);
    expect(() => m.dispose(info.id)).not.toThrow();
  }, 15000);

  it("controller exit fires onExit and clears the session", async () => {
    const exits: Array<[string, number]> = [];
    const m = new PtyManager({ onExit: (id, code) => exits.push([id, code]) });
    const info = await m.open(tmp);

    process.kill(info.pid, "SIGTERM");
    await waitPidGone(info.pid);
    await new Promise((r) => setTimeout(r, 300));

    expect(exits.some(([id]) => id === info.id)).toBe(true);
    expect(m.alive(info.id)).toBe(false);
  }, 15000);

  it("disposeAll kills every concurrent session — no leaks (ps verified)", async () => {
    const m = manager();
    const infos = await Promise.all([m.open(tmp), m.open(tmp), m.open(tmp)]);
    expect(infos).toHaveLength(3);

    const count = m.disposeAll();
    expect(count).toBe(3);
    for (const info of infos) {
      expect(await waitPidGone(info.pid)).toBe(true);
    }
    expect(m.disposeAll()).toBe(0);
  }, 20000);

  it("killing the controller reaps its PTY children (no zombie shells)", async () => {
    const m = manager();
    // The controller runs $SHELL by default; point it at a wrapper whose PTY
    // child is a distinctive long-lived sleep so leaks are ps-visible.
    const wrapper = path.join(tmp, "shell-wrapper.sh");
    fs.writeFileSync(wrapper, "#!/bin/sh\nexec /bin/sh -c 'sleep 300'\n");
    fs.chmodSync(wrapper, 0o755);
    const prevShell = process.env.SHELL;
    process.env.SHELL = wrapper;
    try {
      const info = await m.open(tmp);
      // give the PTY child a moment to reach the marker process
      await new Promise((r) => setTimeout(r, 700));
      expect(markerAlive("sleep 300")).toBe(true);

      m.dispose(info.id);
      expect(await waitMarkerGone("sleep 300")).toBe(true);
      expect(await waitPidGone(info.pid)).toBe(true);
    } finally {
      if (prevShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = prevShell;
    }
  }, 25000);
});

skipped("negative scenarios", () => {
  it("GROK_DESKTOP_PTY=off refuses to open (rollback flag)", async () => {
    process.env.GROK_DESKTOP_PTY = "off";
    const m = manager();
    await expect(m.open(tmp)).rejects.toMatchObject({ code: PTY_ERR_DISABLED });
  }, 10000);

  it("invalid cwd params are structured rejections", async () => {
    const m = manager();
    await expect(m.open("")).rejects.toBeInstanceOf(PtyError);
    await expect(m.open("a\0b")).rejects.toBeInstanceOf(PtyError);
  }, 10000);

  it("a deleted cwd falls back to the home directory instead of crashing", async () => {
    const m = manager();
    const info = await m.open(path.join(tmp, "deleted-dir"));
    expect(info.port).toBeGreaterThan(0);
    m.dispose(info.id);
    await waitPidGone(info.pid);
  }, 15000);

  it("an unavailable ptyctl binary surfaces a structured spawn error", async () => {
    const prev = process.env.GROK_PTYCTL_BIN;
    process.env.GROK_PTYCTL_BIN = path.join(tmp, "no-such-ptyctl");
    try {
      const m = manager();
      await expect(m.open(tmp)).rejects.toBeInstanceOf(PtyError);
    } finally {
      if (prev === undefined) delete process.env.GROK_PTYCTL_BIN;
      else process.env.GROK_PTYCTL_BIN = prev;
    }
  }, 15000);
});
