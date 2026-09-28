# UI Interaction Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign every Grok Build desktop surface with a consistent Codex x Linear interaction system and add a versioned professional configuration model with global/project scope, presets, validation, import/export, and migration.

**Architecture:** Keep the existing Electron, React, Tailwind, and Zustand architecture. Introduce semantic UI primitives and design tokens first, then refactor the shell and pages onto those primitives. Add a typed configuration registry and resolver beside the existing persisted settings store so migration is incremental and existing `gb-settings` data remains valid.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Zustand persist middleware, Vitest, Testing Library, Electron.

---

## Execution Rules

- Use `@superpowers:test-driven-development` for every behavior change.
- Use `@everything-claude-code:ui-ux-promax` for visual and interaction decisions.
- Use `@superpowers:verification-before-completion` before claiming any task or phase complete.
- Do not add an animation framework; implement motion with CSS transform/opacity and existing React state.
- Do not change secure credential storage or export secrets.
- Preserve the legacy localStorage keys while the new settings migration is active.
- Keep each task in its own commit and run its listed focused tests before committing.

### Task 1: Establish semantic tokens and motion preferences

**Files:**
- Modify: `src/styles.css`
- Modify: `tailwind.config.js`
- Create: `src/lib/motion.ts`
- Create: `src/lib/__tests__/motion.test.ts`

**Step 1: Write the failing motion preference tests**

Create `src/lib/__tests__/motion.test.ts` with tests proving that the helper returns
zero translation and duration when reduced motion is enabled, and the standard
220ms/6px page transition otherwise.

```ts
import { describe, expect, it } from "vitest";
import { pageMotion } from "../motion";

describe("pageMotion", () => {
  it("removes spatial motion for reduced-motion users", () => {
    expect(pageMotion(true)).toEqual({ durationMs: 0, translateY: 0 });
  });

  it("uses the standard page transition otherwise", () => {
    expect(pageMotion(false)).toEqual({ durationMs: 220, translateY: 6 });
  });
});
```

**Step 2: Run the test and verify RED**

Run: `npx vitest run src/lib/__tests__/motion.test.ts`

Expected: FAIL because `src/lib/motion.ts` does not exist.

**Step 3: Add the minimal motion helper**

Create `src/lib/motion.ts`:

```ts
export function pageMotion(reduced: boolean) {
  return reduced
    ? { durationMs: 0, translateY: 0 }
    : { durationMs: 220, translateY: 6 };
}
```

**Step 4: Replace raw color and motion constants with semantic tokens**

In `src/styles.css`, keep every existing `--gb-*` variable for compatibility and add
semantic variables for canvas, sidebar, surface levels, text levels, focus, semantic
status colors, radii, shadows, and durations. Add reusable classes for page entry,
panel entry, press feedback, focus rings, skeleton shimmer, and toast entry. Add a
`prefers-reduced-motion: reduce` block that disables translation/scaling and removes
non-essential animation.

Expose the new variables in `tailwind.config.js` as semantic colors, radii, shadows,
and transition durations. Do not delete old Tailwind names yet.

**Step 5: Verify GREEN and build**

Run:

```bash
npx vitest run src/lib/__tests__/motion.test.ts
npm run build
```

Expected: tests PASS and production renderer build succeeds.

**Step 6: Commit**

```bash
git add src/styles.css tailwind.config.js src/lib/motion.ts src/lib/__tests__/motion.test.ts
git commit -m "feat(ui): add semantic tokens and motion system"
```

### Task 2: Build accessible reusable UI primitives

