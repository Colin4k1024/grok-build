/**
 * Embedded terminal palette (R5-03 / #259).
 *
 * The xterm surface is intentionally theme-invariant dark (#1c1c1c / #d6d6d6,
 * matching the Codex TUI look) in both light and dark app themes. Palette
 * DATA lives here in src/lib so component code stays free of raw hex colors
 * — the UI contract scan (src/__tests__/uiContract.test.ts) rejects hex
 * literals under src/components.
 *
 * The matching surface token for component chrome (placeholders, wrappers)
 * is `--gb-terminal-bg` / the `bg-gb-terminal` Tailwind color; keep the two
 * in sync with the values below.
 */
export const TERMINAL_THEME = {
  background: "#1c1c1c",
  foreground: "#d6d6d6",
  cursor: "#d6d6d6",
} as const;
