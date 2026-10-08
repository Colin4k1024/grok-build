# Goal State — R6: Desktop Release-Readiness (ACTIVE — started 2026-10-08)

**Goal:** Close all open issues on `Colin4k1024/grok-build`.
**Scope:** R6 release-readiness — #279–#285 (all labeled `r6-release-readiness`), waves 1→3. **Base branch:** `main` (HEAD `7f48b87e`, R5 complete 13/13).
**Out of scope:** upstream `xai-org/grok-build`; production publish/tag/feed promotion; deleting user data; credential rotation.
**Review gate:** Codex independent review per issue (`codex review --base main`). Pass = APPROVE, no dimension <= 3. One issue = one closed loop (branch → code → test → evidence → review → merge `Closes #NNN`).

## Totals (as of 2026-10-08, round 1 — re-read from GitHub)
- Total open at R6 start: **7** — #279, #280, #281, #282, #283, #284, #285
- Closed + merged: **0**
- Remaining open: **7**
- main HEAD: `7f48b87e` (R5 complete)

## Dependency graph (R6)
- Wave 1 (trustworthy baseline):
  - #279 (R6-01, bug) — **READY_FOR_DEV**, no deps. Blocks #282, #284. ← CURRENT
  - #280 (R6-02) — **READY_FOR_DEV**, independent. Blocks #281, #284.
  - #281 (R6-03, security) — blocked by #280. Blocks #284.
- Wave 2 (repo + release controls):
  - #282 (R6-04) — blocked by #279. Blocks #285.
  - #283 (R6-05, security) — **READY_FOR_DEV**, independent. Blocks #284.
- Wave 3 (RC rehearsal + sign-off):
  - #284 (R6-06) — blocked by #279, #280, #281, #283. Blocks #285.
  - #285 (R6-07, go/no-go) — blocked by #282, #284. Closes milestone last.

## Current issue
- **#279 (R6-01)** — Restore trustworthy green main CI + explicit non-publishing pack mode. Bug/regression: latest main run red; Linux `mktemp -d -t gb-verify-dmg` BSD-only semantics; Electron E2E stops at pack because electron-builder requests `GH_TOKEN` (Playwright never runs). Acceptance: two consecutive green main runs; `pack(smoke)` state machine `pending->built->verified` with no `published` transition; missing GH_TOKEN succeeds in smoke; isolated output/user-data dirs; no tag/release/feed/secret/user-data side effects.

## R6 progress log
- (start 2026-10-08) Re-read GitHub: 7 open R6 issues (#279–#285). R5 verified complete (13/13, EPIC #256 closed, main `7f48b87e`). Cleaned 17 empty stray working-tree files (release-gate step-named, 0 bytes). Selected #279 as highest-priority READY_FOR_DEV (bug, blocks downstream).

---

## R5 (COMPLETE — 2026-10-08, 13/13 closed) — historical log

R5 EPIC #256 + children #257–#266 + #272/#274 all closed and merged to main. main HEAD post-R5: `7f48b87e` (docs: R5 goal complete). Close-out evidence per issue preserved below.

- (#257) ✅ PR #267. AcpTransport `childEnv` injection; isolated suite homes; real sessions dir byte-identical. Codex code 9.0.
- (#259) ✅ PR #269. 17-icon local SVG set; all interface emoji replaced; hex→tokens; `uiContract.test.ts`. Codex code 9.0.
- (#263) ✅ PR #268. artifactName pinned; `verify-update-feed.mjs`; loopback HTTP feed tests; CI feed gate. Codex code 9.0.
- (#265) ✅ PR #270. ptyctl owns PTY child process group (pgid capture, TERM→KILL, orphan sweep, parent-death watcher); CI rust-pty job. Codex code 9.0 (3 rounds).
- (#258) ✅ PR #271. Cursor-paginated history; workspace_exists; GROK_HOME-aware delete; ThreadTree load-more; StaleHistorySection. Codex code 9.0.
- (#260) ✅ PR #273. Isolated UAT harness; 34/34 R4 matrix; strict exit 0. Codex code 9.0 (3 rounds).
- (#264) ✅ PR #275. Entitlements + tag-only `release-mac`; `verify-macos-release.sh` + 8 tests. Codex APPROVE.
- (#261) ✅ PR #276. Electron Playwright suite (isolated, offline, zh-CN pinned, snapshots); CI e2e job. Codex APPROVE.
- (#262) ✅ Merged (02d435d7). react-window v2 virtualization; vendor chunk split; `check-bundle-budget.mjs`. Codex APPROVE (3 rounds).
- (#272) ✅ Merged. agent-serve parent-death watchdog.
- (#274) ✅ PR #278 (07206df4). VoiceOver live-speech patrol; `voiceover-patrol.mjs`; 8 tests. Codex APPROVE (3 rounds).
- (#266) ✅ PR #277. R5 release gate + parent-death watchdog IPC; 29 gate tests. Codex APPROVE (10 rounds).
- (#256) ✅ EPIC close-out: data hygiene ✓, P0/P1 ✓ (0 open), UAT 34/34 + UAT-22 VO patrol ✓, manifest consistency ✓, gate report generation verified.
