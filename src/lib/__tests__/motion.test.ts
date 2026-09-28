import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOTION_DURATIONS,
  MOTION_EASING,
  exitDuration,
  pageMotion,
  panelMotion,
  prefersReducedMotion,
  pressMotion,
  subscribeReducedMotion,
  transitionFor,
} from "../motion";

describe("motion tokens", () => {
  it("exposes press/fast/base/slow duration scale", () => {
    expect(MOTION_DURATIONS.press).toBe(120);
    expect(MOTION_DURATIONS.fast).toBe(140);
    expect(MOTION_DURATIONS.base).toBe(220);
    expect(MOTION_DURATIONS.slow).toBe(320);
  });

  it("uses one standard easing for the app", () => {
    expect(MOTION_EASING).toMatch(/^cubic-bezier\(/);
  });
});

describe("pageMotion", () => {
  it("removes spatial motion for reduced-motion users", () => {
    const spec = pageMotion(true);
    expect(spec.durationMs).toBe(0);
    expect(spec.translateY).toBe(0);
  });

  it("uses the standard page transition otherwise", () => {
    const spec = pageMotion(false);
    expect(spec.durationMs).toBe(220);
    expect(spec.translateY).toBe(6);
  });

  it("only animates transform and opacity", () => {
    for (const spec of [pageMotion(false), pageMotion(true)]) {
      expect(spec.properties).toEqual(["transform", "opacity"]);
    }
  });
});

describe("panelMotion", () => {
  it("is interruptible and slower than page entry", () => {
    const spec = panelMotion(false);
    expect(spec.durationMs).toBe(MOTION_DURATIONS.slow);
    expect(spec.properties).toEqual(["transform", "opacity"]);
  });

  it("collapses to instant feedback under reduced motion", () => {
    const spec = panelMotion(true);
    expect(spec.durationMs).toBe(0);
    expect(spec.translateX).toBe(0);
  });
});

describe("pressMotion", () => {
  it("scales to 0.98 for 120ms", () => {
    const spec = pressMotion(false);
    expect(spec.durationMs).toBe(120);
    expect(spec.scale).toBe(0.98);
  });

  it("drops scaling under reduced motion", () => {
    const spec = pressMotion(true);
    expect(spec.durationMs).toBe(0);
    expect(spec.scale).toBe(1);
  });
});

describe("exitDuration", () => {
  it("is roughly 65 percent of the entry duration", () => {
    expect(exitDuration(220)).toBe(Math.round(220 * 0.65));
    expect(exitDuration(0)).toBe(0);
  });
});

describe("transitionFor", () => {
  it("builds a transition declaration from allowed properties only", () => {
    expect(transitionFor(["opacity", "transform"], 220)).toBe(
      `opacity 220ms ${MOTION_EASING}, transform 220ms ${MOTION_EASING}`,
    );
  });

  it("rejects layout-affecting properties", () => {
    expect(() => transitionFor(["width" as never], 220)).toThrow(/transform.*opacity/i);
    expect(() => transitionFor(["top" as never], 220)).toThrow();
  });
});

describe("prefersReducedMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reflects the media query when set", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(prefersReducedMotion()).toBe(true);
  });

  it("returns false when the media query does not match", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    expect(prefersReducedMotion()).toBe(false);
  });

  it("fails safe to false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("subscribeReducedMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockMql(initial: boolean) {
    const listeners = new Set<() => void>();
    const mql = {
      matches: initial,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    };
    vi.stubGlobal("matchMedia", () => mql);
    return {
      mql,
      fire(matches: boolean) {
        mql.matches = matches;
        for (const cb of [...listeners]) cb();
      },
      listenerCount: () => listeners.size,
    };
  }

  it("fires immediately with the current value and on changes", () => {
    const { fire } = mockMql(false);
    const seen: boolean[] = [];
    subscribeReducedMotion((v) => seen.push(v));
    expect(seen).toEqual([false]);
    fire(true);
    expect(seen).toEqual([false, true]);
  });

  it("unsubscribes cleanly", () => {
    const env = mockMql(true);
    const seen: boolean[] = [];
    const off = subscribeReducedMotion((v) => seen.push(v));
    expect(env.listenerCount()).toBe(1);
    off();
    expect(env.listenerCount()).toBe(0);
    env.fire(false);
    expect(seen).toEqual([true]);
  });

  it("is a no-op without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    const off = subscribeReducedMotion(() => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });
});
