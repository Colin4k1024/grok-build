// @vitest-environment node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SettingsStoreError,
  deleteSettingsValue,
  readSettingsFile,
  resetSettingsFile,
  writeSettingsValue,
} from "../settings-store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "gb-settings-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("settings file store (R4-05 #238)", () => {
  it("reads an empty store when the file does not exist", () => {
    expect(readSettingsFile(dir)).toEqual({ version: 1, values: {} });
  });

  it("writes and reads back values", () => {
    writeSettingsValue(dir, "appearance.theme", "light");
    writeSettingsValue(dir, "appearance.zoom", 1.25);
    const doc = readSettingsFile(dir);
    expect(doc.values["appearance.theme"]).toBe("light");
    expect(doc.values["appearance.zoom"]).toBe(1.25);
  });

  it("deletes values", () => {
    writeSettingsValue(dir, "appearance.theme", "light");
    deleteSettingsValue(dir, "appearance.theme");
    expect(readSettingsFile(dir).values["appearance.theme"]).toBeUndefined();
  });

  it("reset clears all values", () => {
    writeSettingsValue(dir, "a.b", 1);
    resetSettingsFile(dir);
    expect(readSettingsFile(dir).values).toEqual({});
  });

  it("rejects malformed keys", () => {
    for (const bad of ["", "has space", "中文键", "a".repeat(129), "../escape"]) {
      expect(() => writeSettingsValue(dir, bad, 1), bad).toThrow(SettingsStoreError);
      expect(() => writeSettingsValue(dir, bad, 1), bad).toThrow(/invalid_key/);
    }
  });

  it("rejects non-JSON-serializable and oversized values", () => {
    expect(() => writeSettingsValue(dir, "a.b", undefined)).toThrow(/invalid_value/);
    expect(() => writeSettingsValue(dir, "a.b", () => {})).toThrow(/invalid_value/);
    expect(() => writeSettingsValue(dir, "a.b", "x".repeat(20 * 1024))).toThrow(/invalid_value/);
  });

  it("quarantines a corrupt file instead of losing the store", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(path.join(dir, "gb-settings.json"), "{ broken json {{{");
    const doc = readSettingsFile(dir);
    expect(doc.values).toEqual({});
    // the corrupt original is preserved for forensics, not overwritten
    const quarantined = readdirSync(dir).filter((f) => f.startsWith("gb-settings.json.corrupt-"));
    expect(quarantined.length).toBe(1);
    const saved = readFileSync(path.join(dir, quarantined[0]), "utf-8");
    expect(saved).toBe("{ broken json {{{");
  });

  it("rejects a document with the wrong shape", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(path.join(dir, "gb-settings.json"), JSON.stringify({ values: [1, 2, 3] }));
    expect(readSettingsFile(dir).values).toEqual({});
    expect(readdirSync(dir).some((f) => f.includes("corrupt-"))).toBe(true);
  });
});
