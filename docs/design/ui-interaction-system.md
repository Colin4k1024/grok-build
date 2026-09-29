# UI Interaction System (R4)

> The single reference for the R4 design system — tokens, motion, components,
> configuration scopes, and accessibility rules. Introduced by the R4 epic
> (#233); every new surface must conform.
>
> **Enforcement scope.** The token/no-emoji/focus-ring rules below are
> machine-enforced inside `src/components/ui/` by
> `src/components/ui/__tests__/tokenCompliance.test.ts`. Outside the shared
> primitives, legacy call sites not yet migrated may still violate them
> (a handful of gradient/glass utilities and a larger set of bare
> `border-gb-border` usages remain) — treat the rules as mandatory for new
> code and migrate legacy call sites on touch.

## Design tokens

Source of truth: `src/styles.css` (CSS custom properties) + `tailwind.config.js`
(Tailwind mapping). Contract-pinned by `src/lib/__tests__/designTokens.test.ts`
(CSS↔tailwind↔motion.ts mirror, including reduced-motion zeroing) and
`src/lib/__tests__/contrast.test.ts` (computed WCAG luminance, both themes).

### Surfaces
`--gb-canvas` (app background) · `--gb-sidebar` (rail + contextual sidebar) ·
`--gb-surface-1` (panels) · `--gb-surface-2` (cards/popovers) ·
`--gb-surface-hover`. Flat, layered graphite — new surfaces use no gradients
and no glass effects.

### Text
`--gb-text-primary` / `--gb-text-secondary` / `--gb-text-muted` /
`--gb-text-disabled`. Type steps: `--gb-font-xs|sm|md|lg` (12/13/15/20px).

### Accent + status
`--gb-accent` (indigo — reserved for focus/selection/progress/primary) ·
`--gb-accent-fg` (text on accent fills) · `--gb-accent-text` (AA-safe text on
tints) · `--gb-accent-hover` · `--gb-focus` (focus ring color; its ≥3:1
contrast is contract-pinned on the canvas surface, other surfaces are covered
by the manual matrix) · `--gb-success/-warning/-danger/-info` + `-text`
variants.

**Rules:**
- Text on a tinted badge uses the `-text` variant, never the base hue.
- Status is never color alone — every status gets an icon or text label.
- Accent is not a text color; use `--gb-accent-text`.

### Borders
Three tiers via utility classes only (they encode the per-theme alpha):
`.gb-border-hairline` / `.gb-border-control` / `.gb-border-emphasized`.
Hover tier for interactive fields: `.gb-hover-border-control`. Error:
`.gb-border-danger` (double-class specificity — wins in every theme/state).
In shared primitives, never `border-gb-border` bare (solid white in dark);
legacy pages still contain bare usages pending migration (see scope note).

### Elevation
`--gb-elevation-low` / `-medium` / `-modal` → `shadow-gb-low|medium|modal`.

### z-index
Named scale only: `z-gb-viewer(100) < z-gb-modal(110) < z-gb-dropdown/popover(120)
< z-gb-toast(130)`. Arbitrary `z-[…]` in shared primitives fails the
tokenCompliance contract test.

### Approved / forbidden patterns

```tsx
// ✅ border tier via utility class, hover tier for interactive fields
<div className="gb-border-control gb-hover-border-control rounded-gb-md" />

// ✅ status text on a tinted badge
<span className="bg-gb-success/15 text-gb-success-text">已完成</span>

// ✅ overlay stacking via the named scale
<div className="z-gb-dropdown" />

// ✅ page-level motion: transform/opacity only, reduced-motion aware
<motion.div {...pageMotion(prefersReducedMotion())} />

// ❌ raw alpha border inside shared primitives (solid white in dark)
<div className="border border-gb-border" />

// ❌ status conveyed by base hue text on a tint (fails AA)
<span className="bg-gb-success/15 text-gb-success">已完成</span>

// ❌ layout-animating transition (throws in dev via transitionFor)
<div style={{ transition: "width 220ms" }} />

// ❌ arbitrary z-index literal inside src/components/ui/
<div className="z-[999]" />
```

## Motion

Source of truth: `src/lib/motion.ts` + the `--gb-motion-*` tokens.
`src/lib/__tests__/designTokens.test.ts` pins the CSS↔JS mirror (durations
match `MOTION_DURATIONS`; the reduced-motion block zeroes all of them);
`src/lib/__tests__/motion.test.ts` pins the JS API behavior below.

- Durations: press 120 / fast 140 / base 220 / deliberate 320 ms.
- Easing: one curve `cubic-bezier(0.2, 0, 0, 1)`.
- Page-level motion animates ONLY `transform` and `opacity` —
  `transitionFor()` throws in dev/test on layout properties (width/top/…),
  drops with a warning in production.
- Exit motion ≈ 65% of entry (`exitDuration`).
- `prefers-reduced-motion`: token durations zero + all keyframe animation
  collapses to instant. `prefersReducedMotion()` / `subscribeReducedMotion()`
  for JS decisions.

## Components

Shared primitives live in `src/components/ui/`, by module:

- `Button.tsx` — Button, IconButton (`primary|secondary|ghost|danger`;
  loading = disabled + aria-busy).
- `Input.tsx` — Input, SearchField.
- `FormControls.tsx` — Switch, Select, SegmentedControl (roving tabindex,
  arrow/Home/End skip disabled options).
- `Dialog.tsx` — Dialog, Sheet: focus trap, Escape closes, focus restored
  to the trigger.
- `DropdownMenu.tsx` — portaled; arrow/Home/End navigation skipping
  disabled; Escape closes only the menu (topmost-layer rule); tracks
  scroll/resize.
- `Tooltip.tsx` — hover with delay, instant on focus, Escape hides, never
  carries actions, no double announcement when it duplicates the child's
  label.
- `Toast.tsx` — `toast()` API + `ToastViewport`: one polite + one assertive
  live region (never nested); success auto-dismisses (10s with an action,
  else 4s); error/progress are sticky.
- `Feedback.tsx` — InlineNotice, EmptyState, Skeleton.
- `Surface.tsx` — Card, Panel.
- `AsyncState.tsx` — AsyncState (loading/error/empty wrapper).
- `Detail.tsx` — CollapsibleSection, CopyButton and detail-view helpers.

Pages must consume these instead of inventing one-off patterns;
tokenCompliance.test.ts enforces the token rules inside this directory.

## Configuration

Typed registry (`src/config/`): schema → registry → resolver → storeBridge.
Every `SettingDefinition` declares `id` / `category` / `type` /
`defaultValue` / `scopes` / `keywords` / `sensitive` / `saveMode` /
`validate` (see `src/config/types.ts`). Resolution: session > project >
global > default, with `invalidSources` reporting. Scopes must never
overpromise — a setting is project-scoped only when a consumer actually
resolves it per project (today: `appearance.theme`,
`permissions.sandboxMode`).

- Sensitive settings (`sensitive: true`) never export.
- Persisted state carries a schema version; `migrations.ts` is an ordered
  pipeline with backup-on-failure; `sanitize.ts` guards every rehydrate.
- Import is atomic (validate → preview → apply with rollback on failure).
- The durable file (`userData/gb-settings.json`) is canonical; localStorage
  is the sync cache; legacy keys migrate one-shot (honor then delete).

## Accessibility

- Every interactive element has a visible focus indicator (global
  `:focus-visible` ring + `.gb-focusable-surface` for composite hosts).
- Icon-only controls carry an accessible label and interface icons are SVG,
  never emoji — both machine-enforced today at the rail/app-shell level by
  `accessibilityInteractions.test.tsx`, and required by review everywhere
  else.
- Keyboard-only operation of dialogs, menus, forms is contract-tested.
- Landmarks: rail nav / main workspace / named inspector + settings nav.
- Focus follows destination changes; a skip link targets the workspace.
- `prefers-reduced-motion` is honored globally.
- Contrast is computed and contract-tested (both themes, AA).
