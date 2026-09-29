#!/usr/bin/env bash
# macOS release verification (R5-08 / #264).
#
# Usage:
#   scripts/verify-macos-release.sh path/to/Grok\ Build.app
#   scripts/verify-macos-release.sh release/Grok-Build-0.1.0-arm64.dmg
#
# A .dmg argument is mounted read-only and the INNER app is verified (the DMG
# wrapper itself is not signed-verifiable — the app inside is what Gatekeeper
# assesses). Exit 0 only when every check passes; nothing about credentials
# or keychains is ever printed.

set -u

failures=0
report() { # report <ok> <label> [detail]
  if [ "$1" -eq 0 ]; then
    echo "PASS $2"
  else
    echo "FAIL $2${3:+ — $3}"
    failures=$((failures + 1))
  fi
}

verify_app() {
  local app_path="$1"
  if [ ! -d "$app_path" ]; then
    report 1 "app exists at $app_path" "not found"
    return 1
  fi
  report 0 "app exists at $app_path"

  codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null 2>&1
  report $? "codesign --verify --deep --strict" "signature invalid or missing"

  spctl --assess --type execute --verbose=4 "$app_path" >/dev/null 2>&1
  report $? "spctl --assess (Gatekeeper)" "rejected by Gatekeeper (not notarized?)"

  xcrun stapler validate "$app_path" >/dev/null 2>&1
  report $? "stapler validate (notarization ticket stapled)" "no stapled ticket"
}

for tool in codesign spctl xcrun; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL required tool missing from PATH: $tool"
    exit 1
  fi
done

target="${1:-}"
if [ -z "$target" ]; then
  echo "usage: $0 <Grok Build.app | release.dmg>" >&2
  exit 1
fi

mounted=""
mnt=""
cleanup() {
  if [ -n "$mounted" ]; then
    hdiutil detach "$mounted" -force >/dev/null 2>&1 || true
  fi
  if [ -n "$mnt" ]; then
    rm -rf "$mnt" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM
if [[ "$target" == *.dmg ]]; then
  if [ ! -f "$target" ]; then
    echo "FAIL dmg not found: $target" >&2
    exit 1
  fi
  # Mount read-only into a private mount point; always detach on exit.
  mnt="$(mktemp -d -t gb-verify-dmg)"
  if hdiutil attach "$target" -nobrowse -readonly -mountpoint "$mnt" >/dev/null 2>&1; then
    mounted="$mnt"
    inner="$mnt/Grok Build.app"
    verify_app "$inner"
  else
    report 1 "mount dmg $target" "hdiutil attach failed"
  fi
else
  verify_app "$target"
fi

if [ -n "$mounted" ]; then
  hdiutil detach "$mounted" -force >/dev/null 2>&1 || true
fi

if [ "$failures" -gt 0 ]; then
  echo "macOS release verification FAILED ($failures check(s))" >&2
  exit 1
fi
echo "macOS release verification OK"
exit 0
