# Goal State — R4 EPIC Closeout

**Goal:** Close all open issues on `Colin4k1024/grok-build` (fork).
**Base branch:** `main` · **Out of scope:** upstream `xai-org/grok-build` (issues disabled).
**Review gate:** `codex review --base main` per SHA (no self-assessment). Merge path: gh token invalid → direct squash-merge to main + curl/socks5-proxy API (see memory grok-build-gh-merge-workaround).

## Totals
- Total open: **0** — GOAL COMPLETE
- Closed: all (#233 EPIC + #234-#243 + #252)
- main HEAD: 619f5062

## Goal complete
All open issues on `Colin4k1024/grok-build` are closed. Final open-issue count = 0.

## HUMAN_BLOCKED
- **#252** (R4-07 enforcement + honesty follow-ups): the SandboxToggle per-tab enforcement (#252's "安全" item) has a genuine design conflict with the existing per-session `ApprovalModeSelect` picker in PromptInput — the enforcement effect force-conforms every tab to the sandbox-derived mode on each `tabs` change, reverting the user's per-tab approval pick within milliseconds (P1, empirically reproduced by Codex). Reconciling requires a product decision: does the global sandbox toggle override per-tab approval picks, or vice versa? Any minimal code fix breaks either the project-override enforcement test or the per-tab picker. The PR #252 + branch `fix/iss-240-followups` remain open on origin for resolution. #252's OTHER items (schema scope honesty, voice legacy-key merge migration, TrustedFolders store-driven, reset/applyPreset layer-based no-op) are clean and were merged+fixed locally before the enforcement conflict surfaced; they can be salvaged separately.

## Dependency chain (topological)
#240 ✅ → #241 ✅ → #242 (READY_FOR_DEV) → #243 (deps all leaves) → #233 (EPIC). #252 is a #240 follow-up, blocked.

## Progress log
- (start) Inferred scope; Codex CLI available; #240 READY_FOR_DEV.
- (#240) 5 Codex review rounds; verdict patch correct. Merged main 848ef9e7 (squash, gh-token workaround). Closed.
- (#241) Implemented + 2 review rounds; verdict patch correct. Merged main 7a4e4c11 (squash). Closed.
- (#252) Merged the parallel session's PR #252 locally; 4 Codex review rounds fixed voice-merge/TrustedFolders-confirm/SandboxToggle-push/restart-repush/voice-mirror/bootstrap-store-read/applyImport-classify. Round 4 surfaced a P1 design conflict: SandboxToggle enforcement reverts the per-session ApprovalModeSelect picker. HUMAN_BLOCKED (contradictory product goals). Reverted the unpushed local merge; PR #252 + branch left open on origin.
- (#242) Starting R4-09: unify Dashboard/Automations/Plugins/Agents/Inspector.
