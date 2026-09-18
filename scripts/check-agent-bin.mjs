#!/usr/bin/env node
/**
 * Pack gate for the Electron release pipeline (ISS-071).
 *
 * electron-builder bundles the Rust agent via extraResources; if the binary
 * is missing or truncated we would ship an empty shell that can't spawn a
 * single session. This gate fails the pack step loudly instead.
 *
 * Usage: node scripts/check-agent-bin.mjs <path-to-binary>
 * Exit:  0 = binary present and non-empty; 1 = anything else.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @returns {{ok: boolean, reason: string}} ok=false carries a human reason.
 */
export function verifyAgentBinary(binPath) {
  if (!binPath || typeof binPath !== "string") {
    return { ok: false, reason: "no binary path given" };
  }
  let st;
  try {
    st = fs.statSync(path.resolve(binPath));
  } catch {
    return { ok: false, reason: `agent binary not found at ${binPath} — build it first (cargo build --release -p xai-grok-pager-bin)` };
  }
  if (st.isDirectory()) {
    return { ok: false, reason: `agent binary path is a directory: ${binPath}` };
  }
  if (st.size === 0) {
    return { ok: false, reason: `agent binary is empty (0 bytes): ${binPath}` };
  }
  return { ok: true, reason: `${binPath} (${st.size} bytes)` };
}

// CLI mode only when executed directly (not under vitest imports).
const isCli =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const result = verifyAgentBinary(process.argv[2]);
  if (!result.ok) {
    console.error(`[pack-gate] FAIL: ${result.reason}`);
    process.exit(1);
  }
  console.log(`[pack-gate] OK: ${result.reason}`);
}
