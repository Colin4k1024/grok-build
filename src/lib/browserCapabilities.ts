/**
 * Centralized capability probe (R3-16).
 *
 * Browser use and Computer use are capability-gated: the agent must have
 * a browser-use tool endpoint AND the Electron shell must have a managed
 * browser transport. Until both exist, the UI hides the entry points and
 * shows an explicit degradation notice.
 *
 * Environment flags (override-capability for development):
 *   GROK_BROWSER_ENABLED=1  — pretend browser capability is available
 *   GROK_COMPUTER_ENABLED=1 — pretend computer-use capability is available
 */

export interface BrowserCapabilities {
  /** Agent supports browser-use tool calls (playwright/puppeteer MCP). */
  browserAvailable: boolean;
  /** Agent supports computer-use / appshot actions. */
  computerAvailable: boolean;
  /** Reason capability is unavailable (shown in UI when degraded). */
  reason: string | null;
}

export function probeBrowserCaps(): BrowserCapabilities {
  if (typeof process === "undefined" && typeof window === "undefined") {
    return { browserAvailable: false, computerAvailable: false, reason: null };
  }

  // Development override flags
  const env = (typeof window !== "undefined"
    ? (window as unknown as { __GROK_ENV__?: Record<string, string> }).__GROK_ENV__
    : undefined) ?? {};

  if (env.GROK_BROWSER_ENABLED === "1" && env.GROK_COMPUTER_ENABLED === "1") {
    return { browserAvailable: true, computerAvailable: true, reason: null };
  }
  if (env.GROK_BROWSER_ENABLED === "1") {
    return { browserAvailable: true, computerAvailable: false, reason: "Computer Use 未启用（GROK_COMPUTER_ENABLED=1 开启）" };
  }

  // Real probe: browser use requires an MCP server with browser tools
  // and a managed browser profile. Without agent-side tool discovery,
  // we probe the Electron shell environment.
  const hasMCPBrowser = checkMcpBrowserAvailable();
  const hasElectronWebContents = typeof window !== "undefined";

  if (!hasMCPBrowser && !hasElectronWebContents) {
    return {
      browserAvailable: false,
      computerAvailable: false,
      reason: "浏览器和桌面控制功能需要配置 MCP 服务并授予系统权限",
    };
  }
  if (!hasMCPBrowser) {
    return {
      browserAvailable: false,
      computerAvailable: false,
      reason: "需要配置浏览器 MCP 服务器（如 @anthropic/mcp-server-puppeteer）",
    };
  }

  return {
    browserAvailable: hasMCPBrowser,
    computerAvailable: false,
    reason: "Computer Use 需要额外的系统权限和 agent 端能力支持",
  };
}

/** Check if any MCP server with browser-use capabilities is configured. */
function checkMcpBrowserAvailable(): boolean {
  try {
    // Probe the localStorage MCP config cache (synced from ~/.grok/config.toml)
    const rawMcp = localStorage.getItem("gb-mcp-servers-cache");
    if (!rawMcp) return false;
    const servers = JSON.parse(rawMcp) as { name: string; command?: string; enabled?: boolean }[];
    return servers.some((s) => {
      if (s.enabled === false) return false;
      const cmd = (s.command ?? "").toLowerCase();
      return (
        /puppeteer|playwright|browser|selenium|webdriver/i.test(cmd) ||
        /mcp.*server.*puppeteer/i.test(cmd) ||
        /browserbase|browserless/i.test(cmd) ||
        /computer.?use/i.test(s.name)
      );
    });
  } catch {
    return false;
  }
}