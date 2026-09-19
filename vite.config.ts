/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts", "scripts/**/*.test.mjs"],
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
