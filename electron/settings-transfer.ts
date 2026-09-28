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

/** Atomic write (tmp + rename) — no half-written export files. */
export function writeTransferFile(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

/** Read-then-bound (no stat/TOCTOU race); unreadable → null, not a throw. */
export function readTransferFile(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.byteLength > MAX_TRANSFER_BYTES) return null;
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}
