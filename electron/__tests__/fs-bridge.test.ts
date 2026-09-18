// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FsBridgeError,
  FS_ERR_BAD_PARAMS,
  FS_ERR_BINARY,
  FS_ERR_BOUNDARY,
  FS_ERR_DISABLED,
  FS_ERR_IO,
  FS_ERR_TOO_LARGE,
  bridgeReadTextFile,
  bridgeWriteTextFile,
  fsBridgeEnabled,
} from "../fs-bridge";

let tmp = "";
let root = "";
let auditPath = "";
const savedEnv = process.env.GROK_DESKTOP_FS_BRIDGE;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-fsbridge-"));
  root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  auditPath = path.join(tmp, "audit", "fs-bridge.jsonl");
  delete process.env.GROK_DESKTOP_FS_BRIDGE;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.GROK_DESKTOP_FS_BRIDGE;
  else process.env.GROK_DESKTOP_FS_BRIDGE = savedEnv;
});

/** Write a fixture strictly inside the tmp session root, refusing escapes. */
function write(relativePath: string, content: string) {
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("test fixture escaped the session root");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
  return target;
}

function errCode(p: Promise<unknown>): Promise<number> {
  return p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => {
      expect(e).toBeInstanceOf(FsBridgeError);
      return (e as FsBridgeError).code;
    }
  );
}

function auditLines(): Record<string, unknown>[] {
  return fs
    .readFileSync(auditPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("reads", () => {
  it("returns real content for files inside the session root (relative + absolute)", async () => {
    write("notes.md", "hello agent");
    const rel = await bridgeReadTextFile(root, { path: "notes.md" });
    expect(rel.content).toBe("hello agent");

    const abs = await bridgeReadTextFile(root, { path: path.join(root, "notes.md") });
    expect(abs.content).toBe("hello agent");
  });

  it("rejects ../ escapes and absolute paths outside the root", async () => {
    write("notes.md", "x");
    await expect(
      errCode(bridgeReadTextFile(root, { path: "../outside.txt" }))
    ).resolves.toBe(FS_ERR_BOUNDARY);
    await expect(
      errCode(bridgeReadTextFile(root, { path: path.join(tmp, "other.txt") }))
    ).resolves.toBe(FS_ERR_BOUNDARY);
  });

  it("rejects symlink escapes (link inside root → target outside)", async () => {
    const outside = path.join(tmp, "secret.txt");
    fs.writeFileSync(outside, "secret", "utf-8");
    fs.symlinkSync(outside, path.join(root, "leak.txt"));

    await expect(errCode(bridgeReadTextFile(root, { path: "leak.txt" }))).resolves.toBe(
      FS_ERR_BOUNDARY
    );
  });

  it("rejects oversized files with a structured error", async () => {
    write("big.txt", "x".repeat(2048));
    await expect(
      errCode(bridgeReadTextFile(root, { path: "big.txt" }, { maxBytes: 1024 }))
    ).resolves.toBe(FS_ERR_TOO_LARGE);
  });

  it("rejects binary content (NUL byte) instead of returning garbage", async () => {
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x61, 0x00, 0x62]));
    await expect(errCode(bridgeReadTextFile(root, { path: "blob.bin" }))).resolves.toBe(
      FS_ERR_BINARY
    );
  });

  it("rejects invalid UTF-8", async () => {
    fs.writeFileSync(path.join(root, "bad.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(errCode(bridgeReadTextFile(root, { path: "bad.txt" }))).resolves.toBe(
      FS_ERR_BINARY
    );
  });

  it("missing files produce structured IO errors, never empty content", async () => {
    await expect(errCode(bridgeReadTextFile(root, { path: "ghost.txt" }))).resolves.toBe(
      FS_ERR_IO
    );
  });

  it("directory targets are rejected", async () => {
    await expect(errCode(bridgeReadTextFile(root, { path: "sub" }))).resolves.toBe(FS_ERR_IO);
  });

  it("invalid params (missing/empty/NUL path) are rejected", async () => {
    await expect(errCode(bridgeReadTextFile(root, {}))).resolves.toBe(FS_ERR_BAD_PARAMS);
    await expect(errCode(bridgeReadTextFile(root, { path: "" }))).resolves.toBe(FS_ERR_BAD_PARAMS);
    await expect(errCode(bridgeReadTextFile(root, { path: "a\0b" }))).resolves.toBe(
      FS_ERR_BAD_PARAMS
    );
  });
});

