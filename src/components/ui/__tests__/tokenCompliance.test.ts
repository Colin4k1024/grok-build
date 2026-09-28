import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-level compliance contracts for the shared primitives (R4-02 #235),
 * mirroring the R4-01 token contract tests: shared components must consume
 * the token layer, never hardcode presentation values.
 */

const UI_DIR = "src/components/ui";

const sources = readdirSync(UI_DIR)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => [f, readFileSync(`${UI_DIR}/${f}`, "utf-8")] as const);

describe("ui primitives token compliance", () => {
  it("no hardcoded hex colors", () => {
    // Requires 6+ digits or at least one a-f letter so issue refs like
    // "#235" in comments don't false-positive.
    const hexColor = /#[0-9a-fA-F]{6,8}\b|#[0-9a-fA-F]*[a-fA-F][0-9a-fA-F]{2,7}\b/;
    for (const [file, src] of sources) {
      expect(src, `${file} hardcodes a hex color`).not.toMatch(hexColor);
    }
  });

  it("no raw rgba()/hsla() literals", () => {
    for (const [file, src] of sources) {
      expect(src, `${file} hardcodes an rgba() literal`).not.toMatch(/\b[rh]sla?\(\d/);
    }
  });

  it("no bare border-gb-border* classes (tiers are .gb-border-* utilities)", () => {
    for (const [file, src] of sources) {
      expect(src, `${file} uses a bare border-gb-border class`).not.toMatch(/border-gb-border/);
    }
  });

  it("no arbitrary z-index values (the named z-gb-* scale is the contract)", () => {
    for (const [file, src] of sources) {
      expect(src, `${file} hardcodes z-[…]`).not.toMatch(/\bz-\[/);
    }
  });

  it("motion comes from the token layer classes or motion.ts helpers", () => {
    for (const [file, src] of sources) {
      expect(src, `${file} hardcodes a transition duration`).not.toMatch(/duration-\[\d+ms\]/);
      expect(src, `${file} hardcodes an animation duration`).not.toMatch(/\b\d+ms\b/);
    }
  });
});
