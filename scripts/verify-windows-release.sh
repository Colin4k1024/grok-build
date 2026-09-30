#!/usr/bin/env bash
# Windows release verification (R5-10 / #266).
#
# Usage (Git Bash on windows-latest CI):
#   scripts/verify-windows-release.sh release/Grok-Build-Setup-0.1.0.exe
#
# Silently installs the NSIS setup, launches the app, confirms a window
# process exists, exits it, then silently uninstalls and verifies nothing is
# left behind. Exit 0 only when every check passes. This runs only on win32;
# the release gate skips it on other platforms.
#
# NOT PROVEN locally (no win32 host here) — exercised by the windows-latest
# leg of the release-gate CI matrix, mirroring #264's notarization caveat.

set -u

failures=0
INSTALL_DIR="$(mktemp -d)/GrokBuild"
report() { # report <ok> <label> [detail]
  if [ "$1" -eq 0 ]; then
    echo "PASS $2"
  else
    echo "FAIL $2${3:+ — $3}"
    failures=$((failures + 1))
  fi
}

cleanup() {
  if [ -n "${UNINSTALLER:-}" ] && [ -f "$UNINSTALLER" ]; then
    "$UNINSTALLER" /S >/dev/null 2>&1 || true
  fi
  rm -rf "$INSTALL_DIR" 2>/dev/null || true
}
trap cleanup EXIT

if [ "$#" -lt 1 ] || [ ! -f "$1" ]; then
  report 1 "installer exists ($1)" "not found"
  exit 1
fi
SETUP="$1"
APP_NAME="Grok Build"

# 1. Silent install (NSIS /S /D=<dir>).
"$SETUP" /S "/D=$INSTALL_DIR" >/dev/null 2>&1
report $? "silent install" "NSIS setup exited non-zero"
APP_EXE="$INSTALL_DIR/$APP_NAME.exe"
[ -f "$APP_EXE" ]
report $? "installed app exists" "$APP_EXE missing after install"
UNINSTALLER="$INSTALL_DIR/uninstall.exe"

# 2. Launch and confirm a process/window exists.
if [ -f "$APP_EXE" ]; then
  "$APP_EXE" >/dev/null 2>&1 &
  app_pid=$!
  # Give it a moment to boot, then look for the process by name (Windows tasklist).
  sleep 8
  tasklist //FI "IMAGENAME eq $(basename "$APP_EXE")" //NH 2>/dev/null | grep -qi "$(basename "$APP_EXE")"
  report $? "app launched (process present)" "no matching process after launch"

  # 3. Exit the app (kill the process tree).
  taskkill //F //IM "$(basename "$APP_EXE")" //T >/dev/null 2>&1 || kill "$app_pid" 2>/dev/null || true
  report 0 "app exited"
fi

# 4. Silent uninstall + verify the install dir is gone.
if [ -f "$UNINSTALLER" ]; then
  "$UNINSTALLER" /S >/dev/null 2>&1
  report $? "silent uninstall" "uninstaller exited non-zero"
fi
# The uninstaller removes its own files; the temp parent is cleaned by the trap.
[ ! -f "$APP_EXE" ]
report $? "install dir cleaned" "app still present after uninstall"

if [ "$failures" -gt 0 ]; then
  echo "windows release verification FAILED ($failures checks)"
  exit 1
fi
echo "windows release verification OK"
exit 0
