# Goal State — R5: Close All Open Issues (ACTIVE)

**Goal:** Close all open issues on `Colin4k1024/grok-build`.
**Scope:** R5 EPIC #256 + children #257–#266 + #272/#274 filed during execution. **Base branch:** `main`.
**Out of scope:** upstream `xai-org/grok-build`; production release publish; deleting user history data.
**Review gate:** Codex independent review per issue (code review before merge). Pass = APPROVE, no dimension <= 3.

## Totals (as of 2026-09-30, #262 + #272 merged)
- Total open at start: **11** (EPIC #256, #257–#266) + #272, #274 filed later
- Closed + merged to main: **10** — #257, #259, #263, #265, #258, #260, #264, #261, **#262**, **#272**
- Remaining open: **3** — #256 (EPIC), #266 (final gate), #274 (VoiceOver — human window)
- main HEAD: (post-#272, see git log)

## Dependency graph
- Wave 1: #257 ✅ #259 ✅ #263 ✅ #265 ✅ — COMPLETE
- Wave 2: #258 ✅ #260 ✅ #264 ✅ — COMPLETE
- Wave 3: #261 ✅ #262 ✅ — COMPLETE
- Wave 4: #266 (←#262 ✅ + #272 ✅) — UNBLOCKED, ready to build
- #272 ✅ independent (agent-serve parent-death watchdog)
- #274 stays open for a human VoiceOver run at the release window
- EPIC #256 closes last.

## Progress log
- (start) 11 open issues; R5 plan from branch `codex/r5-release-hardening-plan` (75aaddb5). Baseline `~/.grok/sessions` = 575 entries (567 `gb-acp*` pollution).
- (#257) ✅ PR #267. AcpTransport `childEnv` injection; isolated suite homes; real sessions dir byte-identical across full test runs. Codex code 9.0.
- (#263) ✅ PR #268. artifactName pinned `Grok-Build-${version}-${arch}.${ext}`; `scripts/verify-update-feed.mjs` (traversal-proof, strict metadata); loopback HTTP feed tests; CI feed gate before upload; latest*.yml uploaded. Codex code 9.0.
- (#259) ✅ PR #269. 17-icon local SVG set; all interface emoji replaced; hex→tokens; `uiContract.test.ts` scans the whole component tree. Codex code 9.0.
- (#265) ✅ PR #270. ptyctl owns the PTY child process group (spawn-time pgid capture, TERM→KILL escalation, orphan sweep, parent-death watcher, live-pgid revalidation); stop() no-op bug fixed; CI rust-pty job (ubuntu+macOS); npm test 0 skips. Codex code 9.0 (3 rounds).
- (#258) ✅ PR #271. Cursor-paginated history (stable sort key, 100/200 limits), workspace_exists, GROK_HOME-aware hardened delete, ThreadTree load-more with generation guard, StaleHistorySection (multi-select, double-confirm delete, gb-acp filter = suggestion only). Codex code 9.0.
- (#260) ✅ PR #273. Isolated UAT harness (`desktop-uat.mjs` + `uat-state.mjs`), `GB_UAT_USER_DATA_DIR` pre-ready override, main.ts GROK_HOME env fix; **34/34 R4 matrix items executed** against the packed app in the isolated env (real account for real-account items), strict report exit 0, real `~/.grok` inventory unchanged by UAT. Surfaced + fixed along the way: AcpTransport concurrent-connect race; isolated-serve hang (auto_update + catalog seed); managed-Notion-MCP fatal kill; spliceMatrix pipe-corruption. Codex code 9.0 (3 rounds).
- (#264) ✅ PR #275. Entitlements + tag-only `release-mac` job (protected `release` env, preflight fails on missing secrets, notarize via CLI flag, verify-then-upload); `verify-macos-release.sh` (app/DMG inner-app, trap cleanup) with 8 stubbed tests. NOT PROVEN locally: real notarization needs the CI Apple secrets. Codex APPROVE.
- (#261) ✅ PR #276. Electron Playwright suite (isolated fixture, offline boot, zh-CN/Asia-Shanghai pinned, snapshot baselines committed); CI e2e job. Codex APPROVE.
- (#262) ✅ Merged to main (02d435d7, squash). react-window v2 virtualization (flat row model + per-row store subscriptions); ResizeObserver jsdom polyfill; vendor chunk split (entry 242.6KB/72.6KB gzip, largest chunk 327.5KB); `check-bundle-budget.mjs` postbuild gate (cross-platform forward-slash entry detection); ARIA spread on rows; below-list sections scroll-capped. Codex APPROVE (3 rounds — P1 layout, P2 gate-wiring, P3 ARIA, P1 win32 path, all fixed).
- Filed during execution: #272 (agent serve orphans on app hard-kill — same parent-death class #265 fixed for ptyctl; 52 orphans found and cleaned on this machine), #274 (VoiceOver speech-run — needs a human at the release window; system state must not be flipped by automation).
- (#272) ✅ Merged to main (squash). Parent-death watchdog: AcpTransport forks a CJS watchdog with an IPC channel that re-execs the agent serve; on IPC disconnect (hard-kill/crash — fires even on SIGKILL) OR transport dispose (proc.disconnect(), cross-platform — win32 kill('SIGTERM') force-terminates without handlers) the watchdog SIGTERMs the agent (graceful flush) → 2s grace → SIGKILL → exit. Signal-number-preserving exit forwarding; stale-generation guard; ELECTRON_RUN_AS_NODE stripped from the agent env; build.sh ships the watchdog. 7 tests (2 cross-platform + 3 POSIX-gated + env-leak + kill-via-disconnect). Codex APPROVE (10 rounds).

## Resume instructions
1. #262 ✅ merged. #272 ✅ merged.
2. #266 (release gate aggregation) — UNBLOCKED (#262 + #272 done; no P0/P1 open bug remains). Build `npm run release:gate` orchestrator + cross-platform install smoke + release-report.json/md.
3. #274 stays open for a human VoiceOver run at the release window (HUMAN_BLOCKED — needs a person to toggle ⌘F5); maximize automation via an AX-tree focus-order harness first.
4. Close EPIC #256 when all children close.
