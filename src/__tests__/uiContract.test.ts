// @vitest-environment node
/**
 * App-wide UI contract (R5-03 / #259).
 *
 * R4 enforced the no-emoji rule on ActivityBar only; this suite extends the
 * contract to EVERY shared component under src/components:
 *
 *   1. No emoji as interface icons. Emoji-presentation characters (the
 *      pictograph ranges, variation selector-16, the misc-symbols block, and
 *      a named BMP set of known offenders) are banned outside an explicit
 *      allowlist of user-content features (the emoji picker and message
 *      reactions — emoji there ARE the content, not chrome).
 *   2. No arbitrary z-index. Only the Tailwind scale steps already in use
 *      (0/10/20/30/40/50) are allowed; arbitrary z-[…] values are banned.
 *   3. No raw hex colors in components. Rendered colors come from the gb-*
 *      token system; fixed palette DATA (e.g. the xterm theme) lives in
 *      src/lib, never in components.
 *
 * Scanning rules: sources are comment-stripped first (block comments in
 * full; `//` starts a line comment unless preceded by `:` so URL schemes in
 * string literals survive), and src/components/**\/__tests__ fixtures are
 * out of scope. The scan reports every violation across the tree in one
 * assertion message so reintroduced regressions are easy to locate.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const COMPONENTS_ROOT = path.resolve(__dirname, "../components");

/** The only files whose emoji are user content, not interface icons. */
const EMOJI_ALLOWLIST = new Set([
  "chat/EmojiPicker.tsx",
  "chat/MessageReactions.tsx",
]);

/** Emoji-presentation characters: pictograph blocks, regional indicators,
 *  variation selector-16, and the entire miscellaneous-symbols block
 *  (☀⚡⚠⚙… live there). BMP dingbat-range icons we replaced are named
 *  individually below so ✓/✗ text glyphs may keep their text role. */
const EMOJI_RANGE_RE =
  /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{26FF}\u{FE0F}]/u;
const NAMED_BMP_EMOJI = ["⏳", "⏰", "✨", "🌐", "🖥️"];

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;
const ARBITRARY_Z_RE = /\bz-\[/;
const Z_VALUE_RE = /(?:^|[\s"'`])z-(\d+)\b/g;
const ALLOWED_Z = new Set(["0", "10", "20", "30", "40", "50"]);

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

/** Remove block comments entirely; remove `// …` line comments unless the
 *  slashes follow a `:` (URL schemes inside strings stay intact). */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < source.length) {
    if (inBlock) {
      const end = source.indexOf("*/", i);
      if (end === -1) return out;
      i = end + 2;
      inBlock = false;
      continue;
    }
    if (source.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    if (source.startsWith("//", i) && (i === 0 || source[i - 1] !== ":")) {
      const end = source.indexOf("\n", i);
      if (end === -1) return out;
      i = end;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function relative(file: string): string {
  return path.relative(COMPONENTS_ROOT, file).split(path.sep).join("/");
}

describe("UI contract — emoji, z-index, color tokens (R5-03 #259)", () => {
  const files = [...walk(COMPONENTS_ROOT)];

  it("scans the whole component tree (sanity: >40 files)", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("no emoji as interface icons in any shared component", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (EMOJI_ALLOWLIST.has(relative(file))) continue;
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      const lines = src.split("\n");
      lines.forEach((line, idx) => {
        const rangeHit = line.match(EMOJI_RANGE_RE);
        if (rangeHit) {
          violations.push(`${relative(file)}:${idx + 1} emoji ${rangeHit[0]}`);
          return;
        }
        for (const glyph of NAMED_BMP_EMOJI) {
          if (line.includes(glyph)) {
            violations.push(`${relative(file)}:${idx + 1} emoji ${glyph}`);
            return;
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("z-index stays on the sanctioned Tailwind scale — no arbitrary values", () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      const lines = src.split("\n");
      lines.forEach((line, idx) => {
        if (ARBITRARY_Z_RE.test(line)) {
          violations.push(`${relative(file)}:${idx + 1} arbitrary z-index`);
          return;
        }
        for (const m of line.matchAll(Z_VALUE_RE)) {
          if (!ALLOWED_Z.has(m[1])) {
            violations.push(`${relative(file)}:${idx + 1} z-${m[1]} off-scale`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("no raw hex colors in components — rendered colors come from tokens", () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = stripComments(fs.readFileSync(file, "utf-8"));
      src.split("\n").forEach((line, idx) => {
        if (HEX_COLOR_RE.test(line)) {
          violations.push(`${relative(file)}:${idx + 1} ${line.trim().slice(0, 80)}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it("the emoji allowlist stays minimal and points at real files", () => {
    for (const rel of EMOJI_ALLOWLIST) {
      expect(fs.existsSync(path.join(COMPONENTS_ROOT, rel))).toBe(true);
    }
    expect(EMOJI_ALLOWLIST.size).toBe(2);
  });
});
