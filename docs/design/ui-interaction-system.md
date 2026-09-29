# UI Interaction System (R4)

> The single reference for the R4 design system — tokens, motion, components,
> configuration scopes, and accessibility rules. Introduced by the R4 epic
> (#233); every new surface must conform.

## Design tokens

Source of truth: `src/styles.css` (CSS custom properties) + `tailwind.config.js`
(Tailwind mapping). Contract-pinned by `src/lib/__tests__/designTokens.test.ts`
and `src/lib/__tests__/contrast.test.ts` (computed WCAG luminance, both themes).

### Surfaces
`--gb-canvas` (app background) · `--gb-sidebar` (rail + contextual sidebar) ·
`--gb-surface-1` (panels) · `--gb-surface-2` (cards/popovers) ·
`--gb-surface-hover`. Flat, layered graphite — no gradients, no glass.

### Text
`--gb-text-primary` / `--gb-text-secondary` / `--gb-text-muted` /
`--gb-text-disabled`. Type steps: `--gb-font-xs|sm|md|lg` (12/13/15/20px).

### Accent + status
`--gb-accent` (indigo — reserved for focus/selection/progress/primary) ·
`--gb-accent-fg` (text on accent fills) · `--gb-accent-text` (AA-safe text on
tints) · `--gb-accent-hover` · `--gb-focus` (the focus ring color, ≥3:1 on all
surfaces) · `--gb-success/-warning/-danger/-info` + `-text` variants.

**Rules:**
- Text on a tinted badge uses the `-text` variant, never the base hue.
- Status is never color alone — every status gets an icon or text label.
- Accent is not a text color; use `--gb-accent-text`.

### Borders
Three tiers via utility classes only (they encode the per-theme alpha):
`.gb-border-hairline` / `.gb-border-control` / `.gb-border-emphasized`.
Hover tier for interactive fields: `.gb-hover-border-control`. Error:
`.gb-border-danger` (double-class specificity — wins in every theme/state).
Never `border-gb-border` bare (solid white in dark).

### Elevation
`--gb-elevation-low` / `-medium` / `-modal` → `shadow-gb-low|medium|modal`.

### z-index
Named scale only: `z-gb-viewer(100) < z-gb-modal(110) < z-gb-dropdown/popover(120)
< z-gb-toast(130)`. Arbitrary `z-[…]` in shared primitives fails the
tokenCompliance contract test.

## Motion

Source of truth: `src/lib/motion.ts` + the `--gb-motion-*` tokens.
Contract-pinned (durations mirror each other; the reduced-motion block zeroes
all of them).

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

Shared primitives live in `src/components/ui/` (Button, IconButton, Input,
SearchField, Switch, Select, SegmentedControl, Dialog, Sheet, DropdownMenu,
Tooltip, Toast, InlineNotice, EmptyState, Skeleton, Card, Panel). Pages must
consume them instead of inventing one-off patterns; tokenCompliance.test.ts
enforces (no hex/rgba/bare-border/z-literal in primitives).

- Buttons: `primary|secondary|ghost|danger`, loading = disabled + aria-busy.
- Dialog/Sheet: focus trap, Escape closes, focus restored to the trigger.
- DropdownMenu: portaled, arrow/Home/End navigation skipping disabled,
  Escape closes only the menu (topmost-layer rule), tracks scroll/resize.
- Toast: one polite + one assertive live region (never nested); success
  auto-dismisses (10s with an action, else 4s); error/progress are sticky.
- Tooltip: hover with delay, instant on focus, Escape hides, never carries
  actions, no double announcement when it duplicates the child's label.

## Configuration

Typed registry (`src/config/`): schema → registry → resolver → storeBridge.
Every setting declares id/category/type/default/scopes/keywords/sensitivity/
saveMode/validator. Resolution: session > project > global > default, with
`invalidSources` reporting. Scopes must never overpromise — a setting is
project-scoped only when a consumer actually resolves it per project
(today: `appearance.theme`, `permissions.sandboxMode`).

- Sensitive settings (credentials, absolute-path lists) never export.
- Persisted state carries a schema version; `migrations.ts` is an ordered
  pipeline with backup-on-failure; `sanitize.ts` guards every rehydrate.
- Import is atomic (validate → preview → apply with rollback on failure).
- The durable file (`userData/gb-settings.json`) is canonical; localStorage
  is the sync cache; legacy keys migrate one-shot (honor then delete).

## Accessibility

- Every interactive element has a visible focus indicator (global
  `:focus-visible` ring + `.gb-focusable-surface` for composite hosts).
- Icon-only controls carry an accessible label (enforced by tests).
- Keyboard-only operation of dialogs, menus, forms is contract-tested.
- Landmarks: rail nav / main workspace / named inspector + settings nav.
- Focus follows destination changes; a skip link targets the workspace.
- `prefers-reduced-motion` is honored globally.
- Contrast is computed and contract-tested (both themes, AA).
- No emoji as interface icons (SVG only).
