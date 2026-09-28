import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOTION_DURATIONS } from "../motion";

/**
 * Source-level contracts for the R4 token layer (R4-01 #234).
 * These pin the relationship between src/styles.css (definitions),
 * tailwind.config.js (references) and src/lib/motion.ts (JS policy),
 * so drift in any one of them fails loudly.
 *
 * Paths are relative to the project root (vitest's cwd).
 */

const stylesCss = readFileSync("src/styles.css", "utf-8");
const tailwindConfig = readFileSync("tailwind.config.js", "utf-8");

/** Tokens that MUST exist in both the dark (:root) and light themes. */
const THEME_PAIRED_TOKENS = [
  // surfaces
  "--gb-canvas",
  "--gb-sidebar",
  "--gb-surface-1",
  "--gb-surface-2",
  "--gb-surface-hover",
  // text
  "--gb-text-primary",
  "--gb-text-secondary",
  "--gb-text-muted",
  "--gb-text-disabled",
  // accent + status (base hue and AA-safe text variant)
  "--gb-accent",
  "--gb-accent-fg",
  "--gb-accent-text",
  "--gb-accent-hover",
  "--gb-focus",
  "--gb-control-track",
  "--gb-success",
  "--gb-success-text",
  "--gb-warning",
  "--gb-warning-text",
  "--gb-danger",
  "--gb-danger-text",
  "--gb-info",
  "--gb-info-text",
  // borders
  "--gb-border-hairline",
  "--gb-border-control",
  "--gb-border-emphasized",
  // elevation
  "--gb-elevation-low",
  "--gb-elevation-medium",
  "--gb-elevation-modal",
];

/** Legacy names that must remain as aliases pointing at semantic tokens. */
const LEGACY_ALIASES = [
  "--gb-bg",
  "--gb-bg-secondary",
  "--gb-surface",
  "--gb-surface-solid",
  "--gb-border",
  "--gb-text",
  "--gb-muted",
  "--gb-brand",
  "--gb-green",
  "--gb-yellow",
  "--gb-red",
  "--gb-activitybar",
  "--gb-activitybar-fg",
  "--gb-statusbar",
  "--gb-tab-inactive",
];

/** Return the concatenated bodies of every flat `selector { … }` block
 *  whose selector starts a line (avoids matching ':root, .light {' when
 *  looking for '.light', or the indented ':root' inside the media query). */
function blocks(css: string, selector: string): string {
  const out: string[] = [];
  let from = 0;
  const open = "\n" + selector + " {";
  for (;;) {
    const start = css.indexOf(open, from);
    if (start === -1) break;
    const bodyStart = start + open.length;
    const end = css.indexOf("}", bodyStart); // token blocks are flat
    if (end === -1) break;
    out.push(css.slice(bodyStart, end));
    from = end + 1;
  }
  return out.join("\n");
}

/** All `--gb-*` names defined anywhere in the stylesheet. */
function definedTokens(css: string): Set<string> {
  const names = new Set<string>();
  for (const m of css.matchAll(/(--gb-[\w-]+)\s*:/g)) names.add(m[1]);
  return names;
}

const rootDefs = blocks(stylesCss, ":root");
const lightDefs = blocks(stylesCss, ".light");
const aliasDefs = blocks(stylesCss, ":root, .light");
const defined = definedTokens(stylesCss);

describe("semantic design tokens", () => {
  it.each(THEME_PAIRED_TOKENS)("%s is defined in both dark and light themes", (token) => {
    expect(rootDefs, `${token} missing from :root`).toContain(token + ":");
    expect(lightDefs, `${token} missing from .light`).toContain(token + ":");
  });

  it("defines every CSS variable referenced by tailwind.config.js", () => {
    const referenced = new Set<string>();
    for (const m of tailwindConfig.matchAll(/var\((--gb-[\w-]+)\)/g)) referenced.add(m[1]);
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(defined.has(name), `${name} used by tailwind but never defined in styles.css`).toBe(true);
    }
  });

  it("keeps legacy aliases under a combined ':root, .light' rule so nested theme roots re-resolve", () => {
    expect(aliasDefs.length).toBeGreaterThan(0);
    for (const alias of LEGACY_ALIASES) {
      expect(aliasDefs, `${alias} must alias a semantic token under ':root, .light'`).toContain(
        alias + ": var(--gb-",
      );
    }
  });

  it("has no hardcoded accent companion colors left in mention/highlight rules", () => {
    expect(stylesCss).not.toContain("rgba(34, 211, 238");
    expect(stylesCss).not.toContain("rgba(52, 211, 153");
  });
});

describe("motion tokens", () => {
  it("CSS durations mirror src/lib/motion.ts", () => {
    const pairs: Array<[string, number]> = [
      ["--gb-motion-fast", MOTION_DURATIONS.fast],
      ["--gb-motion-normal", MOTION_DURATIONS.base],
      ["--gb-motion-deliberate", MOTION_DURATIONS.slow],
      ["--gb-motion-press", MOTION_DURATIONS.press],
    ];
    for (const [cssVar, jsValue] of pairs) {
      expect(stylesCss, `${cssVar} must equal MOTION_DURATIONS`).toContain(`${cssVar}: ${jsValue}ms`);
    }
  });

  it("the reduced-motion block zeroes every motion duration token", () => {
    const reduced = stylesCss.slice(stylesCss.indexOf("prefers-reduced-motion"));
    for (const cssVar of [
      "--gb-motion-fast",
      "--gb-motion-normal",
      "--gb-motion-deliberate",
      "--gb-motion-press",
    ]) {
      expect(reduced).toContain(`${cssVar}: 0ms`);
    }
    expect(reduced).toContain("animation-duration: 0.01ms !important");
    expect(reduced).toContain("transition-duration: 0.01ms !important");
  });

  it("motion utility classes consume the duration tokens", () => {
    expect(stylesCss).toContain("gb-page-enter var(--gb-motion-normal)");
    expect(stylesCss).toContain("gb-panel-enter var(--gb-motion-deliberate)");
    expect(stylesCss).toContain("transform var(--gb-motion-press)");
  });
});
