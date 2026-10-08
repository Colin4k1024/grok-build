# ADR 0007: Protected Release Environment + Credential Preflight

Status: Accepted — R6-05 (#283), 2026-10-08

## Context

The electron.yml release-mac / release-gate jobs reference `environment: release`
(tag-only, `if: startsWith(github.ref, 'refs/tags/v')`), but the repository had
ZERO configured environments — the `release` environment didn't exist, so its
secrets were unprovisioned and there was no approval gate. The inline signing
preflight (#264) checked only presence, inlined in the workflow, with no format
validation, no redaction test, and no centralized definition of the required
secret names + rotation owner.

## Decision

Provision a least-privilege, human-approved `release` environment and a
centralized, redacted credential preflight.

### Environment (provision via `scripts/provision-release-env.sh`)

- `release` environment with a **required reviewer** (repo owner, id 33594643) —
  the "approved" transition in the state machine `unapproved -> approved(run-
  scoped) -> preflight`. A run targeting `environment: release` pauses for
  reviewer approval before any secret is injected.
- No deployment-branch policy (the workflow's `if: startsWith(github.ref,
  'refs/tags/v')` already gates tag-only); fork/PR/manual smoke jobs never set
  `environment: release`, so they cannot access the secrets.
- The provisioning script is idempotent (PUT); safe to re-run. The secret
  VALUES are not committed — they are the operator's Apple credentials, set via
  repo Settings → Environments → release → Secrets.

### Required secrets (names + rotation owner, never values)

| Secret | Format | Purpose |
|--------|--------|---------|
| CSC_LINK | base64 p12 blob (≥32 chars) | Apple Developer signing identity |
| CSC_KEY_PASSWORD | non-empty | p12 password |
| APPLE_API_KEY | base64 .p8 blob (≥32 chars) | App Store Connect API key |
| APPLE_API_KEY_ID | 8-14 char alphanumeric | App Store Connect key ID |
| APPLE_API_ISSUER | UUID/numeric (8-40 chars) | App Store Connect issuer ID |

Rotation owner: `grok-build-release`. Cadence: per Apple Developer / App Store
Connect key-expiry policy.

### Preflight (`scripts/check-release-creds.mjs`)

- Replaces the inline electron.yml preflight. Runs AFTER the environment
  approval (secrets are injected as env), checks presence + conservative format
  for all 5 secrets, and FAILS CLOSED on any missing/malformed secret before
  anything is packed.
- **Redaction invariant**: only secret NAMES + PASS/FAIL + a generic reason are
  ever printed — NEVER a value. Unit-tested (a real-looking value must not
  appear in any stdout/stderr/JSON path). `--json` emits a machine-readable
  report (names + pass/fail only).
- 8 tests; `realpath` main-guard so symlinked invocation still runs (no
  vacuous-pass exit 0).

## Consequences

- Unauthorized jobs (fork PR, manual smoke, non-tag push) cannot access the
  signing secrets — they don't use `environment: release`.
- A missing/malformed secret, a non-tag trigger, or a lack of reviewer approval
  fails closed without secret disclosure.
- Concurrent approvals are scoped to their runs; a cancelled preflight leaves no
  partial release artifact (nothing is published during the preflight) and can
  be safely rerun.
- No production Release, feed promotion, or credential mutation occurs during
  provisioning or preflight. Windows signing procurement is tracked separately
  (no Windows signing credentials are assumed here).
