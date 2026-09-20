# R3 Capability Matrix

Last updated: 2026-09-20 | SHA range: 3b9126a4 → (current branch tip)

| Domain | R3 Issue | Capability | Pre-R3 State | Post-R3 State | Evidence |
|--------|----------|-----------|-------------|---------------|----------|
| **Security** | #186 | Sandbox enforcement | Dead toggle (localStorage write, no consumer) | Toggle syncs approvalMode store-wide; SideChat auto-deny; Home respects sandbox pref | `src/components/layout/SandboxToggle.tsx` |
| **ACP** | #187 | Agent protocol | One `xai-grok-pager agent stdio` per tab, fs read/write only, terminal=false | PENDING — Rust backend refactor required | — |
| **Commands** | #188 | Slash command wiring | /fork,/archive,/review degraded; /rename tab-only; Apply Code dead event | All commands local/real; /rename persists; Apply Code listens | `src/lib/slashExec.ts`, `src/App.tsx` |
| **Testing** | #189 | CI evidence | No coverage, no JUnit, no artifacts | v8 coverage, JUnit XML, evidence snapshots, CI artifact upload | `.github/workflows/ci.yml`, `vite.config.ts` |
| **Worktree** | #190 | Managed worktrees | git worktree list/add/remove wrappers, no recovery | PENDING — managed registry + handoff | — |
| **Automations** | #191 | Native scheduler | localStorage cron, 30s page-interval | PENDING — main-process scheduler rewrite | — |
| **Plugins** | #192 | Plugin lifecycle | Hardcoded npm MCP dir, no manifest/version/perm | PENDING — manifest schema + lifecycle | — |
| **Review** | #193 | Review workflow | All/last-turn diff, approve/revise/reject | + staged scope toggle, per-file revert (unstage/discard) | `src/components/panels/RightPanel.tsx` |
| **State** | #194 | Turn state machine | Global isStreaming boolean, per-session streaming flag | Turn counter, turn state (idle/streaming), subagent progress items | `src/stores/sessionStore.ts` |
| **Composer** | #195 | Composer enhancements | textarea, @file/$skill triggers, slash autocomplete | + per-session draft persistence (restore/save/clear) | `src/lib/composerDraft.ts`, `src/components/chat/PromptInput.tsx` |
| **Navigation** | #196 | Settings source | 15+ independent localStorage reads | Centralized settingsStore (gb-settings), backward compat | `src/stores/settingsStore.ts` |
| **Auth** | #197 | Auth UX | Format-only key check, no per-provider messages | 8-provider format rules with specific error messages | `electron/auth.ts`, `src/pages/Login.tsx` |
| **Release** | #198 | Production signing | `--publish never`, no notarization | BLOCKED — requires certificates | — |
| **Platform** | #199 | Lifecycle | Basic quit/relaunch | Single-instance lock, native menu, crash recovery, OS permissions probe | `electron/main.ts` |
| **Voice** | #200 | Voice/Screen context | Web Speech dictation, no screen probe | + screenContextAvailable(), unified probeRealtimeCaps() | `src/lib/voiceMachine.ts` |
| **Browser** | #201 | Browser/Computer Use | None | PENDING — capability-gated, high-risk permissions | — |
| **Artifacts** | #202 | Artifact viewing | Image-only viewer | Typed artifact viewer (image/code/JSON/CSV/markdown) | `src/components/chat/ArtifactViewer.tsx` |
| **Docs** | #203 | Documentation | Partial parity docs, historical duplicate issues | Capability matrix, evidence trail, ADR updates | This document |

## Test Coverage Baseline

- **Frontend unit tests**: 307 total, 298 pass
- **Test files**: 26 total (14 render-side, 12 electron-side)
- **TypeScript**: 0 errors (`tsc --noEmit`)
- **CI evidence**: JUnit XML + HTML coverage artifacts (7-day retention)
- **Known gaps**: 9 electron-side failures (ptyctl keychain env deps — non-blocking)

## Legend

- ✅ = Implemented, test-verified, branch pushed
- PENDING = Requires Rust/ACP backend changes or external capability
- BLOCKED = External dependency (certificates, service endpoint)