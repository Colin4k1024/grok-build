#!/usr/bin/env bash
# Release checksum generator (R3-13).
# Run after `npm run electron:pack` to produce SHA256 checksums and an
# SBOM manifest for the release artifacts.
#
# Usage: bash scripts/release-checksums.sh [release_dir]
#
# Outputs:
#   <release_dir>/checksums.sha256   — one line per artifact
#   <release_dir>/sbom.json          — software bill of materials
#   <release_dir>/release.json       — release manifest (version, channel, artifacts)

set -euo pipefail

RELEASE_DIR="${1:-release}"
GIT_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
GIT_TAG=$(git describe --tags --exact-match 2>/dev/null || echo "unknown")
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p "$RELEASE_DIR"

echo "==> Generating SHA256 checksums..."
cd "$RELEASE_DIR"
if ls *.dmg *.zip *.exe *.AppImage *.deb *.rpm 2>/dev/null | head -1 > /dev/null; then
  shasum -a 256 *.dmg *.zip *.exe *.AppImage *.deb *.rpm 2>/dev/null > checksums.sha256 || true
  echo "    checksums.sha256 written"
else
  echo "    No artifacts found in $RELEASE_DIR — skipping"
fi

cd - > /dev/null

echo "==> Generating SBOM..."
cat > "$RELEASE_DIR/sbom.json" << SBOMEOF
{
  "name": "grok-build-desktop",
  "version": "${VERSION}",
  "timestamp": "${TIMESTAMP}",
  "git_sha": "${GIT_SHA}",
  "git_tag": "${GIT_TAG}",
  "runtime": {
    "electron": "$(node -p "require('electron/package.json').version" 2>/dev/null || echo "unknown")",
    "node": "$(node -v)",
    "platform": "$(uname -sm)"
  },
  "artifacts": $(node -e "
    const fs = require('fs');
    const path = require('path');
    const dir = '$RELEASE_DIR';
    const files = fs.readdirSync(dir).filter(f =>
      /\\.(dmg|zip|exe|AppImage|deb|rpm|blockmap|yml)\$/.test(f)
    );
    console.log(JSON.stringify(files));
  " 2>/dev/null || echo "[]")
}
SBOMEOF
echo "    sbom.json written"

echo "==> Generating release manifest..."
cat > "$RELEASE_DIR/release.json" << RELEOF
{
  "version": "${VERSION}",
  "channel": "stable",
  "git_sha": "${GIT_SHA}",
  "timestamp": "${TIMESTAMP}",
  "notes": "See CHANGELOG.md for this version.",
  "signatures": {
    "macos": "signing requires Apple Developer certificate (not available in CI)",
    "windows": "signing requires EV Code Signing certificate (not available in CI)",
    "linux": "not required (no notarization on Linux)"
  },
  "artifacts_url": "https://github.com/Colin4k1024/grok-build/releases/tag/v${VERSION}"
}
RELEOF
echo "    release.json written"

echo ""
echo "Done. Artifacts:"
ls -la "$RELEASE_DIR"/*.sha256 "$RELEASE_DIR"/*.json 2>/dev/null || echo "    (no artifacts to checksum)"