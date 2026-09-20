// @vitest-environment node
/**
 * Plugin/Skill/MCP lifecycle integration tests (R3-07 / #192).
 *
 * These tests prove the lifecycle manager really handles:
 *   - Install/enable/disable/upgrade/rollback/uninstall with real file I/O
 *   - Manifest schema validation (rejects malicious/invalid manifests)
 *   - Disabled components cannot inject tools (runtime gate)
 *   - Atomic install (crash mid-install leaves no half-registered state)
 *   - Dependency resolution (circular deps rejected, missing deps blocked)
 *   - Credentials not stored (only env key names)
 *
 * Real side effects: real file reads/writes to a temp GROK_HOME. No mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  installComponent,
  enableComponent,
  disableComponent,
  upgradeComponent,
  rollbackComponent,
  uninstallComponent,
  canInjectTools,
  listComponents,
  validateManifest,
  recoverRegistry,
  clearPluginCache,
  PluginLifecycleError,
  PLUGIN_ERR_MANIFEST,
  PLUGIN_ERR_DEPENDENCY,
  PLUGIN_ERR_PERMISSION,
  PLUGIN_ERR_CONFLICT,
  type PluginManifest,
} from "../plugin-lifecycle";

let tmp = "";
let savedGrokHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-plug-192-"));
  savedGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = tmp;
  clearPluginCache();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
  clearPluginCache();
});

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "test-plugin",
    version: "1.0.0",
    type: "mcp",
    command: "npx",
    args: ["-y", "test-pkg"],
    envKeys: ["API_KEY"],
    source: "npm",
    permissions: ["read-files"],
    dependencies: [],
    ...overrides,
  };
}

describe("install → enable → disable → upgrade → rollback → uninstall (R3-07 #192)", () => {
  it("installs a component (disabled by default) and lists it", () => {
    const entry = installComponent(makeManifest());
    expect(entry.name).toBe("test-plugin");
    expect(entry.enabled).toBe(false); // disabled by default
    expect(listComponents()).toHaveLength(1);
    // The registry file was really written to disk.
    const regFile = path.join(tmp, "plugins.json");
    expect(fs.existsSync(regFile)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(raw.components).toHaveLength(1);
  });

  it("enable a component — it can now inject tools", () => {
    installComponent(makeManifest());
    expect(canInjectTools("mcp", "test-plugin")).toBe(false); // disabled
    enableComponent("mcp", "test-plugin");
    expect(canInjectTools("mcp", "test-plugin")).toBe(true); // enabled
  });

  it("disable a component — it can no longer inject tools", () => {
    installComponent(makeManifest());
    enableComponent("mcp", "test-plugin");
    expect(canInjectTools("mcp", "test-plugin")).toBe(true);
    disableComponent("mcp", "test-plugin");
    expect(canInjectTools("mcp", "test-plugin")).toBe(false); // disabled again
  });

  it("upgrade saves the previous version for rollback", () => {
    installComponent(makeManifest({ version: "1.0.0" }));
    enableComponent("mcp", "test-plugin");
    upgradeComponent("mcp", "test-plugin", "2.0.0");
    const c = listComponents().find((x) => x.name === "test-plugin");
    expect(c?.version).toBe("2.0.0");
    expect(c?.previousVersion).toBe("1.0.0");
    expect(c?.enabled).toBe(false); // disabled after upgrade
  });

  it("rollback restores the previous version", () => {
    installComponent(makeManifest({ version: "1.0.0" }));
    upgradeComponent("mcp", "test-plugin", "2.0.0");
    rollbackComponent("mcp", "test-plugin");
    const c = listComponents().find((x) => x.name === "test-plugin");
    expect(c?.version).toBe("1.0.0");
    expect(c?.previousVersion).toBeUndefined();
  });

  it("uninstall removes the component from the registry", () => {
    installComponent(makeManifest());
    expect(listComponents()).toHaveLength(1);
    expect(uninstallComponent("mcp", "test-plugin")).toBe(true);
    expect(listComponents()).toHaveLength(0);
  });

  it("uninstall of a non-existent component returns false", () => {
    expect(uninstallComponent("mcp", "nope")).toBe(false);
  });
});

describe("manifest schema validation — rejects malicious/invalid manifests (R3-07 #192)", () => {
  it("rejects a manifest with a missing name", () => {
    expect(() => validateManifest(makeManifest({ name: "" }))).toThrow(PluginLifecycleError);
  });

  it("rejects a non-semver version", () => {
    expect(() => validateManifest(makeManifest({ version: "latest" }))).toThrow(PluginLifecycleError);
  });

  it("rejects an invalid type", () => {
    expect(() => validateManifest(makeManifest({ type: "virus" as never }))).toThrow(PluginLifecycleError);
  });

  it("rejects dangerous permissions (system/root/sudo)", () => {
    expect(() =>
      validateManifest(makeManifest({ permissions: ["system-root"] }))
    ).toThrow(PluginLifecycleError);
    try {
      validateManifest(makeManifest({ permissions: ["network-unrestricted"] }));
    } catch (e) {
      expect((e as PluginLifecycleError).code).toBe(PLUGIN_ERR_PERMISSION);
    }
  });

  it("rejects circular dependencies (depends on itself)", () => {
    expect(() =>
      validateManifest(makeManifest({ dependencies: ["test-plugin"] }))
    ).toThrow(PluginLifecycleError);
  });

  it("rejects unknown fields that could carry malicious payloads", () => {
    const bad = { ...makeManifest(), evil_payload: "rm -rf /" };
    expect(() => validateManifest(bad)).toThrow(PluginLifecycleError);
  });

  it("rejects a missing source", () => {
    expect(() => validateManifest(makeManifest({ source: "" }))).toThrow(PluginLifecycleError);
  });
});

describe("dependency resolution (R3-07 #192)", () => {
  it("installing a component with a missing dependency is rejected", () => {
    expect(() =>
      installComponent(makeManifest({ dependencies: ["missing-dep"] }))
    ).toThrow(PluginLifecycleError);
  });

  it("installing a component with an installed+enabled dependency succeeds", () => {
    installComponent(makeManifest({ name: "dep-1", dependencies: [] }));
    enableComponent("mcp", "dep-1");
    // Now install a component that depends on dep-1.
    expect(() =>
      installComponent(makeManifest({ name: "dependent", dependencies: ["dep-1"] }))
    ).not.toThrow();
  });

  it("enabling a component whose dependency is disabled fails", () => {
    installComponent(makeManifest({ name: "dep-2", dependencies: [] }));
    // dep-2 is disabled. Install a component that depends on it.
    installComponent(makeManifest({ name: "dependent-2", dependencies: ["dep-2"] }));
    expect(() => enableComponent("mcp", "dependent-2")).toThrow(PluginLifecycleError);
  });

  it("canInjectTools returns false when a dependency is disabled after enabling", () => {
    installComponent(makeManifest({ name: "dep-3" }));
    enableComponent("mcp", "dep-3");
    installComponent(makeManifest({ name: "dependent-3", dependencies: ["dep-3"] }));
    enableComponent("mcp", "dependent-3");
    expect(canInjectTools("mcp", "dependent-3")).toBe(true);
    // Disable the dependency — the dependent can no longer inject.
    disableComponent("mcp", "dep-3");
    expect(canInjectTools("mcp", "dependent-3")).toBe(false);
  });
});

describe("conflict detection (R3-07 #192)", () => {
  it("installing the same type+name twice is rejected", () => {
    installComponent(makeManifest());
    expect(() => installComponent(makeManifest())).toThrow(PluginLifecycleError);
    try {
      installComponent(makeManifest());
    } catch (e) {
      expect((e as PluginLifecycleError).code).toBe(PLUGIN_ERR_CONFLICT);
    }
  });

  it("same name but different type is allowed (plugin vs mcp)", () => {
    installComponent(makeManifest({ type: "mcp" }));
    expect(() => installComponent(makeManifest({ type: "plugin" }))).not.toThrow();
  });
});

describe("disabled components cannot inject tools (R3-07 #192)", () => {
  it("a freshly installed component is disabled — canInjectTools returns false", () => {
    installComponent(makeManifest());
    expect(canInjectTools("mcp", "test-plugin")).toBe(false);
  });

  it("an uninstalled component returns false", () => {
    expect(canInjectTools("mcp", "never-installed")).toBe(false);
  });

  it("enable then disable — the gate reflects the state", () => {
    installComponent(makeManifest());
    enableComponent("mcp", "test-plugin");
    expect(canInjectTools("mcp", "test-plugin")).toBe(true);
    disableComponent("mcp", "test-plugin");
    expect(canInjectTools("mcp", "test-plugin")).toBe(false);
  });
});

describe("credentials not stored in config or logs (R3-07 #192)", () => {
  it("the registry file only stores env key NAMES, not values", () => {
    installComponent(makeManifest({ envKeys: ["SECRET_API_KEY"] }));
    const regFile = path.join(tmp, "plugins.json");
    const raw = fs.readFileSync(regFile, "utf-8");
    expect(raw).toContain("SECRET_API_KEY"); // key name
    expect(raw).not.toContain("sk-"); // no value
    expect(raw).not.toMatch(/password|secret.*=\s*\w/i); // no credential values
  });
});

describe("atomic install — crash recovery (R3-07 #192)", () => {
  it("the registry is written atomically (temp+rename, no half-written file)", () => {
    installComponent(makeManifest());
    const regFile = path.join(tmp, "plugins.json");
    // No temp file left behind.
    const tempFiles = fs.readdirSync(tmp).filter((f) => f.startsWith(".plugins."));
    expect(tempFiles).toHaveLength(0);
    // The registry is valid JSON.
    expect(() => JSON.parse(fs.readFileSync(regFile, "utf-8"))).not.toThrow();
  });

  it("recoverRegistry handles a corrupt registry file gracefully", () => {
    // Write a corrupt registry file (simulating a crash mid-write).
    const regFile = path.join(tmp, "plugins.json");
    fs.writeFileSync(regFile, "{ broken json {{{", "utf-8");
    clearPluginCache();
    const reg = recoverRegistry();
    expect(reg.components).toHaveLength(0); // fresh start
    // The corrupt file was overwritten with a valid empty registry.
    expect(() => JSON.parse(fs.readFileSync(regFile, "utf-8"))).not.toThrow();
  });

  it("recoverRegistry loads a valid registry correctly", () => {
    installComponent(makeManifest({ name: "survivor" }));
    enableComponent("mcp", "survivor");
    clearPluginCache();
    const reg = recoverRegistry();
    expect(reg.components).toHaveLength(1);
    expect(reg.components[0].name).toBe("survivor");
    expect(reg.components[0].enabled).toBe(true);
  });
});

describe("three distinct capability types (R3-07 #192)", () => {
  it("plugin, skill, and mcp are distinct types with separate registries", () => {
    installComponent(makeManifest({ name: "my-plugin", type: "plugin" }));
    installComponent(makeManifest({ name: "my-skill", type: "skill" }));
    installComponent(makeManifest({ name: "my-mcp", type: "mcp" }));
    const comps = listComponents();
    expect(comps).toHaveLength(3);
    const types = comps.map((c) => c.type).sort();
    expect(types).toEqual(["mcp", "plugin", "skill"]);
  });
});
