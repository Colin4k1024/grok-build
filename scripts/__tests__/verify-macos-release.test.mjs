// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../verify-macos-release.sh");

let tmp = "";
let stubBin = "";
let appDir = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-macverify-"));
  stubBin = path.join(tmp, "bin");
  fs.mkdirSync(stubBin, { recursive: true });
  appDir = path.join(tmp, "Grok Build.app");
  fs.mkdirSync(appDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a stub tool that exits with the given code and logs its argv. */
function stubTool(name, exitCode, logFile) {
  const p = path.join(stubBin, name);
  fs.writeFileSync(
    p,
    `#!/bin/sh\necho "${name} $@" >> "${logFile}"\nexit ${exitCode}\n`
  );
  fs.chmodSync(p, 0o755);
}

function run(target, env = {}, { barePath = false } = {}) {
  const log = path.join(tmp, "calls.log");
  fs.writeFileSync(log, "");
  try {
    const out = execFileSync("/bin/bash", [SCRIPT, target], {
      env: {
        ...process.env,
        // barePath: only the stub dir — used to prove the script reports a
        // missing required tool instead of dying opaquely.
        PATH: barePath ? stubBin : `${stubBin}:${process.env.PATH}`,
        GB_VERIFY_LOG: log,
        ...env,
      },
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { code: 0, out, log: fs.readFileSync(log, "utf-8") };
  } catch (e) {
    return {
      code: e.status ?? 1,
      out: String(e.stdout ?? "") + String(e.stderr ?? ""),
      log: fs.existsSync(log) ? fs.readFileSync(log, "utf-8") : "",
    };
  }
}

function stubAll({ codesign = 0, spctl = 0, stapler = 0 } = {}) {
  const log = path.join(tmp, "calls.log");
  stubTool("codesign", codesign, log);
  stubTool("spctl", spctl, log);
  stubTool("xcrun", stapler, log);
  // stapler is invoked as `xcrun stapler validate` — the xcrun stub covers it
  return log;
}

describe("verify-macos-release.sh (R5-08 #264)", () => {
  it("fails clearly when a required tool is missing from PATH", () => {
    // empty stubBin — no codesign at all
    const r = run(appDir, {}, { barePath: true });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/required tool missing/);
  });

  it("passes when codesign + spctl + stapler all accept the app", () => {
    stubAll();
    const r = run(appDir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/codesign.*OK|PASS codesign/);
    expect(r.log).toContain("codesign");
    expect(r.log).toContain("spctl");
    expect(r.log).toContain("stapler");
  });

  it("fails when codesign rejects the app", () => {
    stubAll({ codesign: 1 });
    const r = run(appDir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL codesign/);
  });

  it("fails when Gatekeeper (spctl) rejects the app", () => {
    stubAll({ spctl: 1 });
    const r = run(appDir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL spctl/);
  });

  it("fails when the notarization ticket is not stapled", () => {
    stubAll({ stapler: 1 });
    const r = run(appDir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL.*stapler/);
  });

  it("never prints environment or credential material", () => {
    stubAll();
    const r = run(appDir, { CSC_LINK: "supersecret-p12-base64", APPLE_API_KEY: "KEYDATA" });
    expect(r.out).not.toContain("supersecret");
    expect(r.out).not.toContain("KEYDATA");
  });

  it("verifies the INNER app of a DMG and always detaches", () => {
    const log = stubAll();
    // stub hdiutil: attach creates the mountpoint with an inner app; detach logs
    const hdiutil = path.join(stubBin, "hdiutil");
    fs.writeFileSync(
      hdiutil,
      `#!/bin/sh
if [ "$1" = "attach" ]; then
  mp=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "-mountpoint" ]; then mp="$a"; fi
    prev="$a"
  done
  mkdir -p "$mp/Grok Build.app"
  echo "hdiutil attach $mp" >> "${log}"
  exit 0
fi
if [ "$1" = "detach" ]; then
  echo "hdiutil detach $2" >> "${log}"
  exit 0
fi
exit 1
`
    );
    fs.chmodSync(hdiutil, 0o755);
    const dmg = path.join(tmp, "Grok-Build-0.1.0-arm64.dmg");
    fs.writeFileSync(dmg, "fake-dmg");
    const r = run(dmg);
    expect(r.code).toBe(0);
    // the inner app (not the dmg) was verified
    expect(r.log).toMatch(/Grok Build\.app/);
    // detach happened
    expect(r.log).toContain("hdiutil detach");
  });

  it("fails a DMG whose inner app fails verification", () => {
    stubAll({ codesign: 1 });
    const hdiutil = path.join(stubBin, "hdiutil");
    fs.writeFileSync(
      hdiutil,
      `#!/bin/sh
if [ "$1" = "attach" ]; then
  mp=""; prev=""
  for a in "$@"; do if [ "$prev" = "-mountpoint" ]; then mp="$a"; fi; prev="$a"; done
  mkdir -p "$mp/Grok Build.app"
  exit 0
fi
exit 0
`
    );
    fs.chmodSync(hdiutil, 0o755);
    const dmg = path.join(tmp, "Grok-Build-0.1.0-arm64.dmg");
    fs.writeFileSync(dmg, "fake-dmg");
    const r = run(dmg);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL codesign/);
  });
});
