// Electron test fixture (R5-05 / #261): every test gets a fully isolated app
// instance — throwaway GROK_HOME / GB_JOURNAL_DIR / GB_UAT_USER_DATA_DIR /
// workspace — with deterministic offline boot (seeded model catalog,
// auto_update disabled, known-bad managed MCP servers disabled) and a fixed
// locale/timezone so screenshots reproduce.
//
// The app never touches the real ~/.grok: the fixture asserts (best-effort)
// that no process survives with the isolated env markers after cleanup.

import { test as base, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Resolve the packed app binary, failing with an actionable diagnostic. */
export function resolvePackedApp(): string {
  const candidates = [
    path.join(REPO, "release", "mac-arm64", "Grok Build.app"),
    path.join(REPO, "release", "mac", "Grok Build.app"),
    path.join(REPO, "release", "mac-x64", "Grok Build.app"),
    path.join(REPO, "release", "win-unpacked", "Grok Build.exe"),
    path.join(REPO, "release", "linux-unpacked", "grok-build"),
  ];
  for (const appPath of candidates) {
    const bin = process.platform === "win32"
      ? appPath
      : path.join(appPath, "Contents", "MacOS", "Grok Build");
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error(
    `no packed app found under release/ — run npm run electron:pack first (looked for ${candidates.join(", ")})`
  );
}

/** Minimal model catalog so the agent never needs the network at boot. */
function writeMinimalCatalog(grokHome: string) {
  fs.writeFileSync(
    path.join(grokHome, "default_models.json"),
    JSON.stringify({
      models: [
        {
          model: "uat-offline",
          name: "UAT Offline",
          base_url: "http://127.0.0.1:9/unused",
          api_backend: "openai",
          context_window: 128000,
          hidden: false,
          env_key: [],
        },
      ],
      default: "uat-offline",
      web_search: "uat-offline",
      image_description: "uat-offline",
      session_summary: "uat-offline",
    })
  );
  fs.writeFileSync(
    path.join(grokHome, "version.json"),
    JSON.stringify({ version: "0.0.0-e2e", stable_version: null, checked_at: new Date().toISOString() })
  );
}

export interface AppContext {
  app: ElectronApplication;
  page: Page;
  /** The isolated dirs — assertions may inspect them (e.g. settings file). */
  paths: { grokHome: string; journalDir: string; userData: string; workspace: string };
}

export const test = base.extend<{ ctx: AppContext }>({
  ctx: async ({}, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gb-e2e-"));
    const paths = {
      grokHome: path.join(root, "grok-home"),
      journalDir: path.join(root, "journal"),
      userData: path.join(root, "user-data"),
      workspace: path.join(root, "workspace"),
    };
    for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });
    fs.mkdirSync(path.join(paths.grokHome, "sessions"), { recursive: true });
    writeMinimalCatalog(paths.grokHome);
    // Hermetic boot: no update check (it hangs the serve listener on a
    // blocked network); managed MCP servers with expired tokens are fatal —
    // disable them. disabled_mcp_servers is a TOP-LEVEL TOML key.
    fs.writeFileSync(
      path.join(paths.grokHome, "config.toml"),
      'disabled_mcp_servers = ["Notion"]\n\n[cli]\nauto_update = false\n'
    );

    const app = await _electron.launch({
      executablePath: resolvePackedApp(),
      args: ["."],
      cwd: paths.workspace,
      env: {
        ...process.env,
        GROK_HOME: paths.grokHome,
        GB_JOURNAL_DIR: paths.journalDir,
        GB_UAT_USER_DATA_DIR: paths.userData,
        // e2e never touches a real account (issue non-goal): boot past auth
        // via the app's documented dev escape hatch instead of seeding creds.
        GROK_DESKTOP_AUTH: "off",
        // Chromium honors these for the renderer — Playwright's own
        // locale/timezoneId settings do not reach _electron apps.
        LANG: "zh-CN.UTF-8",
        TZ: "Asia/Shanghai",
      },
      timeout: 90_000,
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    // first-run onboarding
    const skip = page.locator("button", { hasText: "跳过" });
    try {
      await skip.first().waitFor({ timeout: 4000 });
      await skip.first().click();
      await page.waitForTimeout(400);
    } catch { /* already completed */ }
    await page.waitForSelector("nav[aria-label='主导航']", { timeout: 20000 });

    await use({ app, page, paths });

    await app.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  },
});

export { expect };
