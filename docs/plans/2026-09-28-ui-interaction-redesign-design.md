# Grok Build UI Interaction Redesign

## Status

Approved on 2026-09-28.

## Product Direction

Grok Build will adopt a Codex x Linear visual language: restrained, high-density,
fast, and focused on professional developer workflows. The redesign covers the
entire application while preserving existing product capabilities, persisted user
data, and the current Electron/React architecture.

The redesign has four goals:

1. Make navigation predictable and remove duplicated destinations.
2. Give every interaction clear visual, loading, success, and error feedback.
3. Establish a reusable design system instead of page-specific styling.
4. Replace scattered preferences with a professional, scoped configuration model.

## Design Principles

- Use layered graphite surfaces rather than pure black or decorative gradients.
- Reserve the cool indigo accent for focus, selection, progress, and primary actions.
- Use semantic colors with text or icons so color is never the only signal.
- Keep dense developer information readable through consistent type and spacing.
- Animate only to explain causality, hierarchy, or state change.
- Preserve keyboard-first workflows and visible focus states.
- Support reduced motion, light mode, dark mode, and a high-contrast option.
- Use SVG icons consistently; do not use emoji as interface icons.

## Information Architecture

The application shell has four stable regions:

```text
Primary navigation rail -> contextual sidebar -> main workspace -> optional inspector
```

The primary rail owns top-level destinations: conversations, search, dashboard,
automations, plugins, and settings. The contextual sidebar contains only data for
the active destination, such as projects and threads for conversations. It must not
repeat top-level destinations.

The title bar exposes the current destination, project context, sync/runtime status,
and command palette entry. The optional inspector contains contextual artifacts,
files, tasks, usage, and agent details. Its visibility is persisted without changing
the state of the main workspace.

## Page Model

### Home Workspace

The home page becomes a workbench with a clear primary composer, project context,
active work, recent threads, and reusable launch presets. Recent content uses one
consistent list/card pattern and meaningful empty/loading states.

### Conversation Workspace

The conversation view emphasizes the current turn, streaming state, tool progress,
approval requests, and queued follow-ups. The composer always communicates its
project, model, reasoning effort, approval policy, work mode, and send state. Tool
calls use progressive disclosure and maintain stable layout while streaming.

### Dashboard

The dashboard becomes an actionable operational overview rather than a passive
collection of cards. It summarizes active sessions, queued work, automation health,
usage, and recent failures, and links directly to the relevant destination.

### Automations

Automations use a list/detail structure with visible schedule, next run, last result,
notification policy, and active/paused state. Creation and editing use a focused
panel with validation and unsaved-change protection.

### Plugins

Plugins use a searchable catalog with installed/available filters, capability and
permission summaries, explicit lifecycle feedback, and clear restart requirements.

### Settings

Settings use grouped navigation, search, basic/advanced disclosure, source badges,
and a consistent field layout. Low-risk appearance preferences save immediately.
Security, agent, MCP, browser, and integration changes remain staged until the user
applies them.

## Visual System

### Tokens

The existing `--gb-*` variables remain compatible but become semantic aliases for:

- canvas, sidebar, surface, elevated surface, hover surface
- primary, secondary, muted, and disabled text
- accent, focus ring, success, warning, danger, and information
- hairline, control, and emphasized borders
- small, medium, and large radii
- low, medium, and modal elevation
- fast, normal, and deliberate motion durations

Spacing follows a 4px base scale. Typography follows 12, 13, 15, and 20px interface
steps with readable line heights. Controls meet a 44px target where touch interaction
is plausible, while compact desktop rows retain a minimum 32px height and full
keyboard accessibility.

### Motion

- Page entry: opacity plus 6px translation, 220ms ease-out.
- Panel entry: interruptible transform-based spring-like transition.
- Hover and focus: 140-180ms color/opacity transition.
- Button press: scale to 0.98 for 120ms.
- Success and completion: brief state transition without layout movement.
- Exit motion: approximately 65 percent of entry duration.
- Streaming: animate only newly added content and live indicators.
- Reduced motion: remove translations and scaling, retain essential opacity feedback.

