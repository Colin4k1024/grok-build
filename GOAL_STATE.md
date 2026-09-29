# Goal State — R5: Close All Open Issues

**Goal:** Close all open issues on `Colin4k1024/grok-build`.
**Scope:** R5 EPIC #256 + children #257–#266 (11 open at start). **Base branch:** `main`.
**Out of scope:** upstream `xai-org/grok-build`; production release publish; deleting user history data.
**Review gate:** Codex independent review per issue (plan review before code, code review before merge). Pass = overall >= 7.0, no dimension <= 3.
**Real-data baseline:** `~/.grok/sessions` snapshot = 575 entries @ start. Full test runs must not change it.

## Totals
- Total open at start: **11** (EPIC #256, #257–#266)
- Closed: 1 (#257)
- Remaining: 10
- Current issue: #263 (Wave 1)
- main HEAD: 6bfe1068 (post-#257 squash merge)

## Dependency graph
- Wave 1 (READY): #259, #263, #265 — #257 ✅
- Wave 2 (READY): #258, #260 (deps #257 ✅); #264 (←#263)
- Wave 3: #261 (←#259,#260), #262 (←#258)
- Wave 4: #266 (←all); EPIC #256 closes last.

## Progress log
- (start) Scope read from GitHub; 11 open issues; R5 plan found on branch `codex/r5-release-hardening-plan` (commit 75aaddb5). gh auth OK (repo+workflow). No open PRs.
- Baseline `~/.grok/sessions` = 575 entries, 567 are `gb-acp*` test pollution — confirmed #257 severity.
- (#257) ✅ CLOSED via PR #267 (squash → main 6bfe1068). `AcpTransport` readonly `childEnv` (process env→key store→child env); suite-level isolated GROK_HOME/GB_JOURNAL_DIR; zero process.env mutation; dispose-all-before-cleanup; boundary tests assert isolated-home non-empty + real sessions snapshot identical. Evidence: targeted 20/20; full 993 pass / 0 fail (1 pre-existing PTY skip = #265); real sessions 575→575 byte-identical. Codex plan 8.0 (2 P2 incorporated) / code 9.0 APPROVE.
- (#263) Starting: artifact naming + updater feed verification.
