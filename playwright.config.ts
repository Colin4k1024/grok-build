// Playwright config for the Electron E2E suite (R5-05 / #261).
//
// The suite drives the PACKED app (release/) via _electron — renderer-only
// automation (vite dev server) would not exercise the real main process.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: 0,
  workers: 1, // one Electron app at a time — they share the display
  reporter: [
    ["list"],
    ["html", { outputFolder: "e2e-results/report", open: "never" }],
    // JSON report consumed by scripts/assert-e2e-ran.mjs so a vacuous run
    // (0 tests / all skipped / Playwright never started) fails the CI job
    // instead of passing silently (R6-01 #279).
    ["json", { outputFile: "e2e-results/results.json" }],
  ],
  outputDir: "e2e-results/artifacts",
  // NOTE: locale/timezoneId in `use` do NOT reach an _electron-launched app;
  // the fixture passes them as Chromium env/args explicitly (see
  // e2e/fixtures/electron.ts).
  use: {
    screenshot: "only-on-failure",
  },
  expect: {
    toHaveScreenshot: {
      // Anti-flake: small pixel-ratio tolerance for font rasterization; the
      // CI image pins fonts/locale/timezone so the baseline is reproducible.
      maxDiffPixelRatio: 0.01,
    },
  },
});