**Files (as shipped by PR #246 — superset of the issue #235 list):**
- Create: `src/components/ui/Button.tsx` (Button + IconButton)
- Create: `src/components/ui/Input.tsx` (Input + SearchField)
- Create: `src/components/ui/FormControls.tsx` (Switch + Select + SegmentedControl)
- Create: `src/components/ui/Dialog.tsx` (Dialog + Sheet)
- Create: `src/components/ui/DropdownMenu.tsx`
- Create: `src/components/ui/Tooltip.tsx`
- Create: `src/components/ui/Toast.tsx` (toast API + ToastViewport)
- Create: `src/components/ui/Feedback.tsx` (InlineNotice + EmptyState + Skeleton)
- Create: `src/components/ui/Surface.tsx` (Card + Panel)
- Create: `src/components/ui/index.ts`
- Create: `src/components/ui/__tests__/primitives.test.tsx`
- Create: `src/components/ui/__tests__/tokenCompliance.test.ts`

**Step 1: Write failing primitive interaction tests**

Test these behaviors with Testing Library:

- loading Button is disabled and exposes a loading label;
- IconButton requires and renders an accessible label;
- Switch exposes `role="switch"` and updates `aria-checked`;
- SearchField has a visible or programmatic label;
- Dialog closes on Escape and restores focus;
- Toast uses the correct live-region role.

Use real DOM interaction rather than implementation mocks.

**Step 2: Run the tests and verify RED**

Run: `npx vitest run src/components/ui/__tests__/primitives.test.tsx`

Expected: FAIL because the primitive modules do not exist.

**Step 3: Implement the minimum primitives**

Implement:

- `Button`: primary, secondary, ghost, danger; small/medium sizes; loading state.
- `IconButton`: 32px desktop target, tooltip/title, required `aria-label`.
- `SearchField`, `Select`, `SegmentedControl`, and `Switch` in `FormControls.tsx`.
- `Toast`, `InlineNotice`, `Skeleton`, and `EmptyState` in `Feedback.tsx`.
- `Card`, `Panel`, `Dialog`, and `Sheet` in `Surface.tsx`.

Use semantic tokens only. Every interactive component must have visible focus,
disabled, hover, active, and loading behavior. Export through `index.ts`.

**Step 4: Verify GREEN and build**

Run:

```bash
npx vitest run src/components/ui/__tests__/primitives.test.tsx
npm run build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/ui
git commit -m "feat(ui): add accessible interface primitives"
```

### Task 3: Refactor the application shell and navigation model

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/layout/ActivityBar.tsx`
- Modify: `src/components/layout/Sidebar.tsx`
- Modify: `src/components/layout/TitleBar.tsx`
- Modify: `src/components/layout/StatusBar.tsx`
- Modify: `src/components/layout/EditorTabs.tsx`
- Create: `src/components/layout/AppShell.tsx`
- Create: `src/components/layout/__tests__/AppShell.test.tsx`

**Step 1: Write failing shell navigation tests**

Test that:

- each top-level destination appears exactly once in the primary rail;
- activating a destination updates `aria-current`;
- the contextual sidebar does not repeat settings, dashboard, automation, or plugin
  destinations;
- `Cmd+B` toggles only the contextual sidebar;
- the inspector can collapse without unmounting the main workspace;
- focus moves to the destination heading after navigation.

**Step 2: Run the tests and verify RED**

Run: `npx vitest run src/components/layout/__tests__/AppShell.test.tsx`

Expected: FAIL against the duplicated current navigation.

**Step 3: Implement `AppShell`**

Give `AppShell` explicit slots:

```ts
interface AppShellProps {
  destination: "conversations" | "search" | "dashboard" | "automations" | "plugins" | "settings";
  rail: React.ReactNode;
  sidebar?: React.ReactNode;
  titlebar: React.ReactNode;
  workspace: React.ReactNode;
  inspector?: React.ReactNode;
  statusbar?: React.ReactNode;
}
```

Keep the workspace mounted while sidebar/inspector visibility changes. Add semantic
landmarks and a skip-to-workspace link.

**Step 4: Migrate the layout components**

- Make `ActivityBar` the sole top-level navigation owner.
- Remove duplicate top-level links from `Sidebar`.
- Make `Sidebar` conversations-only and contextual.
- Make `TitleBar` show destination, project, runtime status, and command entry.
- Reduce `StatusBar` to model, branch/work mode, permission state, and connection.
- Restyle tabs with semantic primitives and full keyboard/focus behavior.
- Replace conditional full-page returns in `App.tsx` with one stable shell destination
  state so page transitions do not destroy unrelated panel state.

**Step 5: Verify GREEN and regression tests**

Run:

```bash
npx vitest run src/components/layout/__tests__/AppShell.test.tsx src/__tests__/perfRegressions.test.tsx
npm run build
```

Expected: PASS with no MessageList render-isolation regression.

**Step 6: Commit**

```bash
git add src/App.tsx src/components/layout
git commit -m "feat(ui): unify the desktop navigation shell"
```

### Task 4: Redesign home, conversation, and composer interactions

**Files:**
- Modify: `src/pages/Home.tsx`
- Modify: `src/components/chat/MessageList.tsx`
- Modify: `src/components/chat/MessageItem.tsx`
- Modify: `src/components/chat/ToolCallCard.tsx`
- Modify: `src/components/chat/PromptInput.tsx`
- Modify: `src/components/chat/composer/ModelEffortSelect.tsx`
- Modify: `src/components/chat/composer/ApprovalModeSelect.tsx`
- Modify: `src/components/chat/composer/WorkModeSelect.tsx`
- Modify: `src/components/chat/composer/BranchSelect.tsx`
- Create: `src/components/home/WorkOverview.tsx`
- Create: `src/components/chat/__tests__/ComposerInteraction.test.tsx`
- Create: `src/pages/__tests__/Home.test.tsx`

**Step 1: Write failing workflow tests**

Test that:

- Home exposes one primary composer and project selection;
- recent work distinguishes live sessions from resumable history without duplicate
  entries;
- composer exposes project, model, effort, approval, work mode, and branch state;
- sending, queued follow-up, cancellation, disabled, and recording states have
  accessible labels;
- tool calls retain stable layout while their content updates;
- reduced motion removes message translation without suppressing live status text.

**Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run src/pages/__tests__/Home.test.tsx src/components/chat/__tests__/ComposerInteraction.test.tsx
```

Expected: FAIL because the new overview and state labels are absent.

**Step 3: Implement the workbench home page**

Create `WorkOverview` for running sessions, queued work, recent failures, and saved
launch presets. Merge live and persisted recents with stable identifiers. Replace
emoji branding with the shared SVG icon system. Use skeletons for history loading,
an actionable empty state, and consistent relative-time formatting.

**Step 4: Implement the conversation interaction changes**

- Keep the virtualized message layout stable.
- Animate only newly inserted messages or tool-state changes.
- Present tool calls with summary, state, duration, and progressive detail.
- Turn composer controls into one compact metadata row with readable popovers.
- Add explicit `Sending`, `Queued`, `Listening`, `Cancelling`, and `Blocked` feedback.
- Preserve drafts, slash commands, mentions, voice input, image paste, and the current
  streaming render optimizations.

**Step 5: Verify GREEN and performance**

Run:

```bash
npx vitest run src/pages/__tests__/Home.test.tsx src/components/chat/__tests__/ComposerInteraction.test.tsx src/__tests__/perfRegressions.test.tsx src/lib/__tests__/composerDraft.test.ts
npm run build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/pages/Home.tsx src/pages/__tests__/Home.test.tsx src/components/home src/components/chat
git commit -m "feat(ui): redesign the core conversation workflow"
```

### Task 5: Add the typed configuration registry and scope resolver

**Files:**
- Create: `src/lib/settingsSchema.ts`
- Create: `src/lib/settingsResolver.ts`
- Create: `src/lib/__tests__/settingsSchema.test.ts`
- Create: `src/lib/__tests__/settingsResolver.test.ts`

**Step 1: Write failing schema and resolution tests**

Cover:

- every registered setting has a unique id, default, category, scope, and validator;
- invalid defaults fail registry validation;
- resolution order is session -> project -> global -> default;
- an invalid override is ignored and reported;
- resetting a project value reveals the global value;
- sensitive settings are marked non-exportable.

Use this public shape in the tests:

```ts
export type SettingScope = "global" | "project" | "session";

export interface SettingDefinition<T> {
  id: string;
  category: string;
  label: string;
  description: string;
  defaultValue: T;
  scopes: SettingScope[];
  keywords: string[];
  advanced?: boolean;
  sensitive?: boolean;
  requiresRestart?: boolean;
  saveMode: "immediate" | "staged";
  validate: (value: unknown) => value is T;
}
```

**Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run src/lib/__tests__/settingsSchema.test.ts src/lib/__tests__/settingsResolver.test.ts
```

Expected: FAIL because the modules do not exist.

**Step 3: Implement registry validation**

Register the existing appearance, permissions, agent, voice, notification, browser,
and general preferences. Do not move API keys into this registry. Export lookup,
category grouping, search, and registry-validation helpers.

**Step 4: Implement deterministic resolution**

Return both value and source:

```ts
export interface ResolvedSetting<T> {
  value: T;
  source: "default" | "global" | "project" | "session";
  invalidSources: Array<"global" | "project" | "session">;
}
```

Resolution must not mutate any input map.

**Step 5: Verify GREEN**

Run the two focused tests and `npm run build`.

**Step 6: Commit**

```bash
git add src/lib/settingsSchema.ts src/lib/settingsResolver.ts src/lib/__tests__/settingsSchema.test.ts src/lib/__tests__/settingsResolver.test.ts
git commit -m "feat(settings): add typed scoped configuration registry"
```

### Task 6: Version, migrate, preset, import, and export settings

**Files:**
- Modify: `src/stores/settingsStore.ts`
- Modify: `src/stores/__tests__/settingsStore.test.ts`
- Create: `src/lib/settingsTransfer.ts`
- Create: `src/lib/settingsPresets.ts`
- Create: `src/lib/__tests__/settingsTransfer.test.ts`
- Create: `src/lib/__tests__/settingsPresets.test.ts`

**Step 1: Write failing migration tests**

Add fixtures for:

- legacy unversioned `gb-settings` data;
- the current flat store shape;
- the new versioned store with global and project overrides;
- corrupted/unknown values.

Assert that all old user-visible values survive migration, invalid fields fall back
safely, and migration is idempotent.

**Step 2: Write failing transfer and preset tests**

Assert that:

- export includes schema version, global values, project overrides, and no secrets;
- import validates the entire document before applying anything;
- a failed import leaves state unchanged;
- preview reports added, changed, reset, and ignored fields;
- safe, balanced, and high-autonomy presets produce only valid values;
- applying a preset at project scope does not overwrite global values.

**Step 3: Run tests and verify RED**

Run:

```bash
npx vitest run src/stores/__tests__/settingsStore.test.ts src/lib/__tests__/settingsTransfer.test.ts src/lib/__tests__/settingsPresets.test.ts
```

Expected: FAIL on the new version/scope behavior.

**Step 4: Implement the versioned store**

Add `settingsVersion`, `globalValues`, `projectOverrides`, and narrowly scoped actions.
Retain compatibility selectors/actions for existing consumers during migration.
Configure Zustand persist `version` and `migrate`; keep legacy keys synchronized until
all callers are moved.

**Step 5: Implement presets and atomic transfer**

`settingsTransfer.ts` must parse into a temporary validated structure, return a
preview, and apply only after explicit confirmation. Export only definitions whose
`sensitive` flag is false. `settingsPresets.ts` returns validated partial values for
the selected scope.

**Step 6: Verify GREEN**

Run the three focused test files and `npm run build`.

**Step 7: Commit**

```bash
git add src/stores/settingsStore.ts src/stores/__tests__/settingsStore.test.ts src/lib/settingsTransfer.ts src/lib/settingsPresets.ts src/lib/__tests__/settingsTransfer.test.ts src/lib/__tests__/settingsPresets.test.ts
git commit -m "feat(settings): add migration presets and atomic transfer"
```

### Task 7: Rebuild the settings center shell

**Files:**
- Modify: `src/pages/Settings.tsx`
- Create: `src/components/settings/SettingsLayout.tsx`
- Create: `src/components/settings/SettingsField.tsx`
- Create: `src/components/settings/SettingsToolbar.tsx`
- Create: `src/components/settings/SettingsTransferDialog.tsx`
- Create: `src/components/settings/__tests__/SettingsLayout.test.tsx`
- Create: `src/components/settings/__tests__/SettingsTransferDialog.test.tsx`

**Step 1: Write failing settings-center tests**

Test:

- categories are grouped into Workspace, AI, Integrations, Experience, Security,
  and System;
- search matches label, description, and keyword aliases;
- basic mode hides advanced fields without changing their values;
- scope selector shows Global or the current Project;
- each field displays Default/Global/Project/Session source;
- staged changes show a sticky Apply/Discard bar;
- closing with staged changes prompts before leaving;
- import preview must be confirmed before store mutation.

**Step 2: Run tests and verify RED**

Run:

```bash
npx vitest run src/components/settings/__tests__/SettingsLayout.test.tsx src/components/settings/__tests__/SettingsTransferDialog.test.tsx
```

Expected: FAIL against the current flat settings navigation.

**Step 3: Implement the new settings layout**

Use `SettingsLayout` for grouped navigation and one stable content region. Use
`SettingsToolbar` for search, Basic/Advanced, scope, presets, import, and export.
Use `SettingsField` for label, description, control, source badge, validation,
restart state, and reset action.

**Step 4: Implement staged state behavior**

Keep high-impact draft values local to the current settings section. Validate before
Apply. Preserve draft on errors. Discard returns to resolved values. Register the
unsaved-change confirmation with Settings close and category changes.

**Step 5: Verify GREEN**

Run focused tests, existing composer/settings tests, and `npm run build`.

**Step 6: Commit**

```bash
git add src/pages/Settings.tsx src/components/settings/SettingsLayout.tsx src/components/settings/SettingsField.tsx src/components/settings/SettingsToolbar.tsx src/components/settings/SettingsTransferDialog.tsx src/components/settings/__tests__
git commit -m "feat(settings): rebuild the professional settings center"
```

### Task 8: Migrate all settings sections to the schema lifecycle

**Files:**
- Modify: `src/components/settings/AppearanceSettings.tsx`
- Modify: `src/components/settings/GeneralSettings.tsx`
- Modify: `src/components/settings/AgentSettings.tsx`
- Modify: `src/components/settings/VoiceSettings.tsx`
- Modify: `src/components/settings/BrowserSettings.tsx`
- Modify: `src/components/settings/PermissionsManager.tsx`
- Modify: `src/components/settings/TrustedFoldersManager.tsx`
- Modify: `src/components/settings/McpManager.tsx`
- Modify: `src/components/settings/ModelManager.tsx`
- Modify: `src/components/settings/PluginManager.tsx`
- Modify: `src/components/settings/WorktreeManager.tsx`
- Create: `src/components/settings/__tests__/SettingsSections.test.tsx`

**Step 1: Write failing section lifecycle tests**

Cover immediate appearance saves, staged permission/agent/MCP/browser changes,
project override badges, individual reset, section reset, inline validation, async
save errors, restart-required state, and no secret values in transfer UI.

**Step 2: Run tests and verify RED**

Run: `npx vitest run src/components/settings/__tests__/SettingsSections.test.tsx`

Expected: FAIL because existing sections bypass the shared lifecycle.

**Step 3: Migrate low-risk sections**

Move Appearance, Voice presentation preferences, and General UI preferences to
`SettingsField` with immediate saves. Remove duplicated theme controls from General;
Appearance is the single owner.

**Step 4: Migrate high-impact sections**

Move Permissions, Agent, MCP, Browser, Models, Plugins, Trusted Folders, and Worktree
controls to staged or explicit lifecycle behavior as defined by the registry. Keep
the existing main-process APIs and security boundaries.

**Step 5: Normalize language and feedback**

Use Chinese consistently for interface labels in the current locale. Replace emoji
controls with shared SVG icons. Give every async button loading/success/error state.

**Step 6: Verify GREEN and integration tests**

Run:

```bash
npx vitest run src/components/settings/__tests__/SettingsSections.test.tsx src/stores/__tests__/settingsStore.test.ts electron/__tests__/policy.test.ts electron/__tests__/auth.test.ts
npm run build
npm run electron:build
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/components/settings
git commit -m "feat(settings): migrate settings to scoped lifecycle"
```

### Task 9: Redesign dashboard, automations, plugins, agents, and inspector

**Files:**
- Modify: `src/pages/Dashboard.tsx`
- Modify: `src/pages/AutomationsPage.tsx`
- Modify: `src/pages/WorkspaceAgentsPage.tsx`
- Modify: `src/components/settings/PluginManager.tsx`
- Modify: `src/components/panels/RightPanel.tsx`
- Modify: `src/components/panels/SubagentPanel.tsx`
- Modify: `src/components/panels/TodoPanel.tsx`
- Modify: `src/components/panels/UsagePanel.tsx`
- Create: `src/pages/__tests__/SecondarySurfaces.test.tsx`

**Step 1: Write failing destination tests**

Test actionable dashboard links, automation active/paused/error states, automation
form validation, plugin filters and lifecycle feedback, agent status hierarchy, and
inspector tab persistence. Include empty/loading/error state assertions for each.

**Step 2: Run tests and verify RED**

Run: `npx vitest run src/pages/__tests__/SecondarySurfaces.test.tsx`

Expected: FAIL because the shared surface/feedback patterns are not present.

**Step 3: Implement destination redesigns**

- Dashboard: operational overview with links to active work and failures.
- Automations: list/detail model with schedule, next run, last result, and validation.
- Plugins: searchable installed/available catalog with capability and permission info.
- Agents: stable status hierarchy and direct session navigation.
- Inspector: consistent tabs, empty states, and persisted selected tab/collapse state.

Use only shared primitives and semantic tokens.

**Step 4: Verify GREEN and targeted integration tests**

Run:

```bash
npx vitest run src/pages/__tests__/SecondarySurfaces.test.tsx electron/__tests__/iss-191-automation.test.ts electron/__tests__/iss-192-plugin-lifecycle.test.ts
npm run build
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/pages/Dashboard.tsx src/pages/AutomationsPage.tsx src/pages/WorkspaceAgentsPage.tsx src/pages/__tests__/SecondarySurfaces.test.tsx src/components/settings/PluginManager.tsx src/components/panels
git commit -m "feat(ui): redesign secondary desktop surfaces"
```

### Task 10: Accessibility, visual QA, and complete regression verification

**Files:**
- Modify: `src/styles.css`
- Modify: UI files identified by the audit
- Create: `src/__tests__/accessibilityInteractions.test.tsx`
- Create: `docs/design/ui-interaction-system.md`

**Step 1: Write failing cross-app accessibility tests**

Cover visible focus, icon labels, dialog Escape behavior, logical tab order, navigation
landmarks, status live regions, reduced motion classes, and keyboard activation of all
top-level destinations.

**Step 2: Run tests and verify RED**

Run: `npx vitest run src/__tests__/accessibilityInteractions.test.tsx`

Expected: FAIL for any remaining inconsistent surface.

**Step 3: Fix audit findings only**

Make the minimum changes needed for the failing accessibility tests. Check dark,
light, high contrast, 800px-wide window, long labels, empty states, errors, and an
active streaming session. Fix token or primitive behavior rather than adding local
page overrides.

**Step 4: Document the final interaction system**

Write `docs/design/ui-interaction-system.md` with token usage, component rules,
motion rules, configuration scope rules, accessibility requirements, and examples of
approved/forbidden patterns.

**Step 5: Run complete verification**

Run:

```bash
npx vitest run
npm run build
npm run electron:build
npm run electron:pack
git diff --check
```

Expected:

- all tests pass;
- renderer and Electron TypeScript builds pass;
- macOS packaging completes on macOS;
- no whitespace errors;
- no unexpected tracked build artifacts.

**Step 6: Inspect final repository state**

Run:

```bash
git status --short
git log --oneline --max-count=12
```

Confirm only intentional changes remain and every implementation task has its own
commit.

**Step 7: Commit**

```bash
git add src docs/design/ui-interaction-system.md
git commit -m "test(ui): complete accessibility and visual quality pass"
```
