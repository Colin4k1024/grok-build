// Throwaway harness: verifies the mcp-config editor round-trips a synthetic
// config without touching unrelated tables. Run: node scripts/test-mcp-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
fs.mkdirSync(path.join(tmp, ".grok"), { recursive: true });
const cfgPath = path.join(tmp, ".grok", "config.toml");

const original = fs.readFileSync(path.join(process.env.HOME, ".grok", "config.toml"), "utf-8");
const synthetic =
  original +
  '\n[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\nstartup_timeout_sec = 30\n\n[mcp_servers.github.env]\nGITHUB_TOKEN = "abc"\n\n[mcp_servers.exa]\nurl = "https://mcp.exa.ai/mcp"\n\n[ui]\nmax_thoughts_width = 120\n';
fs.writeFileSync(cfgPath, synthetic);
process.env.GROK_HOME = path.join(tmp, ".grok");

const mcp = require("../dist-electron/mcp-config.cjs");

const parsed = mcp.getMcpServers();
console.log("parsed:", JSON.stringify(parsed, null, 1));
if (parsed.length !== 2) throw new Error(`expected 2 servers, got ${parsed.length}`);
if (!parsed.find((s) => s.name === "github" && s.command === "npx" && s.args.length === 2 && s.transport_type === "stdio")) throw new Error("github stdio parse mismatch");
if (!parsed.find((s) => s.name === "exa" && s.url === "https://mcp.exa.ai/mcp" && s.transport_type === "http")) throw new Error("exa http parse mismatch");
if (!parsed.find((s) => s.name === "github" && s.env.length === 1 && s.env[0][0] === "GITHUB_TOKEN")) throw new Error("env table parse mismatch");

mcp.toggleMcpServer("exa", false);
mcp.saveMcpServer({ name: "context7", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], url: null, env: [["FOO", "bar"]] });
mcp.deleteMcpServer("github");

const after = mcp.getMcpServers();
console.log("after:", JSON.stringify(after, null, 1));
const exa = after.find((s) => s.name === "exa");
if (!exa || exa.enabled !== false) throw new Error("toggle failed");
if (!after.find((s) => s.name === "context7" && s.env[0][0] === "FOO")) throw new Error("save failed");
if (after.find((s) => s.name === "github")) throw new Error("delete failed");

const text = fs.readFileSync(cfgPath, "utf-8");
for (const keep of ["[cli]", "[ui]", "[models]", "[marketplace]", 'default = "grok-4.6"', "max_thoughts_width = 120"]) {
  if (!text.includes(keep)) throw new Error(`unrelated content lost: ${keep}`);
}
if (text.includes("GITHUB_TOKEN")) throw new Error("github env not removed");
console.log("--- config after mutations ---");
console.log(text);
console.log("ALL MCP CONFIG TESTS PASSED");
