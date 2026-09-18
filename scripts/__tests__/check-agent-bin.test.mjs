// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyAgentBinary } from "../check-agent-bin.mjs";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-pack-gate-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("verifyAgentBinary (ISS-071 pack gate)", () => {
  it("accepts an existing non-empty binary", () => {
    const bin = path.join(tmp, "xai-grok-pager");
    fs.writeFileSync(bin, "#!/bin/sh\necho agent\n");
    const r = verifyAgentBinary(bin);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain("bytes");
  });

  it("rejects a missing binary with an actionable message", () => {
    const r = verifyAgentBinary(path.join(tmp, "nope"));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not found");
    expect(r.reason).toContain("cargo build");
  });

  it("rejects an empty (0-byte) binary — truncated copy must not pass", () => {
    const bin = path.join(tmp, "xai-grok-pager");
    fs.writeFileSync(bin, "");
    const r = verifyAgentBinary(bin);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("empty");
  });

  it("rejects a directory passed as the binary path", () => {
    const r = verifyAgentBinary(tmp);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("directory");
  });

  it("rejects an absent/empty path argument", () => {
    expect(verifyAgentBinary("").ok).toBe(false);
    expect(verifyAgentBinary(undefined).ok).toBe(false);
  });
});
