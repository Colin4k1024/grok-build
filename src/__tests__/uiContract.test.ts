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

/** String-aware comment stripper. Removes `// …` and `/* … *\/` regions in
 *  CODE positions only; the contents of string and template literals are
 *  always preserved (a URL like "https://…/⚠️" inside a string must neither
 *  be cut short nor hide an emoji from the scan). Template `${…}` contents
 *  are treated as literal contents too — rendered text there must stay
 *  visible to the contract. Regex literals cannot contain two adjacent raw
 *  slashes (each `/` must be escaped), so `//` in code position is always a
 *  comment. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "single" | "double" | "template" | "line" | "block" = "code";
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      out += c;
      i += 1;
      if (c === quote) state = "code";
      continue;
    }
    // code state
    if (c === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (c === "'") state = "single";
    else if (c === '"') state = "double";
    else if (c === "`") state = "template";
    out += c;
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

describe("stripComments — the scanner's lexical rules", () => {
  it("strips line and block comments in code positions", () => {
    const src = "const a = 1; // ⚡ comment\n/* 🌿 block */ const b = 2;";
    const out = stripComments(src);
    expect(out).not.toContain("⚡");
    expect(out).not.toContain("🌿");
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
  });

  it("never treats // inside a string as a comment — URL tails stay visible", () => {
    const src = 'const u = "https://example.com/⚠️"; // real comment ✨';
    const out = stripComments(src);
    // the URL (including an emoji in the string) survives…
    expect(out).toContain("https://example.com/⚠️");
    // …and only the genuine comment is removed
    expect(out).not.toContain("✨");
  });

  it("keeps template-literal contents scannable", () => {
    const src = "const s = `icon: ${name} ⏳`; // 🌐";
    const out = stripComments(src);
    expect(out).toContain("⏳");
    expect(out).not.toContain("🌐");
  });

  it("handles escaped quotes without losing track of string state", () => {
    const src = 'const q = "a\\"b"; // ⏰\nconst r = 1;';
    const out = stripComments(src);
    expect(out).toContain('const r = 1;');
    expect(out).not.toContain("⏰");
  });
});