describe("writes", () => {
  it("writes inside the root and records an audit line", async () => {
    await bridgeWriteTextFile(
      root,
      "sess-1",
      { path: "sub/out.md", content: "data" },
      { auditPath }
    );

    expect(fs.readFileSync(path.join(root, "sub", "out.md"), "utf-8")).toBe("data");
    const [rec] = auditLines();
    expect(rec).toMatchObject({
      sessionId: "sess-1",
      op: "write",
      outcome: "allowed",
      bytes: 4,
    });
    expect(String(rec.path).startsWith(root)).toBe(true);
    expect(typeof rec.ts).toBe("string");
  });

  it("refuses to write outside the root and audits the denial", async () => {
    await expect(
      errCode(
        bridgeWriteTextFile(root, "sess-1", { path: "../evil.txt", content: "x" }, { auditPath })
      )
    ).resolves.toBe(FS_ERR_BOUNDARY);

    expect(fs.existsSync(path.join(tmp, "evil.txt"))).toBe(false);
    const [rec] = auditLines();
    expect(rec).toMatchObject({ op: "write", outcome: "denied" });
  });

  it("refuses symlink-escaping writes", async () => {
    const outside = path.join(tmp, "payload.txt");
    fs.writeFileSync(outside, "clean", "utf-8");
    fs.symlinkSync(outside, path.join(root, "link"));

    await expect(
      errCode(bridgeWriteTextFile(root, "s", { path: "link", content: "pwn" }, { auditPath }))
    ).resolves.toBe(FS_ERR_BOUNDARY);
    expect(fs.readFileSync(outside, "utf-8")).toBe("clean");
  });

  it("writing into a not-yet-existing subdirectory creates it inside the root", async () => {
    await bridgeWriteTextFile(root, "s", { path: "a/b/c.txt", content: "deep" }, { auditPath });
    expect(fs.readFileSync(path.join(root, "a", "b", "c.txt"), "utf-8")).toBe("deep");
  });

  it("non-string content is a param error", async () => {
    await expect(
      errCode(bridgeWriteTextFile(root, "s", { path: "x.txt", content: 42 }, { auditPath }))
    ).resolves.toBe(FS_ERR_BAD_PARAMS);
  });
});

describe("rollback switch", () => {
  it("GROK_DESKTOP_FS_BRIDGE=off rejects both ops with the safe default", async () => {
    process.env.GROK_DESKTOP_FS_BRIDGE = "off";
    expect(fsBridgeEnabled()).toBe(false);

    write("notes.md", "x");
    await expect(errCode(bridgeReadTextFile(root, { path: "notes.md" }))).resolves.toBe(
      FS_ERR_DISABLED
    );
    await expect(
      errCode(bridgeWriteTextFile(root, "s", { path: "y.txt", content: "z" }, { auditPath }))
    ).resolves.toBe(FS_ERR_DISABLED);
    expect(fs.existsSync(path.join(root, "y.txt"))).toBe(false);
    // The refused write is still audited
    expect(auditLines()[0]).toMatchObject({ outcome: "denied" });
  });
});

describe("concurrency / external mutation", () => {
  it("concurrent reads and writes to distinct files are isolated", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        bridgeWriteTextFile(
          root,
          `s${i}`,
          { path: `f${i}.txt`, content: `v${i}` },
          { auditPath }
        )
      )
    );
    const reads = await Promise.all(
      Array.from({ length: 8 }, (_, i) => bridgeReadTextFile(root, { path: `f${i}.txt` }))
    );
    expect(reads.map((r) => r.content)).toEqual(["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"]);
    expect(auditLines()).toHaveLength(8);
  });

  it("a file deleted mid-flight yields a structured error, not a crash", async () => {
    write("ephemeral.txt", "here one moment");
    const p = bridgeReadTextFile(root, { path: "ephemeral.txt" });
    fs.unlinkSync(path.join(root, "ephemeral.txt"));
    // Whichever way the race resolves — content or a structured error — it
    // must never throw a raw ENOENT out of the bridge.
    const result = await p.catch((e) => {
      expect(e).toBeInstanceOf(FsBridgeError);
      return null;
    });
    if (result) expect(result.content).toBe("here one moment");
  });

  it("a file growing past the cap between stat and read is still caught", async () => {
    write("grow.txt", "small");
    const big = path.join(root, "grow.txt");
    fs.writeFileSync(big, "y".repeat(4096));
    await expect(
      errCode(bridgeReadTextFile(root, { path: "grow.txt" }, { maxBytes: 1024 }))
    ).resolves.toBe(FS_ERR_TOO_LARGE);
  });
});

describe("permission is bound to the session root", () => {
  it("the same relative path resolves differently per root — switching project re-evaluates", async () => {
    const rootB = path.join(tmp, "rootB");
    fs.mkdirSync(rootB, { recursive: true });
    write("project.txt", "from A");
    fs.writeFileSync(path.join(rootB, "project.txt"), "from B", "utf-8");

    const a = await bridgeReadTextFile(root, { path: "project.txt" });
    const b = await bridgeReadTextFile(rootB, { path: "project.txt" });
    expect(a.content).toBe("from A");
    expect(b.content).toBe("from B");
  });
});
