import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast assertions over the token table (R4-10 #243): the palette's
 * contrast claims are computed, never hand-asserted in comments. Both themes.
 *
 * Tokens are "R G B" triplets in styles.css; tints are computed as
 * alpha-over-surface blends, matching how the utilities compose them.
 */

const css = readFileSync("src/styles.css", "utf-8");

function tokenValue(name: string, theme: "dark" | "light"): [number, number, number] {
  const block =
    theme === "dark"
      ? css.slice(css.indexOf("\n:root {"), css.indexOf("\n.light {"))
      : css.slice(css.indexOf("\n.light {"), css.indexOf("\n:root, .light {"));
  const m = block.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`));
  if (!m) throw new Error(`token ${name} not found in ${theme} theme`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** WCAG relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Alpha-over-background composite. */
function blend(fg: [number, number, number], bg: [number, number, number], alpha: number): [number, number, number] {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3.0;

describe("WCAG contrast (R4-10 #243)", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`${theme}: accent-fg on accent fill is AA`, () => {
      expect(contrast(tokenValue("--gb-accent-fg", theme), tokenValue("--gb-accent", theme))).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it(`${theme}: accent-text on accent/15 tint over canvas is AA`, () => {
      const tint = blend(tokenValue("--gb-accent", theme), tokenValue("--gb-canvas", theme), 0.15);
      expect(contrast(tokenValue("--gb-accent-text", theme), tint)).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it(`${theme}: accent-text on accent/15 tint over surface-2 is AA`, () => {
      const tint = blend(tokenValue("--gb-accent", theme), tokenValue("--gb-surface-2", theme), 0.15);
      expect(contrast(tokenValue("--gb-accent-text", theme), tint)).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it(`${theme}: text-primary / text-secondary / text-muted on canvas are AA`, () => {
      const canvas = tokenValue("--gb-canvas", theme);
      expect(contrast(tokenValue("--gb-text-primary", theme), canvas)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(tokenValue("--gb-text-secondary", theme), canvas)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(tokenValue("--gb-text-muted", theme), canvas)).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it(`${theme}: focus ring meets the 3:1 non-text minimum on canvas`, () => {
      expect(contrast(tokenValue("--gb-focus", theme), tokenValue("--gb-canvas", theme))).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });
    it(`${theme}: danger-text on danger/15 tint is AA`, () => {
      const tint = blend(tokenValue("--gb-danger", theme), tokenValue("--gb-surface-2", theme), 0.15);
      expect(contrast(tokenValue("--gb-danger-text", theme), tint)).toBeGreaterThanOrEqual(AA_TEXT);
    });
    it(`${theme}: success-text / warning-text / info-text on their /15 tints are AA`, () => {
      for (const name of ["--gb-success", "--gb-warning", "--gb-info"]) {
        const tint = blend(tokenValue(name, theme), tokenValue("--gb-surface-2", theme), 0.15);
        expect(contrast(tokenValue(`${name}-text`, theme), tint), name).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });
    it(`${theme}: switch control-track meets 3:1 on surface-2`, () => {
      expect(contrast(tokenValue("--gb-control-track", theme), tokenValue("--gb-surface-2", theme))).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });
  }
});
