# R5 Release Acceptance

Single-source, machine-auditable gate for the R5 desktop release. Lives as
`npm run release:gate` → `scripts/release-gate.mjs`.

## Goal

One command, one report, reproducible across hosts. Aggregates every R5 check
(test, build, E2E, evidence, pack, feed verification, UAT, signature, and
cross-platform install smoke) so a release cannot ship with a silent gap.

## Sequence

`release:gate` runs these in order, **continue-on-failure**: a step whose
prerequisite failed or was skipped is itself skipped (not run), but every
independent runnable step still runs — the report is always complete.

| Step | Prereqs | Command |
| --- | --- | --- |
| unit | — | `npm test` |
| build | unit | `npm run build` (tsc + vite + bundle budget gate) |
| electron-build | build | `npm run electron:build` |
| evidence | unit | `npm run evidence` |
| pack | electron-build | `npm run electron:pack` |
| e2e | pack | `npm run test:e2e` (xvfb-run on linux if present) |
| checksums | pack | `scripts/release-checksums.sh` |
| feed-verify | pack | `scripts/verify-update-feed.mjs <latest*.yml> <release/>` |
| uat | pack | `desktop-uat.mjs report --strict --run <latest>` (skip in CI; human-driven) |
| macos-smoke | pack (darwin) | `scripts/verify-macos-release.sh <dmg>` |
| linux-smoke | pack (linux) | `scripts/verify-linux-release.sh <AppImage>` |
| windows-smoke | pack (win32) | `scripts/verify-windows-release.sh <exe>` |
| user-data-unchanged | (wraps the whole gate) | `~/.grok/sessions` sha256 (names+sizes) before == after |

Platform-smoke steps run only on their host platform (a `linux` smoke is
`skipped` on `darwin`, recorded with the reason). A null artifact (no manifest
to verify, no DMG to smoke) skips gracefully rather than failing.

## Output

`release/release-report.json` and `release/release-report.md`, both always
written — even when the gate fails — with:

- `overall` (pass/fail) + per-step status, duration, and skip reason
- `meta`: commit, branch, platform, arch, node/npm/electron versions, generated-at
- `signature`: macOS codesign/spctl/staple status (from the smoke step)
- `uat`: UAT strict-report status
- `artifacts`: the packaged files in `release/` with sizes
- `checksums`: link to `release/checksums.sha256`

Exit code 0 only when **every** step passed; 1 otherwise.

## Acceptance (issue #266)

- No P0/P1 open bug — verified by the unit/e2e steps + the issue tracker state.
- R5 UAT has no unexecuted or partial items — the `uat` step runs the strict
  report (exit 0 only on full pass).
- Real user data dir unchanged by the gate — the `user-data-unchanged` step
  hashes `~/.grok/sessions` before and after; isolation (#257) and the
  parent-death watchdog (#272) keep it stable.
- All packages consistent with the update manifest — the `feed-verify` step
  (#263) checks every referenced file exists + size/sha512 matches.
- macOS release signed/notarized/stapled — the `macos-smoke` step (#264) runs
  `verify-macos-release.sh`. **Notarization needs the CI Apple secrets**; it
  is not provable on a dev host without them, mirroring #264's caveat.
- Single command reproducibly generates the same-structure report.

## CI

A `release-gate` job (tag-triggered, `protected release` env for Apple
secrets) runs `npm run release:gate` and uploads `release-report.{json,md}` +
the artifacts as release assets. Cross-platform coverage comes from a platform
matrix (darwin/linux/win32), each leg running its host smoke.
