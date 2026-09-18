/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "electron/**/*.test.ts"],
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
  },
}));
