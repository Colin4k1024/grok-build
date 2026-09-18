/**
 * Host-side fs bridge for ACP `fs/read_text_file` / `fs/write_text_file`
 * (ISS-074). Every operation is jailed to the session's working root:
 *
 *   - relative paths resolve against the root; absolute paths must already
 *     land inside it
 *   - `..` segments are collapsed and re-checked
 *   - symlinked paths are resolved to their real target and re-checked, so a
 *     link pointing outside the root cannot smuggle reads/writes
 *
 * Reads enforce a size cap and reject binary / non-UTF-8 payloads with
 * structured errors instead of empty strings (an empty read poisons the
 * agent's context). Writes never leave the root and are appended to an audit
 * JSONL log. `GROK_DESKTOP_FS_BRIDGE=off` falls back to rejecting both
 * operations — the safe default for a rollback.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const FS_BRIDGE_ERROR_BASE = -32000;
export const FS_ERR_BOUNDARY = -32002;
export const FS_ERR_TOO_LARGE = -32003;
export const FS_ERR_BINARY = -32004;
export const FS_ERR_IO = -32005;
export const FS_ERR_DISABLED = -32006;
export const FS_ERR_BAD_PARAMS = -32007;

export const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

/** Structured rejection carrying a JSON-RPC error code. */
export class FsBridgeError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "FsBridgeError";
  }
}

export function fsBridgeEnabled(): boolean {
  return process.env.GROK_DESKTOP_FS_BRIDGE !== "off";
}

export function auditLogPath(): string {
  const grokHome = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  return path.join(grokHome, "audit", "fs-bridge.jsonl");
}

function contains(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root + path.sep);
}

/**
 * Resolve `inputPath` inside `root`, refusing escapes. Returns the resolved
 * absolute path. Symlinks are resolved via realpath when the target exists
 * (for not-yet-existing write targets the deepest existing ancestor is
 * realpath-checked, so a symlinked parent directory cannot point outside).
 */
export function resolveJailed(root: string, inputPath: string): string {
  if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\0")) {
    throw new FsBridgeError(FS_ERR_BAD_PARAMS, "path must be a non-empty string");
  }
  const absRoot = path.resolve(root);
  const candidate = path.resolve(absRoot, inputPath);

  // Lexical check first — cheap and covers plain ../ escapes.
  if (!contains(absRoot, candidate)) {
    throw new FsBridgeError(
      FS_ERR_BOUNDARY,
      `path escapes the session root: ${inputPath}`
    );
  }

  // Realpath check — a symlink inside the root must not resolve outside it.
  try {
    const realRoot = fs.realpathSync.native(absRoot);
    const real = fs.realpathSync.native(candidate);
    if (!contains(realRoot, real)) {
      throw new FsBridgeError(
        FS_ERR_BOUNDARY,
        `path resolves outside the session root: ${inputPath}`
      );
    }
  } catch (e) {
    if (e instanceof FsBridgeError) throw e;
    throw new FsBridgeError(FS_ERR_IO, `not found: ${(e as Error).message}`);
  }
  return candidate;
}

/** Walk up to the deepest existing ancestor for write targets. */
function resolveJailedForWrite(root: string, inputPath: string): string {
  if (typeof inputPath !== "string" || inputPath.length === 0 || inputPath.includes("\0")) {
    throw new FsBridgeError(FS_ERR_BAD_PARAMS, "path must be a non-empty string");
  }
  const absRoot = path.resolve(root);
  const candidate = path.resolve(absRoot, inputPath);
  if (!contains(absRoot, candidate)) {
    throw new FsBridgeError(FS_ERR_BOUNDARY, `path escapes the session root: ${inputPath}`);
  }
  // Realpath the deepest existing ancestor and re-check containment — a
  // symlinked parent directory must not aim the write outside the root.
  // Not-yet-existing tail components are lexically jailed already.
  try {
    const realRoot = fs.realpathSync.native(absRoot);
    let probe = candidate;
    while (true) {
      let real: string | null = null;
      try {
        real = fs.realpathSync.native(probe);
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
        continue;
      }
      if (!contains(realRoot, real)) {
        throw new FsBridgeError(
          FS_ERR_BOUNDARY,
          `path resolves outside the session root: ${inputPath}`
        );
      }
      break;
    }
  } catch (e) {
    if (e instanceof FsBridgeError) throw e;
    throw new FsBridgeError(FS_ERR_IO, `root not accessible: ${(e as Error).message}`);
  }
  return candidate;
}

export interface ReadParams {
  path?: unknown;
}

export interface WriteParams extends ReadParams {
  content?: unknown;
}

export interface AuditRecord {
  ts: string;
  sessionId: string;
  op: "read" | "write";
  path: string;
  bytes: number | null;
  outcome: "allowed" | "denied" | "error";
  detail?: string;
}

export function appendAudit(record: AuditRecord, logPath = auditLogPath()): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + "\n", "utf-8");
  } catch (e) {
    // The bridge must not fail an operation because auditing hiccupped —
    // but never silently: surface it in main-process logs.
    console.error("[fs-bridge] failed to append audit record:", e);
  }
}

/** Decode a buffer as strict UTF-8; throws on invalid sequences. */
function decodeUtf8Strict(buf: Buffer): string {
  if (buf.includes(0)) {
    throw new FsBridgeError(FS_ERR_BINARY, "file contains NUL bytes (binary content)");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new FsBridgeError(FS_ERR_BINARY, "file is not valid UTF-8");
  }
}

