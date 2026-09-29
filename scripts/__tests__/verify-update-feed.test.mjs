// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyUpdateFeed } from "../verify-update-feed.mjs";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-feed-verify-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sha512Base64(buf) {
  return crypto.createHash("sha512").update(buf).digest("base64");
}

/** Write an artifact plus a latest-mac.yml-style manifest referencing it. */
function writeFeed(name, contents, overrides = {}) {
  fs.writeFileSync(path.join(tmp, name), contents);
  const manifest = [
    "version: 2.0.0",
    "files:",
    `  - url: ${overrides.url ?? name}`,
    `    sha512: ${overrides.sha512 ?? sha512Base64(contents)}`,
    `    size: ${overrides.size ?? contents.length}`,
    `path: ${overrides.url ?? name}`,
    `sha512: ${overrides.sha512 ?? sha512Base64(contents)}`,
    "releaseDate: '2026-09-29T00:00:00.000Z'",
    "",
  ].join("\n");
  const manifestPath = path.join(tmp, "latest-mac.yml");
  fs.writeFileSync(manifestPath, manifest);
  return manifestPath;
}

describe("verifyUpdateFeed (R5-07 #263)", () => {
  it("passes a consistent manifest + artifact pair", async () => {
    const m = writeFeed("Grok-Build-2.0.0-arm64.zip", Buffer.from("payload"));
    const r = await verifyUpdateFeed(m, tmp);
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThan(0);
    for (const entry of r.results) expect(entry.ok).toBe(true);
  });

  it("fails when a referenced artifact is missing", async () => {
    const m = writeFeed("Grok-Build-2.0.0-arm64.zip", Buffer.from("payload"));
    fs.rmSync(path.join(tmp, "Grok-Build-2.0.0-arm64.zip"));
    const r = await verifyUpdateFeed(m, tmp);
    expect(r.ok).toBe(false);
    expect(r.results.some((e) => !e.ok && /not found/i.test(e.reason))).toBe(true);
  });

  it("fails on sha512 mismatch — a corrupted artifact must never ship", async () => {
    const good = Buffer.from("payload");
    const m = writeFeed("Grok-Build-2.0.0-arm64.zip", good);
    // Same length as "payload" (7 bytes) so the size check passes and the
    // hash check is the one that must catch the tampering.
    fs.writeFileSync(path.join(tmp, "Grok-Build-2.0.0-arm64.zip"), Buffer.from("HACKED!"));
    const r = await verifyUpdateFeed(m, tmp);
    expect(r.ok).toBe(false);
    expect(r.results.some((e) => !e.ok && /sha512/i.test(e.reason))).toBe(true);
  });

  it("fails on size mismatch even before hashing", async () => {
    const contents = Buffer.from("payload");
    const m = writeFeed("Grok-Build-2.0.0-arm64.zip", contents, { size: contents.length + 1 });
    const r = await verifyUpdateFeed(m, tmp);
    expect(r.ok).toBe(false);
    expect(r.results.some((e) => !e.ok && /size/i.test(e.reason))).toBe(true);
  });

  it("resolves URL-encoded names to their on-disk file", async () => {
    const m = writeFeed("Grok Build-2.0.0-arm64.zip", Buffer.from("payload"), {
      url: "Grok%20Build-2.0.0-arm64.zip",
    });
    const r = await verifyUpdateFeed(m, tmp);
    expect(r.ok).toBe(true);
  });

  it("covers a legacy manifest that only has top-level path/sha512", async () => {
    const contents = Buffer.from("legacy");
    fs.writeFileSync(path.join(tmp, "Grok-Build-2.0.0.zip"), contents);
    const manifestPath = path.join(tmp, "latest.yml");
    fs.writeFileSync(
      manifestPath,
      [
        "version: 2.0.0",
        "path: Grok-Build-2.0.0.zip",
        `sha512: ${sha512Base64(contents)}`,
        "releaseDate: '2026-09-29T00:00:00.000Z'",
        "",
      ].join("\n")
    );
    const r = await verifyUpdateFeed(manifestPath, tmp);
    expect(r.ok).toBe(true);
  });

  it("rejects a malformed manifest (no version, no files)", async () => {
    const manifestPath = path.join(tmp, "latest-mac.yml");
    fs.writeFileSync(manifestPath, "just: text\n");
    const r = await verifyUpdateFeed(manifestPath, tmp);
    expect(r.ok).toBe(false);
  });

  it("refuses path traversal in manifest file names", async () => {
    const outside = path.join(path.dirname(tmp), "outside.bin");
    fs.writeFileSync(outside, Buffer.from("secret"));
    try {
      const contents = Buffer.from("secret");
      const manifestPath = path.join(tmp, "latest-mac.yml");
      fs.writeFileSync(
        manifestPath,
        [
          "version: 2.0.0",
          "files:",
          "  - url: ../outside.bin",
          `    sha512: ${sha512Base64(contents)}`,
          `    size: ${contents.length}`,
          "",
        ].join("\n")
      );
      const r = await verifyUpdateFeed(manifestPath, tmp);
      expect(r.ok).toBe(false);
      expect(r.results.some((e) => !e.ok && /traversal|absolute/i.test(e.reason))).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("refuses absolute paths in manifest file names", async () => {
    const contents = Buffer.from("payload");
    const m = writeFeed("Grok-Build-2.0.0-arm64.zip", contents, {
      url: "/etc/passwd",
    });
    const r = await verifyUpdateFeed(m, tmp);
    expect(r.ok).toBe(false);
    expect(
      r.results.some((e) => !e.ok && /traversal|absolute/i.test(e.reason))
    ).toBe(true);
  });

  it("fails a files[] entry that omits sha512 — unverified artifacts never pass", async () => {
    const contents = Buffer.from("payload");
    fs.writeFileSync(path.join(tmp, "Grok-Build-2.0.0-arm64.zip"), contents);
    const manifestPath = path.join(tmp, "latest-mac.yml");
    fs.writeFileSync(
      manifestPath,
      [
        "version: 2.0.0",
        "files:",
        "  - url: Grok-Build-2.0.0-arm64.zip",
        `    size: ${contents.length}`,
        "",
      ].join("\n")
    );
    const r = await verifyUpdateFeed(manifestPath, tmp);
    expect(r.ok).toBe(false);
    expect(r.results.some((e) => !e.ok && /missing sha512/i.test(e.reason))).toBe(true);
  });

  it("fails a files[] entry that omits size", async () => {
    const contents = Buffer.from("payload");
    fs.writeFileSync(path.join(tmp, "Grok-Build-2.0.0-arm64.zip"), contents);
    const manifestPath = path.join(tmp, "latest-mac.yml");
    fs.writeFileSync(
      manifestPath,
      [
        "version: 2.0.0",
        "files:",
        "  - url: Grok-Build-2.0.0-arm64.zip",
        `    sha512: ${sha512Base64(contents)}`,
        "",
      ].join("\n")
    );
    const r = await verifyUpdateFeed(manifestPath, tmp);
    expect(r.ok).toBe(false);
    expect(r.results.some((e) => !e.ok && /missing size/i.test(e.reason))).toBe(true);
  });

  it("fails a legacy top-level path without sha512", async () => {
    const contents = Buffer.from("legacy");
    fs.writeFileSync(path.join(tmp, "Grok-Build-2.0.0.zip"), contents);
    const manifestPath = path.join(tmp, "latest.yml");
    fs.writeFileSync(
      manifestPath,
      ["version: 2.0.0", "path: Grok-Build-2.0.0.zip", ""].join("\n")
    );
    const r = await verifyUpdateFeed(manifestPath, tmp);
    expect(r.ok).toBe(false);
    expect(r.results.some((e) => !e.ok && /missing sha512/i.test(e.reason))).toBe(true);
  });
});