No animation may depend on width, height, top, or left transitions.

## Configuration Architecture

Configuration is described by a typed schema registry. Each setting declares its
identifier, category, value type, default, scope, validation, search keywords,
sensitivity, restart requirement, and save behavior.

Supported scopes are:

1. Product default.
2. Global user value.
3. Project override.
4. Current-session override where applicable.

Resolution follows the most specific valid value. The UI shows the resolved value
and its source, and allows the current scope to be reset without deleting broader
preferences.

The persisted store gains a version and migration pipeline. Existing `gb-settings`
values are migrated in place. Sensitive credentials remain in the existing secure
main-process path and are never included in exported preference files.

Professional configuration features include:

- Basic and advanced views.
- Search across labels, descriptions, and aliases.
- Safe, balanced, and high-autonomy presets.
- Global and project-level configuration.
- Per-setting and per-section reset.
- Import/export with version validation and a preview diff.
- Dirty-state tracking and unsaved-change protection.
- Inline validation and field-level error messages.
- Immediate save for low-risk appearance changes.
- Explicit apply flow for permissions and integration changes.
- Success, failure, restart-required, and externally-managed states.

## Component Architecture

Reusable primitives will be introduced before page changes: Button, IconButton,
Input, SearchField, Select, SegmentedControl, Switch, Badge, Tooltip, Card,
EmptyState, Skeleton, Toast, Dialog, Sheet, SettingsField, SettingsSection, and
PageTransition. These components own focus, disabled, loading, error, and reduced
motion behavior.

Pages consume semantic primitives and configuration metadata. They must not create
new one-off toggle, card, input, or notification patterns.

## Data Flow and State

- Zustand remains the renderer state mechanism.
- A versioned configuration store resolves default/global/project/session values.
- Main-process APIs remain authoritative for secure or side-effecting settings.
- Staged forms keep draft state separate from persisted state.
- Applying a staged form validates the draft, invokes the main-process boundary,
  persists only on success, and reports field or global errors without losing input.
- Navigation state and panel visibility persist independently from configuration.

## Error Handling

- Errors appear next to the action or field that caused them.
- Global failures use a dismissible toast with an optional retry action.
- Loading longer than 300ms uses a skeleton or progress state.
- Destructive changes require confirmation and offer undo where practical.
- Failed settings imports never partially mutate persisted configuration.
- Leaving a staged settings view with changes prompts the user to discard or stay.

## Accessibility

- All icon-only controls have accessible labels and tooltips.
- Focus order matches visual order and focus rings remain visible.
- Navigation and settings work without a pointer.
- Text/background pairs target WCAG AA contrast.
- Status never relies on color alone.
- `prefers-reduced-motion` is honored globally.
- Semantic headings, navigation landmarks, dialogs, and live regions are used.

## Verification Strategy

- Unit tests cover token helpers, configuration schema validation, scope resolution,
  presets, import/export, and every persisted-state migration.
- Component tests cover keyboard interaction, dirty state, validation, loading,
  errors, and reduced motion.
- Integration tests cover global/project overrides and renderer/main-process saves.
- Existing session, automation, plugin, permission, and packaging tests remain green.
- Production renderer and Electron builds are required before completion.
- Manual visual checks cover dark, light, high contrast, narrow window, empty states,
  long content, and active streaming.

## Delivery Sequence

1. Design tokens, motion preferences, and reusable primitives.
2. Application shell, navigation, home, conversation, and composer.
3. Versioned configuration schema, scope resolution, presets, and migration.
4. Settings center and configuration lifecycle UX.
5. Dashboard, automations, plugins, agents, and remaining surfaces.
6. Accessibility, responsive behavior, visual consistency, and final regression pass.

Each stage must remain buildable and testable. Existing data formats are preserved
or migrated explicitly; no stage requires a flag-day rewrite.
