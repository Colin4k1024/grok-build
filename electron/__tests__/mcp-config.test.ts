// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getMcpServers,
  saveMcpServer,
  deleteMcpServer,
  toggleMcpServer,
} from "../mcp-config";

let tmp = "";
const savedGrokHome = process.env.GROK_HOME;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-mcp-test-"));
  process.env.GROK_HOME = tmp;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = savedGrokHome;
});

const configPath = () => path.join(tmp, "config.toml");

function writeConfig(content: string) {
  fs.writeFileSync(configPath(), content);
}

const RICH_CONFIG = `# grok-build config
[models]
default = "grok-4"  # inline comment stays

[mcp_servers.fetch]
command = "uvx"
args = ['mcp-server-fetch', '--x']
enabled = true
startup_timeout_sec = 15

[mcp_servers.fetch.env]
API_KEY = "abc"

[other]
keep = "me"
`;

describe("getMcpServers", () => {
  it("returns [] when no config exists", () => {
    expect(getMcpServers()).toEqual([]);
  });

  it("parses command, args, env, enabled, and timeouts", () => {
    writeConfig(RICH_CONFIG);

    const servers = getMcpServers();
    expect(servers).toHaveLength(1);
    const fetch = servers[0];
    expect(fetch).toMatchObject({
      name: "fetch",
      command: "uvx",
      args: ["mcp-server-fetch", "--x"],
      url: null,
      enabled: true,
      transport_type: "stdio",
      startup_timeout_sec: 15,
    });
    expect(fetch.env).toEqual([["API_KEY", "abc"]]);
  });

  it("defaults: enabled true, empty args, unknown transport without command/url", () => {
    writeConfig("[mcp_servers.bare]\nsomething = \"else\"\n");

    const [bare] = getMcpServers();
    expect(bare).toMatchObject({
      name: "bare",
      command: "",
      args: [],
      enabled: true,
      transport_type: "unknown",
    });
  });

  it("an http server is recognized by url", () => {
    writeConfig('[mcp_servers.remote]\nurl = "http://localhost:9sse"\n');

    expect(getMcpServers()[0]).toMatchObject({
      transport_type: "http",
      url: "http://localhost:9sse",
    });
  });

  it("quoted server names decode correctly", () => {
    writeConfig('[mcp_servers."weird"]\ncommand = "x"\n');

    expect(getMcpServers()[0].name).toBe("weird");
  });

  it("enabled = false parses", () => {
    writeConfig('[mcp_servers.off]\ncommand = "x"\nenabled = false\n');

    expect(getMcpServers()[0].enabled).toBe(false);
  });

  it("malformed / non-TOML garbage does not crash", () => {
    writeConfig("this is ][ not toml\nunclosed [\n= = =\n");
    expect(getMcpServers()).toEqual([]);
  });
});

describe("saveMcpServer", () => {
  it("appends a new server to an empty config", () => {
    saveMcpServer({
      name: "fetch",
      command: "uvx",
      args: ["mcp-server-fetch"],
      url: null,
      env: [["K", "V"]],
      enabled: true,
    });

    const content = fs.readFileSync(configPath(), "utf-8");
    expect(content).toContain("[mcp_servers.fetch]");
    expect(content).toContain('command = "uvx"');
    expect(content).toContain('args = ["mcp-server-fetch"]');
    expect(content).toContain("[mcp_servers.fetch.env]");
    expect(getMcpServers()[0].env).toEqual([["K", "V"]]);
  });

  it("round-trips through getMcpServers", () => {
    saveMcpServer({
      name: "s",
      command: "node",
      args: ["a", "b"],
      url: null,
      env: [],
      enabled: false,
      startup_timeout_sec: 5,
      tool_timeout_sec: 60,
    });

    expect(getMcpServers()[0]).toMatchObject({
      name: "s",
      command: "node",
      args: ["a", "b"],
      enabled: false,
      startup_timeout_sec: 5,
      tool_timeout_sec: 60,
    });
  });

  it("rewrites the server block in place and preserves every other byte", () => {
    writeConfig(RICH_CONFIG);
    const before = fs.readFileSync(configPath(), "utf-8");

    saveMcpServer({
      name: "fetch",
      command: "npx",
      args: ["mcp-fetch"],
      url: null,
      env: [["API_KEY", "zzz"]],
    });

    const after = fs.readFileSync(configPath(), "utf-8");

    // Unrelated sections and comments survive untouched
    expect(after).toContain("# grok-build config");
    expect(after).toContain('default = "grok-4"  # inline comment stays');
    expect(after).toContain("[other]");
    expect(after).toContain('keep = "me"');
    expect(before).not.toBe(after);

    // The server block itself was replaced
    expect(after).toContain('command = "npx"');
    expect(after).not.toContain('command = "uvx"');
    expect(getMcpServers()[0]).toMatchObject({ command: "npx", args: ["mcp-fetch"] });
  });

  it("saving with an empty env drops the env sub-table", () => {
    writeConfig(RICH_CONFIG);

    saveMcpServer({
      name: "fetch",
      command: "uvx",
      args: [],
      url: null,
      env: [],
    });

    expect(fs.readFileSync(configPath(), "utf-8")).not.toContain("mcp_servers.fetch.env");
    expect(getMcpServers()[0].env).toEqual([]);
  });
});

describe("deleteMcpServer", () => {
  it("removes the server's sections and leaves the rest of the file intact", () => {
    writeConfig(RICH_CONFIG);

    deleteMcpServer("fetch");

    const after = fs.readFileSync(configPath(), "utf-8");
    expect(after).not.toContain("mcp_servers.fetch");
    expect(after).toContain("[models]");
    expect(after).toContain("[other]");
    expect(getMcpServers()).toEqual([]);
  });

  it("deleting an unknown server is a no-op", () => {
    writeConfig(RICH_CONFIG);
    const before = fs.readFileSync(configPath(), "utf-8");

    deleteMcpServer("ghost");

    expect(fs.readFileSync(configPath(), "utf-8")).toBe(before);
  });
});

describe("toggleMcpServer", () => {
  it("flips enabled while preserving the rest of the entry", () => {
    writeConfig(RICH_CONFIG);

    toggleMcpServer("fetch", false);
    expect(getMcpServers()[0]).toMatchObject({
      enabled: false,
      command: "uvx",
      args: ["mcp-server-fetch", "--x"],
      startup_timeout_sec: 15,
    });

    toggleMcpServer("fetch", true);
    expect(getMcpServers()[0].enabled).toBe(true);
  });

  it("throws for an unknown server", () => {
    writeConfig(RICH_CONFIG);
    expect(() => toggleMcpServer("ghost", true)).toThrow(/not found/);
  });
});
