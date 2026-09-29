# Goal State — R5: Close All Open Issues

**Goal:** Close all open issues on `Colin4k1024/grok-build`.
**Scope:** R5 EPIC #256 + children #257–#266 (11 open at start). **Base branch:** `main`.
**Out of scope:** upstream `xai-org/grok-build`; production release publish; deleting user history data.
**Review gate:** Codex independent review per issue (plan review before code, code review before merge). Pass = overall >= 7.0, no dimension <= 3.
**Real-data baseline:** `~/.grok/sessions` snapshot = 575 entries @ start. Full test runs must not change it.

## Totals
- Total open at start: **11** (EPIC #256, #257–#266)
- Closed: 4 (#257, #263, #259, #265) — Wave 1 DONE
- Remaining: 7
- Current issue: #258 (Wave 2)
- main HEAD: 616b4d26 (post-#265)

## Dependency graph
- Wave 1: #257 ✅ #259 ✅ #263 ✅ #265 ✅ — COMPLETE
- Wave 2 (READY): #258, #260, #264 (deps all satisfied)
- Wave 3: #261 (←#259 ✅,#260), #262 (←#258)
- Wave 4: #266 (←all); EPIC #256 closes last.

## Progress log
- (start) Scope read from GitHub; 11 open issues; R5 plan from branch `codex/r5-release-hardening-plan` (75aaddb5). gh auth OK.
- Baseline `~/.grok/sessions` = 575 entries, 567 `gb-acp*` pollution.
- (#257) ✅ PR #267 (main 6bfe1068). AcpTransport childEnv injection; isolated suite homes; marker-based boundary assertions. Codex plan 8.0 / code 9.0 APPROVE.
- (#263) ✅ PR #268 (main 0789af3f). artifactName pinned no-space; verify-update-feed.mjs (traversal-proof, strict metadata); loopback HTTP feed tests; CI feed gate before upload; latest*.yml uploaded. Codex plan 8.0 / code r2 9.0 APPROVE.
- (#259) ✅ PR #269 (main HEAD before #265). icons.tsx (17 local SVG); all interface emoji replaced; hex→tokens (terminalTheme.ts, --gb-terminal-*, StatusBar semantic dots); uiContract.test.ts scans whole component tree (string-aware stripper). Codex plan 7.0 / code r2 9.0 APPROVE.
- (#265) ✅ PR #270 (main 616b4d26). ptyctl owns PTY child group: spawn-time pgid capture (pre-reap), TERM→KILL escalation, orphan sweep, parent-death watcher w/ cancel, live-pgid revalidation. stop() no-op bug fixed. server.rs stale test fixed. CI rust-pty job (ubuntu+macOS). Unskipped zombie test + SIGKILL + collateral cases; npm test 1027/0 skip. Cleaned two 10-day-old leaked controllers (old-bug evidence). Codex plan 7.0 / code r3 9.0 APPROVE.
- (#258) Starting: session history pagination + stale workspace governance.
