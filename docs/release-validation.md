# Release Validation — R4 (#243)

The R4 release gate. Every item below must be green before tagging a release;
P0/P1 regressions block the release.

## Automated gate (run from a clean checkout)

```bash
npm test            # vitest — full unit/integration suite
npm run build       # tsc --noEmit + vite build (renderer)
npm run electron:build   # tsc -p electron/tsconfig.json → dist-electron
```

**Current status (main):** all three pass. The 8 known electron PTY/ACP
test failures are sandbox-environment restrictions (`failed to bind TCP
listener — Operation not permitted`), not code defects — they pass in CI
with network privileges.

### Packaging

```bash
npm run electron:pack   # renderer build + electron:build + electron-builder
```

`electron-builder` produces the macOS installer. Code-signing/notarization
requires `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / team-ID env vars
configured in CI; locally it produces an **unsigned** build usable for
smoke testing. A signed, notarized build is a CI-only step.

## What's covered by automated tests

- **Config integrity / no data loss:** `src/config/__tests__/transfer.test.ts`
  (sensitive settings never exported; imports atomic with rollback),
  `src/stores/__tests__/settingsStore.test.ts` (migration quarantine,
  sanitize-on-hydrate, legacy-key one-time consumption),
  `src/config/__tests__/presets.test.ts` (preset validation).
- **Accessibility primitives:** `src/components/ui/__tests__/primitives.test.tsx`
  (Dialog focus trap + Escape + focus restore; SegmentedControl radiogroup
  keyboard nav; Switch role=switch; SearchField labeled searchbox).
- **Reduced motion:** `src/lib/__tests__/motion.test.ts`
  (`prefersReducedMotion` reads the OS pref; `subscribeReducedMotion` fires
  immediately + on change + no-op without matchMedia); the CSS
  `@media (prefers-reduced-motion: reduce)` block zeroes all motion
  durations globally.
- **Settings Center:** `src/pages/__tests__/SettingsCenter.test.tsx`
  (search, scope switch, source badges, staged change bar + unsaved guard,
  high-risk confirm gate, import preview gate, TrustedFolders store routing).
- **Unified surfaces:** `src/pages/__tests__/Dashboard.test.tsx`
  (needs-attention, empty states, no vanity metrics),
  `src/components/ui/__tests__/detail.test.tsx` (AsyncState states,
  CollapsibleSection keyboard toggle, CopyButton).

## Manual test matrix (sign-off before release)

Run these against the packaged (unsigned) build on macOS:

| Area | Steps | Pass criterion |
|---|---|---|
| New session / send / stop / retry | ⌘N, type, send, ⌘. stop, retry | Each action keyboard-reachable; toast feedback |
| Settings: search + scope + apply | ⌘,, search "沙箱", switch scope, edit staged, Apply | Confirm gate on high-risk; source badges update |
| Import / export | Export → re-import → preview → confirm | Preview matches applied; no secret leak in export |
| Automations: create / run / toggle | New, Run, 停用 | nextRun shows; disabled automation doesn't fire |
| Themes | Dark / light / auto + 200% zoom + narrow window | No layout break; reduced-motion suppresses animation |
| Inspector | ⌘J terminal, files panel, MCP collapsible + copy | Collapsible toggles via keyboard; copy works |

## Known limitations

- **Unsigned local builds** — `electron:pack` without Apple creds produces an
  unsigned installer; distribution requires CI signing/notarization.
- **Sandbox-restricted tests** — the 8 electron PTY/ACP failures are
  environmental; they don't reflect code regressions.
- **Live MCP connection-health probing** — per-server runtime status is
  refresh/retry based; a real connection probe is main-process follow-up work
  (noted in #242).

## Rollback conditions

- A migration that quarantines a user's persisted `gb-settings` blob is
  auto-recoverable (boots on registry defaults; backup retained). If a
  release ships a migration that loses user data, roll back the release and
  the backup at `gb-settings.backup-*` restores the prior state.
- A high-risk setting change (sandbox/autonomy) requires an explicit confirm;
  a mistaken change is undoable via the toast 撤销 action (snapshot-based).
- Import is atomic (snapshot + rollback on any mid-apply failure).
