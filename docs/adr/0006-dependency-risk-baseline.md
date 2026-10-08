# ADR 0006: Desktop Dependency-Risk Baseline

Status: Accepted — R6-03 (#281), 2026-10-08

## Context

`npm audit` reports 26 advisories (4 critical, 8 high, 14 moderate) against the
desktop project's lockfile. The critical findings are in the test runner
(`vitest`/`tinypool`) and the dev script runner (`concurrently`/`shell-quote`);
the highs are in the CSS build chain (`tailwindcss`/`braces`/`chokidar`/
`fast-glob`/`micromatch`), the bundler (`vite`/`esbuild`/`source-map-js`), and an
`electron-builder` transitive (`http-cache-semantics`). Most suggested fixes are
semver-major upgrades. There was no enforceable policy: GitHub vulnerability
alerts were disabled and nothing rejected unowned critical/high findings.

## Key finding: all 26 are dev/build exposure

None of the 26 advisories are in the packaged runtime. The desktop app's
production `dependencies` (react, react-dom, ws, electron-updater,
@xterm/\*, prosemirror/\*, react-window, zustand, rehype-highlight, remark-gfm,
react-markdown, react-diff-viewer-continued) contain **zero** advisory-bearing
packages. Every advisory is in `devDependencies` or a transitive of a
dev/build tool (test runner, CSS compiler, bundler, pack tooling). Per the
#281 Non-goal, dev/build exposure is NOT equated to packaged-runtime exposure:
the emitted app bundle (static assets) does not ship these packages.

## Decision

Establish an enforceable dependency-risk baseline with an exception registry:

- `security/audit-exceptions.json` — every critical/high finding that is not yet
  fixed is listed with `package`, `severity`, `exposure`, `owner`, `mitigation`,
  and a non-expired `expires` (the "accepted-temporarily" state). All 26 current
  findings are registered (all dev/build), owner `grok-build-release`, expiry
  2026-12-08, each with the specific upgrade path as mitigation.
- `scripts/check-deps-audit.mjs` — the gate. Runs `npm audit --json` (always
  against the official registry — the project's default mirror doesn't
  implement the audit endpoint), reads the exception file, and fails when any
  critical/high finding is unowned (not in the file) or an exception is invalid
  (missing owner/mitigation/expiry, malformed date, or expired). Moderate and
  below are reported but not required to be owned (the desktop RC baseline
  targets critical/high). State machine: `new -> triaged -> fixed|
  accepted-temporarily`; acceptance cannot omit expiry or owner.
- Wired into the `frontend` CI job (`.github/workflows/ci.yml`) before
  `npm ci` — `npm audit` reads `package-lock.json` (no `node_modules` needed),
  so the gate fails fast on a security regression before the expensive install.

## Consequences

- Reintroducing a denied advisory (a critical/high not in the exception file)
  fails CI. Removing an exception's owner/expiry, or letting it expire, fails CI.
- The actual risk-reduction upgrades (vitest ^5, tailwindcss ^4, vite ^8,
  electron-builder next, @tailwindcss/typography ^0.5.4) are deferred to
  dedicated PRs, each with regression coverage, before the 2026-12-08 expiry.
  The `concurrently`/`shell-quote` fix is flagged for review: the npm-suggested
  "fix" is a contradictory downgrade (installed ^10.0.5, advisory range
  >=9.2.3) and must not be applied blindly.
- No `npm audit fix --force` without review (Non-goal). No registry publication
  during the gate; the audit report contains no tokens or local paths with
  credentials.

## Upgrade ownership and cadence

- vitest cluster (vitest/tinypool/@vitest/mocker/vite-node): one PR upgrading
  vitest to ^5.0.3 with full test regression.
- tailwindcss cluster (tailwindcss/braces/chokidar/fast-glob/micromatch/
  postcss-nested/postcss-selector-parser/@tailwindcss/typography): one PR
  upgrading tailwindcss to ^4 + @tailwindcss/typography to ^0.5.4 with CSS +
  visual regression.
- vite cluster (vite/esbuild/source-map-js): one PR upgrading vite to ^8 with
  build regression.
- electron-builder cluster (electron-builder/app-builder-lib/dmg-builder/
  electron-builder-squirrel-windows/@electron/get/global-agent/roarr/sprintf-js/
  http-cache-semantics): one PR upgrading electron-builder to the next release
  that resolves the transitive advisories.
- concurrently/shell-quote: a reviewed replacement/upgrade (no blind downgrade).