export async function bridgeReadTextFile(
  root: string,
  params: ReadParams,
  opts: { maxBytes?: number } = {}
): Promise<{ content: string }> {
  if (!fsBridgeEnabled()) {
    throw new FsBridgeError(FS_ERR_DISABLED, "fs bridge disabled (GROK_DESKTOP_FS_BRIDGE=off)");
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_READ_BYTES;
  const target = resolveJailed(root, params.path as string);

  let buf: Buffer;
  try {
    // TOCTOU hardening: stat, open, then verify the OPENED object matches
    // the stat'd one (dev/ino) before reading through the descriptor — a
    // symlink swapped between validation and open changes the identity.
    const st = fs.statSync(target);
    if (!st.isFile()) {
      throw new FsBridgeError(FS_ERR_IO, `not a regular file: ${params.path}`);
    }
    if (st.size > maxBytes) {
      throw new FsBridgeError(
        FS_ERR_TOO_LARGE,
        `file is ${st.size} bytes, over the ${maxBytes} byte limit`
      );
    }
    const fd = fs.openSync(target, "r");
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== st.dev || opened.ino !== st.ino) {
        throw new FsBridgeError(
          FS_ERR_BOUNDARY,
          `file changed under us (identity mismatch) — refusing to read: ${params.path}`
        );
      }
      buf = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e instanceof FsBridgeError) throw e;
    throw new FsBridgeError(FS_ERR_IO, `read failed: ${(e as Error).message}`);
  }
  // A file can grow between stat and read; re-check the actual size.
  if (buf.length > maxBytes) {
    throw new FsBridgeError(
      FS_ERR_TOO_LARGE,
      `file grew past the ${maxBytes} byte limit while reading`
    );
  }
  return { content: decodeUtf8Strict(buf) };
}

export async function bridgeWriteTextFile(
  root: string,
  sessionId: string,
  params: WriteParams,
  opts: { auditPath?: string } = {}
): Promise<null> {
  const auditPath = opts.auditPath ?? auditLogPath();
  if (!fsBridgeEnabled()) {
    appendAudit(
      {
        ts: new Date().toISOString(),
        sessionId,
        op: "write",
        path: typeof params.path === "string" ? params.path : "(invalid)",
        bytes: null,
        outcome: "denied",
        detail: "fs bridge disabled",
      },
      auditPath
    );
    throw new FsBridgeError(FS_ERR_DISABLED, "fs bridge disabled (GROK_DESKTOP_FS_BRIDGE=off)");
  }
  if (typeof params.content !== "string") {
    throw new FsBridgeError(FS_ERR_BAD_PARAMS, "content must be a string");
  }
  let target: string;
  try {
    target = resolveJailedForWrite(root, params.path as string);
  } catch (e) {
    const detail = e instanceof FsBridgeError ? e.message : (e as Error).message;
    appendAudit(
      {
        ts: new Date().toISOString(),
        sessionId,
        op: "write",
        path: typeof params.path === "string" ? params.path : "(invalid)",
        bytes: null,
        outcome: "denied",
        detail,
      },
      auditPath
    );
    throw e;
  }

  try {
    // TOCTOU hardening (write side): re-validate the final parent directory
    // immediately before creating anything, then write through a descriptor
    // verified by identity for pre-existing targets. 'wx' refuses to follow
    // a raced-in symlink (fails on any existing path), and a fresh name in
    // a validated directory cannot escape the root.
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    const realRoot = fs.realpathSync.native(path.resolve(root));
    const realDir = fs.realpathSync.native(dir);
    if (!contains(realRoot, realDir)) {
      throw new FsBridgeError(
        FS_ERR_BOUNDARY,
        `target directory resolves outside the session root: ${params.path}`
      );
    }
    const existed = fs.existsSync(target);
    const preStat = existed ? fs.statSync(target) : null;
    const flags = existed ? "r+" : "wx";
    const fd = fs.openSync(target, flags);
    try {
      if (preStat) {
        // Pre-existing target: compare the OPENED object against the
        // PRE-OPEN identity. (Statting the path again would resolve whatever
        // the attacker swapped in and always match — the pre-open stat is the
        // trusted reference; a swap between stat and open changes identity.)
        const opened = fs.fstatSync(fd);
        if (opened.dev !== preStat.dev || opened.ino !== preStat.ino) {
          throw new FsBridgeError(
            FS_ERR_BOUNDARY,
            `file changed under us (identity mismatch) — refusing to write: ${params.path}`
          );
        }
        fs.ftruncateSync(fd, 0);
      }
      fs.writeFileSync(fd, params.content, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (e instanceof FsBridgeError) {
      appendAudit(
        {
          ts: new Date().toISOString(),
          sessionId,
          op: "write",
          path: target,
          bytes: null,
          outcome: "denied",
          detail: e.message,
        },
        auditPath
      );
      throw e;
    }
    appendAudit(
      {
        ts: new Date().toISOString(),
        sessionId,
        op: "write",
        path: target,
        bytes: null,
        outcome: "error",
        detail: (e as Error).message,
      },
      auditPath
    );
    throw new FsBridgeError(FS_ERR_IO, `write failed: ${(e as Error).message}`);
  }
  appendAudit(
    {
      ts: new Date().toISOString(),
      sessionId,
      op: "write",
      path: target,
      bytes: Buffer.byteLength(params.content, "utf-8"),
      outcome: "allowed",
    },
    auditPath
  );
  return null;
}
