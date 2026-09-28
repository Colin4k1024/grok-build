// @vitest-environment node
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TRANSFER_BYTES,
  readTransferFile,
  sanitizeTransferFileName,
  validateTransferContent,
  writeTransferFile,
} from "../settings-transfer";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "gb-transfer-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("settings transfer file helpers (R4-06 #239)", () => {
  it("honors only a bare file name — never a renderer-supplied path", () => {
    expect(sanitizeTransferFileName("backup.json")).toBe("backup.json");
    expect(sanitizeTransferFileName("/Users/alice/.ssh/config")).toBe("config");
    expect(sanitizeTransferFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeTransferFileName(undefined)).toBe("grok-build-settings.json");
    expect(sanitizeTransferFileName("..")).toBe("grok-build-settings.json");
  });

  it("validates content type and size", () => {
    expect(validateTransferContent("{}")).toBe("{}");
    expect(() => validateTransferContent(undefined)).toThrow(/string/);
    expect(() => validateTransferContent(42)).toThrow(/string/);
    expect(() => validateTransferContent("x".repeat(MAX_TRANSFER_BYTES + 1))).toThrow(/exceeds/);
  });

  it("writes atomically (unique tmp + rename)", () => {
    const file = path.join(dir, "out.json");
    const renameSpy = vi.spyOn(fs, "renameSync");
    try {
      writeTransferFile(file, '{"a":1}');
      expect(renameSpy).toHaveBeenCalledOnce();
      const [tmp, dest] = renameSpy.mock.calls[0];
      expect(dest).toBe(file);
      expect(String(tmp)).toContain(file); // sibling tmp
      expect(String(tmp)).toMatch(/\.tmp$/);
      expect(String(tmp)).not.toBe(`${file}.tmp`); // unique, not the fixed name
    } finally {
      renameSpy.mockRestore();
    }
    expect(readFileSync(file, "utf-8")).toBe('{"a":1}');
    expect(readTransferFile(file)).toBe('{"a":1}');
  });

  it("read bounds size AFTER reading (no stat TOCTOU), unreadable → null", () => {
    const big = path.join(dir, "big.json");
    writeFileSync(big, "x".repeat(MAX_TRANSFER_BYTES + 1));
    expect(readTransferFile(big)).toBeNull();
    expect(readTransferFile(path.join(dir, "missing.json"))).toBeNull();
  });
});
