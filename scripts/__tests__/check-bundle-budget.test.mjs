// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { checkBundleBudget } from "../check-bundle-budget.mjs";

let tmp = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-budget-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a fake dist with an entry of `entryBytes` and extra chunks. */
function writeDist(entryBytes, chunks = {}) {
  const assets = path.join(tmp, "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "index-abc.js"), Buffer.alloc(entryBytes, 97));
  for (const [name, bytes] of Object.entries(chunks)) {
    fs.writeFileSync(path.join(assets, name), Buffer.alloc(bytes, 98));
  }
  fs.writeFileSync(
    path.join(tmp, "index.html"),
    `<html><head><script type="module" src="./assets/index-abc.js"></script></head></html>`
  );
}

describe("checkBundleBudget (R5-06 #262)", () => {
  it("passes a dist within budget", () => {
    writeDist(100 * 1024, { "vendor-a.js": 200 * 1024 });
    const r = checkBundleBudget(tmp);
    expect(r.ok).toBe(true);
    // The entry must be flagged as the entry regardless of the host path
    // separator (index.html uses forward slashes; path.join would break this
    // on win32 — Codex P1 regression guard).
    const entryRow = r.rows.find((row) => row.isEntry);
    expect(entryRow).toBeTruthy();
    expect(entryRow.file).toBe("assets/index-abc.js");
    expect(r.entry).toBe("assets/index-abc.js");
  });

  it("fails when the entry exceeds the raw budget", () => {
    writeDist(600 * 1024);
    const r = checkBundleBudget(tmp);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/entry raw/);
  });

  it("fails when the entry exceeds the gzip budget", () => {
    // highly compressible bytes: raw small enough but gzip grows past limit
    // is impossible — gzip shrinks; instead craft a chunk whose gzip stays big
    // by writing incompressible (random) bytes past the gzip budget.
    const assets = path.join(tmp, "assets");
    fs.mkdirSync(assets, { recursive: true });
    const big = Buffer.alloc(250 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = Math.floor(Math.random() * 256);
    fs.writeFileSync(path.join(assets, "index-abc.js"), big);
    fs.writeFileSync(path.join(tmp, "index.html"), `<script type="module" src="./assets/index-abc.js"></script>`);
    const r = checkBundleBudget(tmp);
    expect(zlib.gzipSync(big).length).toBeGreaterThan(200 * 1024);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/gzip/);
  });

  it("fails when a non-entry chunk exceeds the raw budget", () => {
    writeDist(100 * 1024, { "vendor-huge.js": 400 * 1024 });
    const r = checkBundleBudget(tmp);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/vendor-huge\.js/);
  });

  it("fails clearly when index.html or assets are missing", () => {
    fs.mkdirSync(path.join(tmp, "empty"), { recursive: true });
    expect(checkBundleBudget(path.join(tmp, "empty")).ok).toBe(false);
    expect(checkBundleBudget(path.join(tmp, "empty")).reason).toMatch(/index\.html/);
  });
});
