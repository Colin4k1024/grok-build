/**
 * Unified motion policy (R4-01 #234).
 *
 * Page-level motion may only animate `transform` and `opacity` — animating
 * layout properties (width/height/top/left) causes reflow and scroll jumps.
 * Reduced-motion users get instant, opacity-free-of-translation feedback:
 * spatial movement and scaling are removed, never replaced with longer fades.
 */

export const MOTION_DURATIONS = {
  /** Hover/focus color or opacity feedback. */
  fast: 140,
  /** Page entry: opacity + 6px translation. */
  base: 220,
  /** Deliberate panel/sheet entry. */
  slow: 320,
} as const;

export type MotionScale = keyof typeof MOTION_DURATIONS;

/** Single easing curve for the whole app (ease-out biased). */
export const MOTION_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/** Properties page-level motion is allowed to animate. */
export const MOTION_ALLOWED_PROPERTIES = ["transform", "opacity"] as const;
export type MotionProperty = (typeof MOTION_ALLOWED_PROPERTIES)[number];

export interface PageMotionSpec {
  durationMs: number;
  translateY: number;
  easing: string;
  properties: readonly MotionProperty[];
}

export interface PanelMotionSpec {
  durationMs: number;
  translateX: number;
  easing: string;
  properties: readonly MotionProperty[];
}

export interface PressMotionSpec {
  durationMs: number;
  scale: number;
  easing: string;
  properties: readonly MotionProperty[];
}

/** Page entry: 220ms ease-out, 6px rise. Reduced: instant, no translation. */
export function pageMotion(reduced: boolean): PageMotionSpec {
  return reduced
    ? { durationMs: 0, translateY: 0, easing: MOTION_EASING, properties: MOTION_ALLOWED_PROPERTIES }
    : {
        durationMs: MOTION_DURATIONS.base,
        translateY: 6,
        easing: MOTION_EASING,
        properties: MOTION_ALLOWED_PROPERTIES,
      };
}

/** Panel/sheet entry: deliberate slide. Reduced: instant, no translation. */
export function panelMotion(reduced: boolean): PanelMotionSpec {
  return reduced
    ? { durationMs: 0, translateX: 0, easing: MOTION_EASING, properties: MOTION_ALLOWED_PROPERTIES }
    : {
        durationMs: MOTION_DURATIONS.slow,
        translateX: 8,
        easing: MOTION_EASING,
        properties: MOTION_ALLOWED_PROPERTIES,
      };
}

/** Button/control press: scale to 0.98 for 120ms. Reduced: no scale. */
export function pressMotion(reduced: boolean): PressMotionSpec {
  return reduced
    ? { durationMs: 0, scale: 1, easing: MOTION_EASING, properties: MOTION_ALLOWED_PROPERTIES }
    : { durationMs: 120, scale: 0.98, easing: MOTION_EASING, properties: MOTION_ALLOWED_PROPERTIES };
}

/** Exit motion runs at ~65% of the entry duration. */
export function exitDuration(entryMs: number): number {
  return Math.round(entryMs * 0.65);
}

/**
 * Build a `transition` declaration restricted to transform/opacity.
 * Throws on layout-affecting properties so violations fail loudly in dev
 * instead of shipping a janky animation.
 */
export function transitionFor(
  properties: readonly MotionProperty[],
  durationMs: number,
  easing: string = MOTION_EASING,
): string {
  for (const p of properties) {
    if (!(MOTION_ALLOWED_PROPERTIES as readonly string[]).includes(p)) {
      throw new Error(
        `Motion policy: only ${MOTION_ALLOWED_PROPERTIES.join(" and ")} may be animated (got "${p}")`,
      );
    }
  }
  return properties.map((p) => `${p} ${durationMs}ms ${easing}`).join(", ");
}

/** Live reduced-motion preference; fails safe to `false` outside the DOM. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
