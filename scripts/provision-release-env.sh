#!/usr/bin/env bash
# Provision the protected `release` environment (R6-05 / #283).
#
# Idempotent (PUT) — safe to re-run. Requires `gh` auth with admin on the repo.
# Creates the `release` environment with a required reviewer (repo owner) so
# fork/PR/manual smoke jobs — which never set `environment: release` — cannot
# access the signing secrets. State machine: unapproved -> approved(run-scoped)
# -> preflight; the environment's required-reviewer gate is the "approved"
# transition, and scripts/check-release-creds.mjs runs the preflight.
#
# The secret VALUES are not set here (they are the operator's Apple Developer /
# App Store Connect credentials). Set them via repo Settings → Environments →
# release → Secrets, or `gh secret set -e release CSC_LINK < value`. The
# required secret names + rotation owner are documented in
# docs/adr/0007-release-environment.md.
set -euo pipefail

REPO="${1:-Colin4k1024/grok-build}"
REVIEWER_ID="${2:-33594643}"   # Colin4k1024 (repo owner) as the required reviewer

echo "Provisioning 'release' environment on $REPO (required reviewer id=$REVIEWER_ID)..."
gh api -X PUT "repos/$REPO/environments/release" --input - <<EOF
{"wait_timer":0,"reviewers":[{"type":"User","id":$REVIEWER_ID}]}
EOF

echo
echo "✓ 'release' environment provisioned with a required reviewer."
echo
echo "Required secrets to set in this environment (do NOT commit values):"
echo "  CSC_LINK          base64-encoded Apple Developer p12 (signing identity)"
echo "  CSC_KEY_PASSWORD  the p12 password"
echo "  APPLE_API_KEY     base64-encoded App Store Connect API key (.p8)"
echo "  APPLE_API_KEY_ID  10-char alphanumeric App Store Connect key ID"
echo "  APPLE_API_ISSUER  UUID App Store Connect issuer ID"
echo
echo "Rotation owner: grok-build-release. Cadence: per Apple Developer /"
echo "App Store Connect key-expiry policy. The preflight"
echo "(scripts/check-release-creds.mjs) verifies presence + format without"
echo "ever printing a value."
