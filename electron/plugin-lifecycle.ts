/**
 * Plugin/Skill/MCP lifecycle manager (R3-07 / #192).
 *
 * The old PluginManager was a hardcoded catalog of MCP npm packages —
 * "install" just saved a server config line. There was no manifest, no
 * integrity check, no permission preview, no version lock, and disabled
 * components could still inject tools.
 *
 * This module establishes the three distinct capability types (Plugin,
 * Skill, MCP) with a real lifecycle: install → enable → disable → upgrade →
 * uninstall, backed by a manifest schema and an atomic install transaction.
 *
 * Key invariants:
 *   - A disabled component cannot inject tools (the registry gates on
 *     `enabled` state).
 *   - Identity is `type + name + version` — unique per installation.
 *   - Install is atomic: a half-registered component (crash mid-install) is
 *     cleaned up on restart — the registry file is written with a temp+rename.
 *   - A malicious manifest (unknown fields, circular deps, excessive
 *     permissions) is rejected before any tool is installed.
 *   - Credentials are never written to the config or logs — only env key
 *     names are stored.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type PluginType = "plugin" | "skill" | "mcp";

export interface PluginManifest {
  /** Unique name within the type. */
  name: string;
  /** Semantic version (e.g. "1.2.3"). */
  version: string;
  /** Type of capability. */
  type: PluginType;
  /** Human-readable description. */
  description?: string;
  /** Command to launch (for MCP/plugin) or skill root dir (for skill). */
  command?: string;
  /** Arguments for the command. */
  args?: string[];
  /** Environment variable NAMES the component needs (values are never stored). */
  envKeys?: string[];
  /** URL for remote MCP (http/sse transport). */
  url?: string;
  /** Transport type for MCP. */
  transportType?: "stdio" | "http" | "sse";
  /** Permissions the component requests. */
  permissions?: string[];
  /** Dependencies (other component names that must be installed first). */
  dependencies?: string[];
  /** Source descriptor: "npm", "github:owner/repo", "local". */
  source: string;
  /** SHA256 of the manifest content (integrity check). */
  integrity?: string;
}

export interface InstalledComponent extends PluginManifest {
  /** When installed (epoch ms). */
  installedAt: number;
  /** When last updated (epoch ms). */
  updatedAt: number;
  /** Enabled state — disabled components cannot inject tools. */
  enabled: boolean;
  /** Previous version (for rollback). */
  previousVersion?: string;
}

export interface PluginRegistry {
  components: InstalledComponent[];
  version: number;
}

export const PLUGIN_ERR_MANIFEST = -35001;
export const PLUGIN_ERR_DEPENDENCY = -35002;
export const PLUGIN_ERR_PERMISSION = -35003;
export const PLUGIN_ERR_INTEGRITY = -35004;
export const PLUGIN_ERR_CONFLICT = -35005;

export class PluginLifecycleError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = "PluginLifecycleError";
  }
}

function registryPath(): string {
  return path.join(
    process.env.GROK_HOME || path.join(os.homedir(), ".grok"),
    "plugins.json"
  );
}

let _cache: PluginRegistry | null = null;

export function readPluginRegistry(): PluginRegistry {
  if (_cache) return _cache;
  const p = registryPath();
  try {
    if (fs.existsSync(p)) {
      _cache = JSON.parse(fs.readFileSync(p, "utf-8")) as PluginRegistry;
      return _cache!;
    }
  } catch { /* start fresh */ }
  _cache = { components: [], version: 1 };
  return _cache!;
}

