# ADR 0008: Branch Protection + Emergency Bypass

Status: Accepted — R6-04 (#282), 2026-10-08

## Context

`main` was unprotected: force-pushes and branch deletion were allowed, and PRs
could merge without passing CI or a review. A red `main` accumulated after R5
closed. The repository had zero rulesets.

## Decision

Configure a repository ruleset `main-protection` (target: branch `main`,
enforcement: active) enforcing:

1. **Pull request required**: at least 1 approving review; stale reviews
   dismissed on push (a racing update invalidates earlier approvals).
2. **Required status checks** (strict): the head SHA must match the checked SHA,
   and these stable GitHub-hosted CI jobs must pass:
   - `Test + Typecheck + Build` (ci.yml frontend, ubuntu)
   - `Rust PTY controller (ubuntu-latest)` (ci.yml, ubuntu)
   - `Rust PTY controller (macos-latest)` (ci.yml, macos)
   
   The `Electron E2E (Playwright)` job is NOT a required check — it runs on a
   self-hosted runner (`[self-hosted, macos-selfhosted]`) whose availability is
   not guaranteed on every PR. Requiring it would block PR merges when the runner
   is offline. The e2e is monitored and its results are tracked in the release
   gate (R5-10 #266) before any tag release.
3. **Block deletion**: the `main` branch cannot be deleted.
4. **Block force-push** (non_fast_forward): history cannot be rewritten on main.
5. **No permanent bypass actors**: there are no standing bypass_actors.

### Emergency bypass procedure (time-bounded, auditable)

In a production-impacting incident where the ruleset blocks an urgent fix:

1. A repo admin temporarily sets the ruleset enforcement to `disabled` via
   `gh api -X PUT repos/Colin4k1024/grok-build/rulesets/<id> -f enforcement=disabled`.
2. The emergency disable MUST be linked to a GitHub Issue (incident report) with
   a time-bound (≤24h) re-enable commitment.
3. After the fix merges, the admin re-enables enforcement (`active`) and the
   `check-branch-protection` script confirms the policy is restored.
4. The incident Issue is closed only after verification passes.

This is NOT a permanent bypass — the verifier (`scripts/check-branch-protection.mjs`)
asserts `bypass_actors` is empty, so a standing bypass would fail the check.

### Verification (`scripts/check-branch-protection.mjs`)

A pure-function verifier (`verifyRuleset`) + a live fetcher that queries the
ruleset via `gh api repos/.../rulesets` and checks: enforcement=active, targets
main, requires PR, required status checks configured + strict, blocks deletion,
blocks force-push, no bypass actors. 10 unit tests. Run via
`npm run check:branch-protection`. Supports `--ruleset-file` for offline/testable
verification.

## Consequences

- A PR cannot merge when a required check is red, skipped, or stale (strict
  policy: head SHA == checked SHA).
- Force-push and branch deletion are rejected on main.
- Two updates racing on one PR invalidate earlier approvals (stale review
  dismissal).
- The ruleset configuration can be exported (`gh api repos/.../rulesets`) and
  re-applied if accidentally edited.
- No production release, tag, or source rewrite occurs during verification.
