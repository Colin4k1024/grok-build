# Goal State — R6: Desktop Release-Readiness (ACTIVE — started 2026-10-08)

**Goal:** Close all open issues on `Colin4k1024/grok-build`.
**Scope:** R6 release-readiness — #279–#285 (all labeled `r6-release-readiness`), waves 1→3. **Base branch:** `main` (HEAD `7f48b87e`, R5 complete 13/13).
**Out of scope:** upstream `xai-org/grok-build`; production publish/tag/feed promotion; deleting user data; credential rotation.
**Review gate:** Codex independent review per issue (`codex review --base main`). Pass = APPROVE, no dimension <= 3. One issue = one closed loop (branch → code → test → evidence → review → merge `Closes #NNN`).

## Totals (as of 2026-10-08, round 1 — re-read from GitHub)
- Total open at R6 start: **7** — #279, #280, #281, #282, #283, #284, #285
- Filed during execution: **#287** (e2e visual baselines vs CI macOS display — HUMAN_BLOCKED)
- Closed + merged: **0**
- Remaining open: **8** (#279–#285 + #287)
- main HEAD: `7f48b87e` (R5 complete; #279 fix on branch `fix/r6-01-main-ci-trust`, PR #286, NOT merged — blocked by #287)

## Dependency graph (R6)
- Wave 1 (trustworthy baseline):
  - #279 (R6-01, bug) — **fix complete + Codex APPROVE** (PR #286); **BLOCKED on #287** (Core acceptance needs green Playwright). Blocks #282, #284.
  - #287 (e2e visual baselines) — **HUMAN_BLOCKED** (product/test-strategy decision). Blocks #279 acceptance, #282, #284.
  - #280 (R6-02) — **READY_FOR_DEV**, independent. Blocks #281, #284. ← NEXT
  - #281 (R6-03, security) — blocked by #280. Blocks #284.
- Wave 2 (repo + release controls):
  - #282 (R6-04) — blocked by #279 (green e2e). Blocks #285.
  - #283 (R6-05, security) — **READY_FOR_DEV**, independent. Blocks #284.
- Wave 3 (RC rehearsal + sign-off):
  - #284 (R6-06) — blocked by #279, #280, #281, #283. Blocks #285.
  - #285 (R6-07, go/no-go) — blocked by #282, #284. Closes milestone last.

## Current issue
- **#279 (R6-01)** — fix complete on PR #286 (HEAD `0a58f095`). 3/3 root causes fixed + Codex clean APPROVE (r3). PR CI: `Test + Typecheck + Build` ✓ (mktemp fix proven on Linux), both `Rust PTY` ✓, `Pack` ✓ (--publish never proven), `Assert Playwright ran tests` ✓ (guard proves Playwright executed). `Run Electron e2e suite` ✗ — visual baselines (1200×800/1440×900) don't match CI macOS display (~1024 wide clamps the window). Tracked as **#287 (HUMAN_BLOCKED)**. Not merging until #287 resolves.
- **NEXT: #280 (R6-02)** — reproducible desktop toolchain + runtime contract (READY_FOR_DEV, independent, blocks #281 + #284).

## R6 progress log
- (start 2026-10-08) Re-read GitHub: 7 open R6 issues (#279–#285). R5 verified complete (13/13, EPIC #256 closed, main `7f48b87e`). Cleaned 17 empty stray working-tree files (release-gate step-named, 0 bytes). Selected #279 as highest-priority READY_FOR_DEV (bug, blocks downstream).
- (#279) PR #286, branch `fix/r6-01-main-ci-trust`. 3 root causes fixed: (1) portable `mktemp -d "${TMPDIR:-/tmp}/gb-verify-dmg.XXXXXX"` in `verify-macos-release.sh` + portability guard test; (2) `--publish never` on `electron:pack` script (NOT `build.publish:"never"` config — that breaks electron-builder 26's afterPack provider resolution; Codex r1 P1 caught it); (3) `assert-e2e-ran.mjs` guard + JSON reporter so a skipped/empty Playwright run fails the job (counts expected+unexpected+flaky so an all-failure run isn't misreported — Codex r2 P3). Replaced vacuous `"never"==="never"` test with real package.json assertion. ci.yml e2e: clean-before-pack, always-run guard + SHA evidence + artifact upload. 31 tests pass. Codex: r1 CHANGES_REQUESTED (1 P1) → r2 APPROVE+1 P3 → r3 **clean APPROVE** (findings=[], conf 0.9). PR CI 37707996061: frontend/pack/guard green; e2e visual ✗ (baselines 1200×800/1440×900 vs CI display ~1024 → window clamped). **#287 filed (HUMAN_BLOCKED)** — needs product/test-strategy decision (re-baseline [hides NOT-PROVEN] vs enlarge CI macOS display [none] vs Linux+Xvfb [big change] vs reduce sizes [loses breakpoint coverage]). #279 NOT merged (blocked on #287 for green-Playwright acceptance).

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
