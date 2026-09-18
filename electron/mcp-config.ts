/**
 * MCP server config editor for ~/.grok/config.toml — Electron port of
 * src-tauri/src/commands/mcp.rs.
 *
 * Rather than a full TOML round-trip (which would drop comments and reorder
 * keys), this edits only the `[mcp_servers.*]` table line ranges and leaves
 * every other byte of the file untouched.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Mirror the agent's GROK_HOME resolution ("Set GROK_HOME to override"). */
function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

function configPath(): string {
  return path.join(grokHome(), "config.toml");
}

export interface McpServerInfo {
  name: string;
  command: string;
  args: string[];
  url: string | null;
  enabled: boolean;
  transport_type: string;
  env: [string, string][];
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
}

type Primitive = string | boolean | number;

interface ServerEntry {
  values: Map<string, Primitive | string[]>;
  env: Map<string, string>;
}

// ---- value parsing / serialization -----------------------------------------

function parseValue(raw: string): Primitive | string[] | undefined {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  if (t.startsWith("[")) {
    // array of scalars — strings, ints, bools
    try {
      const arr = JSON.parse(t.replace(/'/g, '"'));
      if (Array.isArray(arr)) return arr.map((v) => String(v));
    } catch {
      /* fall through */
    }
    return t
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (t.startsWith('"') || t.startsWith("'")) {
    return t.slice(1, -1);
  }
  return t; // bare string
}

// ---- section scanning --------------------------------------------------------

interface SectionRange {
  /** decoded server name */
  name: string;
  /** true for the `[mcp_servers.NAME.env]` sub-table */
  isEnv: boolean;
  start: number; // inclusive line index of the header
  end: number; // exclusive line index (next header or EOF)
}

function decodeName(raw: string): string {
  const n = raw.trim();
  if (n.startsWith('"') && n.endsWith('"')) return n.slice(1, -1);
  return n;
}

/** Split a TOML header path on dots, honoring quoted segments —
 *  `[mcp_servers."weird.name"]` is mcp_servers + weird.name, not three parts
 *  (the old blind split made such sections invisible; #163). */
function splitHeader(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === "." && !inQuote) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function scanSections(lines: string[]): SectionRange[] {
  const out: SectionRange[] = [];
  let current: SectionRange | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\[([^\]]+)\]/);
    if (m) {
      if (current) current.end = i;
      const parts = splitHeader(m[1]);
      if (parts[0] === "mcp_servers" && parts.length >= 2) {
        const name = decodeName(parts.slice(1, parts.length - 1).join(".") || parts[1]);
        const isEnv = parts[parts.length - 1] === "env" && parts.length >= 3;
        current = { name, isEnv, start: i, end: lines.length };
        out.push(current);
      } else {
        current = null;
      }
    }
  }
  return out;
}

function readConfig(): string {
  try {
    const p = configPath();
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  } catch (e) {
    console.error("[mcp] failed to read config:", e);
  }
  return "";
}

function writeConfig(content: string): void {
  fs.mkdirSync(grokHome(), { recursive: true });
  fs.writeFileSync(configPath(), content);
}

export function getMcpServers(): McpServerInfo[] {
  const lines = readConfig().split("\n");
  const sections = scanSections(lines);
  const entries = new Map<string, ServerEntry>();

  for (const sec of sections) {
    let entry = entries.get(sec.name);
    if (!entry) {
      entry = { values: new Map(), env: new Map() };
      entries.set(sec.name, entry);
    }
    for (let i = sec.start + 1; i < sec.end; i++) {
      const km = lines[i].match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
      if (!km) continue;
      const v = parseValue(km[2]);
      if (sec.isEnv) {
        if (typeof v === "string") entry.env.set(km[1], v);
      } else if (v !== undefined) {
        entry.values.set(km[1], v);
      }
    }
  }

  const out: McpServerInfo[] = [];
  for (const [name, e] of entries) {
    const command = e.values.get("command");
    const url = e.values.get("url");
    const args = e.values.get("args");
    out.push({
      name,
      command: typeof command === "string" ? command : "",
      args: Array.isArray(args) ? args : [],
      url: typeof url === "string" ? url : null,
      enabled: e.values.get("enabled") !== false,
      transport_type: typeof command === "string" ? "stdio" : typeof url === "string" ? "http" : "unknown",
      env: Array.from(e.env.entries()),
      startup_timeout_sec: typeof e.values.get("startup_timeout_sec") === "number"
        ? (e.values.get("startup_timeout_sec") as number)
        : undefined,
      tool_timeout_sec: typeof e.values.get("tool_timeout_sec") === "number"
        ? (e.values.get("tool_timeout_sec") as number)
        : undefined,
    });
  }
  return out;
}

