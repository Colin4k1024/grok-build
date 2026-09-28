import fs from "node:fs";
import path from "node:path";

/**
 * Transfer file helpers (R4-06 #239) — the testable core of the
 * settings_transfer_save / settings_transfer_open IPC handlers.
 * The dialog dance stays in main.ts; validation and file IO live here.
 */

/** 1 MiB bound in both directions. */
export const MAX_TRANSFER_BYTES = 1024 * 1024;

/** Only a bare file NAME is honored — never a renderer-supplied path. */
export function sanitizeTransferFileName(name: unknown): string {
  const base = path.basename(String(name ?? ""));
  return base && base !== "." && base !== ".." ? base : "grok-build-settings.json";
}

export function validateTransferContent(content: unknown): string {
  if (typeof content !== "string") {
    throw new Error("settings transfer: content must be a string");
  }
  if (Buffer.byteLength(content, "utf-8") > MAX_TRANSFER_BYTES) {
    throw new Error(`settings transfer: content exceeds ${MAX_TRANSFER_BYTES} bytes`);
  }
  return content;
}

/** Atomic write (unique tmp + rename) — no half-written export files and
 *  no clobbering of an unrelated `<file>.tmp` left by another process. */
export function writeTransferFile(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

/** Bounded read via fd — at most MAX+1 bytes are ever buffered (no
 *  whole-file read, no stat TOCTOU). Over-limit or unreadable → null. */
export function readTransferFile(filePath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(MAX_TRANSFER_BYTES + 1);
    const bytesRead = fs.readSync(fd, buf, 0, MAX_TRANSFER_BYTES + 1, 0);
    if (bytesRead > MAX_TRANSFER_BYTES) return null;
    return buf.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}
