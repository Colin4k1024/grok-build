# Goal State — R5: Close All Open Issues (PAUSED by user request)

**Goal:** Close all open issues on `Colin4k1024/grok-build`.
**Scope:** R5 EPIC #256 + children #257–#266 (11 open at start). **Base branch:** `main`.
**Out of scope:** upstream `xai-org/grok-build`; production release publish; deleting user history data.
**Review gate:** Codex independent review per issue (plan review before code, code review before merge). Pass = overall >= 7.0, no dimension <= 3.

## Totals (as paused, 2026-09-30)
- Total open at start: **11** (EPIC #256, #257–#266)
- Closed + merged to main: **8** — #257, #259, #263, #265, #258, #260, #264, #261
- Remaining open: **5** — #256 (EPIC), #262 (WIP pushed), #266 (final gate), #272 (agent-serve orphan bug filed during #260), #274 (VoiceOver run — human window item)
- main HEAD at pause: 91f13285 (post-#261)

## Dependency graph
- Wave 1: #257 ✅ #259 ✅ #263 ✅ #265 ✅ — COMPLETE
- Wave 2: #258 ✅ #260 ✅ #264 ✅ — COMPLETE
- Wave 3: #261 ✅; #262 WIP on branch `feat/r5-06-perf-budget` (pushed, NOT merged)
- Wave 4: #266 (←#262+#272)
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
- (#262) WIP — pushed `feat/r5-06-perf-budget` (NOT merged). Green: vendor chunk split (entry 719→233KB raw, 222→69KB gzip — under the 500/200 budget) + `check-bundle-budget.mjs` gate + tests. In progress: ThreadTree virtualization (flat rows + per-row store subscriptions); ThreadTree tests currently red in jsdom because react-window needs ResizeObserver — next step is a test-env polyfill or RO guard, then the virtualization + perf regression tests land, then code review, then merge.
- Filed during execution: #272 (agent serve orphans on app hard-kill — same parent-death class #265 fixed for ptyctl; 52 orphans found and cleaned on this machine), #274 (VoiceOver speech-run — needs a human at the release window; system state must not be flipped by automation).

## Resume instructions
1. `git checkout feat/r5-06-perf-budget` — finish #262 (polyfill ResizeObserver for jsdom, green the ThreadTree tests, Codex review, merge).
2. Then #266 (release gate aggregation) — depends on #262.
3. Then #272 (agent-serve parent-death watcher, mirrors the ptyctl fix).
4. #274 stays open for a human VoiceOver run at the release window.
5. Close EPIC #256 when all children close.