function serializeServer(name: string, input: SaveInput): string {
  // Dotted names MUST be quoted on write, or the next scan splits them again.
  const key = name.includes(".") ? `"${name}"` : name;
  const out: string[] = [];
  out.push(`[mcp_servers.${key}]`);
  if (input.command) out.push(`command = ${JSON.stringify(input.command)}`);
  if (input.args && input.args.length > 0) {
    out.push(`args = [${input.args.map((s) => JSON.stringify(s)).join(", ")}]`);
  }
  if (input.url) out.push(`url = ${JSON.stringify(input.url)}`);
  if (typeof input.enabled === "boolean") out.push(`enabled = ${input.enabled}`);
  if (typeof input.startup_timeout_sec === "number") out.push(`startup_timeout_sec = ${input.startup_timeout_sec}`);
  if (typeof input.tool_timeout_sec === "number") out.push(`tool_timeout_sec = ${input.tool_timeout_sec}`);
  if (input.env && input.env.length > 0) {
    out.push("");
    out.push(`[mcp_servers.${key}.env]`);
    for (const [k, v] of input.env) out.push(`${k} = ${JSON.stringify(v)}`);
  }
  return out.join("\n");
}

export interface SaveInput {
  name: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: [string, string][];
  enabled?: boolean;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
}

/**
 * Rewrite the `[mcp_servers.NAME]` sections. All other lines are preserved
 * byte-for-byte. The replacement block lands where the server's first section
 * started, or at EOF for new servers.
 */
function replaceServerSections(input: SaveInput, remove: boolean): void {
  const original = readConfig();
  const lines = original.split("\n");
  const sections = scanSections(lines).filter((s) => s.name === input.name);
  const block = remove ? [] : serializeServer(input.name, input).split("\n");

  if (sections.length === 0) {
    if (remove) return;
    const trimmed = original.replace(/\n+$/, "");
    const next = (trimmed ? trimmed + "\n\n" : "") + block.join("\n") + "\n";
    writeConfig(next);
    return;
  }

  // Replace the first section in place; drop the rest.
  const first = sections[0];
  const drop = new Set<number>();
  for (const sec of sections) {
    for (let i = sec.start; i < sec.end; i++) drop.add(i);
  }
  const out: string[] = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i++) {
    if (!drop.has(i)) {
      out.push(lines[i]);
      continue;
    }
    if (i === first.start && !inserted) {
      out.push(...block);
      // Preserve the blank-line separator the dropped section used to have
      // before the following table header.
      const nextKept = lines.slice(i, first.end).length > 0 ? lines[first.end] : undefined;
      if (nextKept !== undefined && nextKept.trimStart().startsWith("[")) out.push("");
      inserted = true;
    }
  }
  writeConfig(out.join("\n"));
}

export function saveMcpServer(input: SaveInput): void {
  replaceServerSections(input, false);
}

export function deleteMcpServer(name: string): void {
  replaceServerSections({ name, command: null, args: [], url: null, env: [] }, true);
}

export function toggleMcpServer(name: string, enabled: boolean): void {
  const existing = getMcpServers().find((s) => s.name === name);
  if (!existing) throw new Error(`MCP server ${name} not found`);
  replaceServerSections(
    {
      name,
      command: existing.command || null,
      args: existing.args,
      url: existing.url,
      env: existing.env,
      enabled,
      startup_timeout_sec: existing.startup_timeout_sec,
      tool_timeout_sec: existing.tool_timeout_sec,
    },
    false
  );
}
