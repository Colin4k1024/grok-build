import fs from "node:fs";
import path from "node:path";

/**
 * Durable settings file store (R4-05 #238): userData/gb-settings.json.
 *
 * This is the typed, unified settings IPC backend — one channel family
 * instead of per-page ad-hoc invokes. It is deliberately dumb about
 * semantics (the renderer's typed registry owns validation semantics);
 * it is strict about safety: key shape, JSON-serializability, value size,
 * and corruption quarantine (never silently overwrite a broken file).
 */

export interface SettingsFile {
  version: 1;
  values: Record<string, unknown>;
}

export class SettingsStoreError extends Error {
  code: "invalid_key" | "invalid_value";
  constructor(code: "invalid_key" | "invalid_value", detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const FILE_NAME = "gb-settings.json";
const KEY_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const MAX_VALUE_BYTES = 16 * 1024;

function filePath(dir: string): string {
  return path.join(dir, FILE_NAME);
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new SettingsStoreError("invalid_key", `malformed settings key: ${JSON.stringify(key)}`);
  }
}

function assertValue(value: unknown): void {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new SettingsStoreError("invalid_value", "value is not JSON-serializable");
  }
  if (json === undefined) {
    throw new SettingsStoreError("invalid_value", "value must be JSON-serializable (got undefined)");
  }
  if (json.length > MAX_VALUE_BYTES) {
    throw new SettingsStoreError("invalid_value", `value exceeds ${MAX_VALUE_BYTES} bytes`);
  }
}

function isValidDoc(doc: unknown): doc is SettingsFile {
  return (
    typeof doc === "object" &&
    doc !== null &&
    (doc as SettingsFile).version === 1 &&
    typeof (doc as SettingsFile).values === "object" &&
    !Array.isArray((doc as SettingsFile).values)
  );
}

/** Read the store; a missing file is an empty store, a corrupt file is
 *  quarantined (renamed, never overwritten) and reported as empty. */
export function readSettingsFile(dir: string): SettingsFile {
  const file = filePath(dir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return { version: 1, values: {} };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isValidDoc(parsed)) return parsed;
    throw new Error("bad shape");
  } catch {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, quarantine);
    } catch {
      /* quarantine failed — still don't trust the content */
    }
    return { version: 1, values: {} };
  }
}

function writeDoc(dir: string, doc: SettingsFile): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = filePath(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf-8");
  fs.renameSync(tmp, file); // atomic replace — no half-written JSON
}

export function writeSettingsValue(dir: string, key: unknown, value: unknown): SettingsFile {
  assertKey(key);
  assertValue(value);
  const doc = readSettingsFile(dir);
  doc.values[key] = value;
  writeDoc(dir, doc);
  return doc;
}

export function deleteSettingsValue(dir: string, key: unknown): SettingsFile {
  assertKey(key);
  const doc = readSettingsFile(dir);
  delete doc.values[key];
  writeDoc(dir, doc);
  return doc;
}

export function resetSettingsFile(dir: string): SettingsFile {
  const doc: SettingsFile = { version: 1, values: {} };
  writeDoc(dir, doc);
  return doc;
}
