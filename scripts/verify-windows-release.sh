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

# 1. Silent install (NSIS /S /D=<dir>). MSYS converts leading-slash args passed
#    to native exes (the reason this file already uses `tasklist //FI`), so
#    disable arg conversion for the installer and give NSIS a native Windows
#    path (cygpath -w) — a POSIX mktemp path would make /D hang or fail.
MSYS2_ARG_CONV_EXCL='*' "$SETUP" /S "/D=$(cygpath -w "$INSTALL_DIR")" >/dev/null 2>&1
report $? "silent install" "NSIS setup exited non-zero"
APP_EXE="$INSTALL_DIR/$APP_NAME.exe"
[ -f "$APP_EXE" ]
report $? "installed app exists" "$APP_EXE missing after install"
# electron-builder's NSIS template names the uninstaller "Uninstall <product>.exe"
# (with the spaced productName), not uninstall.exe — glob for it so the
# uninstall step actually runs.
UNINSTALLER="$(find "$INSTALL_DIR" -maxdepth 1 -iname 'uninstall*.exe' | head -n1)"

# 2. Launch and confirm a process/window exists.
if [ -f "$APP_EXE" ]; then
  "$APP_EXE" >/dev/null 2>&1 &
  app_pid=$!
  # Give it a moment to boot, then look for the process by name (Windows tasklist).
  sleep 8
  tasklist //FI "IMAGENAME eq $(basename "$APP_EXE")" //NH 2>/dev/null | grep -qi "$(basename "$APP_EXE")"
  report $? "app launched (process present)" "no matching process after launch"

  # 3. Exit the app (kill the process tree), then verify it actually exited.
  # taskkill returns as soon as termination is initiated, but an Electron tree
  # takes a moment to tear down — poll like verify-linux-release.sh does, or a
  # loaded CI runner reports a flaky "still alive".
  taskkill //F //IM "$(basename "$APP_EXE")" //T >/dev/null 2>&1 || kill "$app_pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$app_pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$app_pid" 2>/dev/null; then
    report 1 "app exited" "process still alive after terminate"
  else
    report 0 "app exited"
  fi
fi

# 4. Silent uninstall + verify the install dir is gone. NSIS uninstallers can't
#    delete themselves while running: without _?= the process copies to %TEMP%,
#    re-executes the copy, and the INVOKED process exits immediately while the
#    copy deletes files ASYNCHRONOUSLY. A one-shot [ ! -f ] check races it and
#    fails every time (deletion of a few-hundred-MB dir is still in progress).
#    Poll for the app exe's removal with a timeout instead.
uninstall_rc=0
if [ -f "$UNINSTALLER" ]; then
  MSYS2_ARG_CONV_EXCL='*' "$UNINSTALLER" /S >/dev/null 2>&1
  uninstall_rc=$?
  report "$uninstall_rc" "silent uninstall" "uninstaller exited non-zero"
fi
cleaned=0
for _ in $(seq 1 100); do
  [ -f "$APP_EXE" ] || { cleaned=1; break; }
  sleep 0.3
done
# report: 0 = PASS. cleaned=1 means the app exe was removed (success).
if [ "$cleaned" -eq 1 ]; then
  report 0 "install dir cleaned"
else
  report 1 "install dir cleaned" "app still present after uninstall (polled ~30s)"
fi

if [ "$failures" -gt 0 ]; then
  echo "windows release verification FAILED ($failures checks)"
  exit 1
fi
echo "windows release verification OK"
exit 0