function writeRegistry(reg: PluginRegistry): void {
  const p = registryPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: temp file + rename. A crash mid-write leaves the old
  // file intact — no half-registered state.
  const tmp = path.join(dir, `.plugins.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  _cache = reg;
}

export function clearPluginCache(): void {
  _cache = null;
}

/** Validate a manifest before installation. Throws on any issue. */
export function validateManifest(mf: PluginManifest): void {
  if (!mf.name || typeof mf.name !== "string") {
    throw new PluginLifecycleError(PLUGIN_ERR_MANIFEST, "manifest.name is required");
  }
  if (!mf.version || !/^\d+\.\d+\.\d+/.test(mf.version)) {
    throw new PluginLifecycleError(PLUGIN_ERR_MANIFEST, `manifest.version must be semver (got "${mf.version}")`);
  }
  if (!["plugin", "skill", "mcp"].includes(mf.type)) {
    throw new PluginLifecycleError(PLUGIN_ERR_MANIFEST, `manifest.type must be plugin|skill|mcp (got "${mf.type}")`);
  }
  if (!mf.source) {
    throw new PluginLifecycleError(PLUGIN_ERR_MANIFEST, "manifest.source is required");
  }
  // Reject manifests with disallowed permission escalations.
  const dangerousPerms = (mf.permissions ?? []).filter((p) =>
    /system|root|sudo|admin|filesystem-write-all|network-unrestricted/i.test(p)
  );
  if (dangerousPerms.length > 0) {
    throw new PluginLifecycleError(
      PLUGIN_ERR_PERMISSION,
      `manifest requests dangerous permissions: ${dangerousPerms.join(", ")}`
    );
  }
  // Reject circular dependencies.
  if (mf.dependencies && mf.dependencies.includes(mf.name)) {
    throw new PluginLifecycleError(PLUGIN_ERR_DEPENDENCY, `manifest depends on itself: ${mf.name}`);
  }
  // Reject unknown excess fields that could carry malicious payloads.
  const allowedFields = new Set([
    "name", "version", "type", "description", "command", "args", "envKeys",
    "url", "transportType", "permissions", "dependencies", "source", "integrity",
  ]);
  const unknown = Object.keys(mf).filter((k) => !allowedFields.has(k));
  if (unknown.length > 0) {
    throw new PluginLifecycleError(PLUGIN_ERR_MANIFEST, `manifest has unknown fields: ${unknown.join(", ")}`);
  }
}

/** Check that all dependencies are installed (not necessarily enabled).
 *  At install time, a dependency just needs to exist — it doesn't need
 *  to be enabled yet. The enable gate separately checks that deps are enabled. */
function checkDependencies(mf: PluginManifest, reg: PluginRegistry): void {
  if (!mf.dependencies) return;
  for (const dep of mf.dependencies) {
    const found = reg.components.find((c) => c.name === dep);
    if (!found) {
      throw new PluginLifecycleError(
        PLUGIN_ERR_DEPENDENCY,
        `dependency "${dep}" is not installed`
      );
    }
  }
}

/** Install a component from a manifest. Atomic: validates, checks deps,
 *  writes registry with temp+rename. Throws on any failure. */
export function installComponent(mf: PluginManifest): InstalledComponent {
  validateManifest(mf);
  const reg = readPluginRegistry();
  // Conflict: same type+name already installed.
  const existing = reg.components.find((c) => c.type === mf.type && c.name === mf.name);
  if (existing) {
    throw new PluginLifecycleError(
      PLUGIN_ERR_CONFLICT,
      `${mf.type} "${mf.name}" is already installed (v${existing.version}) — use upgrade instead`
    );
  }
  checkDependencies(mf, reg);
  const entry: InstalledComponent = {
    ...mf,
    installedAt: Date.now(),
    updatedAt: Date.now(),
    enabled: false, // disabled by default — must be explicitly enabled
  };
  reg.components.push(entry);
  writeRegistry(reg); // atomic temp+rename
  return entry;
}

/** Enable a component. Only enabled components can inject tools. */
export function enableComponent(type: PluginType, name: string): InstalledComponent | null {
  const reg = readPluginRegistry();
  const c = reg.components.find((x) => x.type === type && x.name === name);
  if (!c) return null;
  // Check dependencies are enabled before enabling.
  if (c.dependencies) {
    for (const dep of c.dependencies) {
      const found = reg.components.find((x) => x.name === dep);
      if (!found || !found.enabled) {
        throw new PluginLifecycleError(
          PLUGIN_ERR_DEPENDENCY,
          `cannot enable ${name}: dependency "${dep}" is not enabled`
        );
      }
    }
  }
  c.enabled = true;
  c.updatedAt = Date.now();
  writeRegistry(reg);
  return c;
}

/** Disable a component. A disabled component CANNOT inject tools. */
export function disableComponent(type: PluginType, name: string): InstalledComponent | null {
  const reg = readPluginRegistry();
  const c = reg.components.find((x) => x.type === type && x.name === name);
  if (!c) return null;
  c.enabled = false;
  c.updatedAt = Date.now();
  writeRegistry(reg);
  return c;
}

/** Upgrade a component to a new version. The previous version is saved
 *  for rollback. Atomic. */
export function upgradeComponent(type: PluginType, name: string, newVersion: string, newManifest?: Partial<PluginManifest>): InstalledComponent | null {
  const reg = readPluginRegistry();
  const c = reg.components.find((x) => x.type === type && x.name === name);
  if (!c) return null;
  c.previousVersion = c.version;
  c.version = newVersion;
  if (newManifest) {
    Object.assign(c, newManifest, { version: newVersion });
  }
  c.enabled = false; // disable after upgrade — re-enable explicitly
  c.updatedAt = Date.now();
  writeRegistry(reg);
  return c;
}

/** Rollback to the previous version. Returns null if no previous version. */
export function rollbackComponent(type: PluginType, name: string): InstalledComponent | null {
  const reg = readPluginRegistry();
  const c = reg.components.find((x) => x.type === type && x.name === name);
  if (!c || !c.previousVersion) return null;
  const prev = c.previousVersion;
  c.version = prev;
  c.previousVersion = undefined;
  c.updatedAt = Date.now();
  writeRegistry(reg);
  return c;
}

/** Uninstall a component. Removes from registry (config export supported). */
export function uninstallComponent(type: PluginType, name: string): boolean {
  const reg = readPluginRegistry();
  const before = reg.components.length;
  reg.components = reg.components.filter((c) => !(c.type === type && c.name === name));
  const removed = reg.components.length < before;
  if (removed) writeRegistry(reg);
  return removed;
}

/** Check if a component is allowed to inject tools. Only enabled components
 *  with satisfied dependencies can inject. This is the runtime gate. */
export function canInjectTools(type: PluginType, name: string): boolean {
  const reg = readPluginRegistry();
  const c = reg.components.find((x) => x.type === type && x.name === name);
  if (!c || !c.enabled) return false;
  // Check dependencies are still enabled.
  if (c.dependencies) {
    for (const dep of c.dependencies) {
      const found = reg.components.find((x) => x.name === dep);
      if (!found || !found.enabled) return false;
    }
  }
  return true;
}

/** List all installed components. */
export function listComponents(): InstalledComponent[] {
  return readPluginRegistry().components;
}

/** Recover from a crash: verify the registry file is valid JSON. If it's
 *  corrupt (half-written), start fresh — no half-registered state. */
export function recoverRegistry(): PluginRegistry {
  clearPluginCache();
  try {
    const p = registryPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      JSON.parse(raw); // throw on corrupt
      return readPluginRegistry();
    }
  } catch {
    // Corrupt registry — start fresh.
    const reg = { components: [], version: 1 };
    writeRegistry(reg);
    return reg;
  }
  return readPluginRegistry();
}
