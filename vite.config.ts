/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Core coverage: use v8 provider (lightweight, no Istanbul transforms).
    // The @vitest/coverage-v8 peer dep is bundled in vitest >= 2.0 through
    // npm ci with a locked package-lock; npm install adds it on first run.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/test/**",
        "src/**/__tests__/**",
        "src/**/*.test.{ts,tsx}",
      ],
      // Coverage gate (ISS-189): fail CI below these thresholds so "已完成"
      // is never claimed without a measurable evidence floor.
      thresholds: {
        statements: 40,
        branches: 30,
        functions: 35,
        lines: 40,
      },
    },
    // CI fixture: JUnit XML for evidence chain (no extra deps needed)
    reporters: process.env.CI ? ["verbose", "junit"] : ["verbose"],
    outputFile: process.env.CI ? "./test-results/junit.xml" : undefined,
    // CI runs are single-shot; local keep watching
    watch: !process.env.CI,
  },
  // Relative asset paths so the packaged Electron app can load from file://
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Bind IPv4 explicitly — wait-on and the Electron dev URL both target
    // 127.0.0.1; `host: false` lets Node bind ::1 only and they never meet.
    host: "127.0.0.1",
    watch: {
      // Packaging output and compiled main-process artifacts must not trigger
      // renderer page reloads (electron:pack while dev runs caused reload
      // storms via release/**).
      ignored: ["**/release/**", "**/dist-electron/**", "**/src-tauri/**", "**/target/**"],
    },
  },
}));
