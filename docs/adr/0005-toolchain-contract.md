# ADR 0005: Reproducible Desktop Toolchain Contract

Status: Accepted — R6-02 (#280), 2026-10-08

## Context

Before R6-02, the desktop toolchain was not reproducible and the runtime
contract was unenforced:

- **Node**: CI workflows pinned Node 20 (`actions/setup-node` `node-version:
  '20'`), but Electron 44.4.1 declares `engines.node: ">=22.12.0"`. The root
  `package.json` had no `engines` field and there was no `.nvmrc` /
  `.node-version`. Nothing rejected the Node-20-on-Electron-44 combination.
- **protoc**: CI pinned `arduino/setup-protoc` version `25.1`; the dev
  `bin/protoc` dotslash manifest fetched `29.3`. Dev and CI resolved different
  protoc versions for the same proto build
  (`crates/codegen/xai-grok-tools-api/build.rs` → `xai-proto-build`).
- **Rust**: `rust-toolchain.toml` pins `channel = "1.94.0"`, but workflows
  invoked `dtolnay/rust-toolchain@stable`. Cargo honors `rust-toolchain.toml`
  for the effective toolchain, but the `@stable` install was confusing and
  nothing verified the effective rustc matched the pin.
- **No enforcement gate**: `scripts/release-gate.mjs` recorded
  node/npm/electron versions for tag releases but never rejected unsupported
  runtimes; CI evidence did not record tool versions at all.

## Decision

Establish a single, checked-in runtime contract enforced by a preflight that
runs before expensive builds. State machine: `unknown -> validated ->
executing`; execution cannot begin from `unsupported`.

### Supported toolchain

- **Node**: the 22 LTS family. `.nvmrc` pins `22` (the family; `nvm` /
  `actions/setup-node`'s `node-version-file` resolve the latest 22.x).
  `package.json` `engines.node` declares `">=22.12.0"` (the Electron 44 floor)
  — the hard requirement; the preflight rejects anything below it.
- **npm**: lockfileVersion 3 (npm 7+). The preflight rejects a lockfile whose
  `lockfileVersion` is not 3 (wrong-npm-generation guard).
- **protoc**: `29.3`, aligned between CI (`arduino/setup-protoc` `version:
  29.3`) and the dev `bin/protoc` dotslash manifest. The preflight verifies
  protoc is on PATH (the proto build needs it).
- **Rust**: `1.94.0` pinned in `rust-toolchain.toml` (the authoritative
  source; cargo honors it). The preflight verifies the effective `rustc`
  matches the pinned channel.

### Enforcement

`scripts/check-toolchain.mjs` (run via `npm run check:toolchain`) is wired
into every CI job (`.github/workflows/ci.yml` and `electron.yml`) before the
expensive build/test/pack steps. It checks node + lockfile universally and
opts into protoc/rust via `--require protoc,rust` for jobs that need them
(rust-pty uses `--require rust`; the frontend job uses the default
node+lockfile). A job that does not need protoc/rust is not failed for their
absence. The preflight records node/npm/protoc/rustc/electron/electron-builder
versions; CI writes them to `evidence/toolchain.json`.

### Workflow alignment

- All `actions/setup-node` steps use `node-version-file: '.nvmrc'` (single
  source — the same file developers use).
- All `arduino/setup-protoc` steps pin `version: 29.3`.
- Rust: `rust-toolchain.toml` is authoritative; `dtolnay/rust-toolchain`
  remains the install action and cargo's `rust-toolchain.toml` resolution
  makes the effective toolchain `1.94.0`. The preflight catches drift if a
  workflow ever forces a different channel.

## Consequences

- A fresh checkout on any supported platform with the declared runtime
  installs and builds; an unsupported runtime (Node < 22.12.0, wrong
  lockfileVersion, missing protoc, rustc drift) fails fast with an actionable
  message before expensive builds.
- Bumping Node, protoc, or Rust is a deliberate, one-place change
  (`.nvmrc` / the protoc version pin / `rust-toolchain.toml`) plus the
  preflight's expectations; the preflight surfaces any half-done bump.
- No package publication or secret access occurs during validation; the
  preflight writes only workspace evidence.

## Upgrade ownership and cadence

- **Node**: bump within the 22 LTS family only; track Electron's declared
  `engines.node` (the floor). Bump `.nvmrc` + verify `engines.node` still
  matches Electron's requirement.
- **protoc**: bump CI pin and `bin/protoc` dotslash together; run
  `cargo check -p xai-grok-tools-api` to confirm the proto still compiles.
- **Rust**: bump `rust-toolchain.toml` `channel` one point version at a time,
  a couple of weeks after the release (per the existing rust-toolchain.toml
  comment); run `cargo check --all-targets --workspace` + `cargo clippy`.
- After any bump, the preflight (`npm run check:toolchain`) must pass locally
  and in CI before merge.
