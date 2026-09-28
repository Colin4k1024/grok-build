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

  it("writes and reads back the settings envelope", () => {
    writeSettingsValue(dir, "gb-settings", '{"state":{"theme":"light"}}');
    const doc = readSettingsFile(dir);
    expect(doc.values["gb-settings"]).toBe('{"state":{"theme":"light"}}');
  });

  it("deletes values", () => {
    writeSettingsValue(dir, "gb-settings", "blob");
    deleteSettingsValue(dir, "gb-settings");
    expect(readSettingsFile(dir).values["gb-settings"]).toBeUndefined();
  });

  it("reset clears all values", () => {
    writeSettingsValue(dir, "gb-settings", "blob");
    resetSettingsFile(dir);
    expect(readSettingsFile(dir).values).toEqual({});
  });

  it("rejects malformed keys", () => {
    for (const bad of ["", "has space", "中文键", "a".repeat(129), "../escape"]) {
      expect(() => writeSettingsValue(dir, bad, 1), bad).toThrow(SettingsStoreError);
      expect(() => writeSettingsValue(dir, bad, 1), bad).toThrow(/invalid_key/);
    }
  });

  it("rejects keys outside the served envelope set", () => {
    expect(() => writeSettingsValue(dir, "appearance.theme", "light")).toThrow(/invalid_key/);
    expect(() => writeSettingsValue(dir, "anything.valid", 1)).toThrow(/invalid_key/);
  });

  it("rejects non-JSON-serializable and oversized values", () => {
    expect(() => writeSettingsValue(dir, "gb-settings", undefined)).toThrow(/invalid_value/);
    expect(() => writeSettingsValue(dir, "gb-settings", () => {})).toThrow(/invalid_value/);
    expect(() => writeSettingsValue(dir, "gb-settings", "x".repeat(300 * 1024))).toThrow(/invalid_value/);
    // multi-byte text must count BYTES, not UTF-16 units
    expect(() => writeSettingsValue(dir, "gb-settings", "汉".repeat(100_000))).toThrow(/invalid_value/);
  });

  it("a large but legal blob round-trips (no false oversize rejections)", () => {
    const big = JSON.stringify({ state: { notes: "x".repeat(100 * 1024) } });
    writeSettingsValue(dir, "gb-settings", big);
    expect(readSettingsFile(dir).values["gb-settings"]).toBe(big);
  });

  it("rejects credential-shaped keys (defense in depth)", () => {
    for (const key of ["apiKey", "openai_api_key", "auth.token", "db.password", "mySecret"]) {
      expect(() => writeSettingsValue(dir, key, "x"), key).toThrow(/invalid_key/);
    }
  });

  it("rejects a document whose values is null", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(path.join(dir, "gb-settings.json"), JSON.stringify({ version: 1, values: null }));
    expect(readSettingsFile(dir).values).toEqual({});
    expect(readdirSync(dir).some((f) => f.includes("corrupt-"))).toBe(true);
    // and a subsequent write must not crash on the quarantined shape
    writeSettingsValue(dir, "gb-settings", "blob");
    expect(readSettingsFile(dir).values["gb-settings"]).toBe("blob");
  });

  it("read path filters non-envelope keys from a hand-edited file", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(
      path.join(dir, "gb-settings.json"),
      JSON.stringify({ version: 1, values: { "gb-settings": "blob", "rogue.key": 1 } }),
    );
    const doc = readSettingsFile(dir);
    expect(doc.values["gb-settings"]).toBe("blob");
    expect(doc.values["rogue.key"]).toBeUndefined();
  });

  it("repeated corruption produces distinct quarantine files", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(path.join(dir, "gb-settings.json"), "{ broken 1");
    readSettingsFile(dir);
    writeFileSync(path.join(dir, "gb-settings.json"), "{ broken 2");
    readSettingsFile(dir);
    expect(readdirSync(dir).filter((f) => f.includes("corrupt-")).length).toBe(2);
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
