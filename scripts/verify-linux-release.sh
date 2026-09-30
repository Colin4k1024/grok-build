#!/usr/bin/env bash
# Linux release verification (R5-10 / #266).
#
# Usage:
#   scripts/verify-linux-release.sh release/Grok-Build-0.1.0-x86_64.AppImage
#
# Launches the AppImage (under a dedicated Xvfb when headless, or on the real
# DISPLAY when present), confirms the process boots and stays alive, then
# terminates it and verifies a clean shutdown. An Electron app never exits on
# its own, so this smoke bounds the smoke — the bare `xvfb-run -a <AppImage>` would
# hang CI until the job-level timeout. CI-only (ubuntu-latest); the gate skips
# it on non-linux. The app is launched DIRECTLY (not via the xvfb-run wrapper)
# so app_pid is the real Electron process — the wrapper's PID made the exit
# check vacuous and a SIGKILL of the wrapper orphaned Xvfb + the app.
#
# Type-2 AppImages need libfuse.so.2 at runtime, which ubuntu-24.04 runners
# don't pre-install; when it's absent the runtime falls back to extract-and-run
# (squashfs unpacked under /tmp) so the smoke dies on the APP, not on FUSE.

set -u

failures=0
APP_PID=""
XVFB_PID=""
report() { # report <ok> <label> [detail]
  if [ "$1" -eq 0 ]; then
    echo "PASS $2"
  else
    echo "FAIL $2${3:+ — $3}"
    failures=$((failures + 1))
  fi
}

cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$APP_PID" ] && kill -9 "$APP_PID" 2>/dev/null || true
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true
  [ -n "${BOOT_LOG:-}" ] && rm -f "$BOOT_LOG" 2>/dev/null || true
}
trap cleanup EXIT

if [ "$#" -lt 1 ] || [ ! -f "$1" ]; then
  report 1 "AppImage exists ($1)" "not found"
  exit 1
fi
APP="$1"
chmod +x "$APP" 2>/dev/null || true

# 1. Start a dedicated Xvfb when headless (no DISPLAY), so app_pid is the real
#    Electron process — not the xvfb-run wrapper PID. A real DISPLAY (local
#    desktop) launches the app directly.
if [ -z "${DISPLAY:-}" ]; then
  if ! command -v Xvfb >/dev/null 2>&1; then
    report 1 "app launched" "no DISPLAY and no Xvfb — cannot launch headless"
    exit 1
  fi
  d=99
  while [ -e "/tmp/.X11-unix/X$d" ]; do d=$((d + 1)); done
  Xvfb ":$d" >/dev/null 2>&1 &
  XVFB_PID=$!
  export DISPLAY=":$d"
  sleep 1
fi

# 1b. Type-2 AppImage runtime dlopens libfuse.so.2; ubuntu-latest doesn't ship
#     it, and the old `>/dev/null 2>&1` swallow made the dlopen error
#     invisible ("process died during boot" with no cause). Extract-and-run
#     is the runtime's own fallback — set the env var, keep boot output in a
#     log and print it ONLY on failure.
if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  export APPIMAGE_EXTRACT_AND_RUN=1
  echo "NOTE libfuse.so.2 not present — running in extract-and-run mode"
fi
BOOT_LOG="$(mktemp /tmp/gb-linux-smoke.XXXXXX.log)"
"$APP" --no-sandbox >"$BOOT_LOG" 2>&1 &
APP_PID=$!

# 2. Wait for boot, then confirm the process is alive (it didn't crash on
#    startup). 8s is enough for an Electron cold start on a CI runner.
sleep 8
if kill -0 "$APP_PID" 2>/dev/null; then
  report 0 "app launched (process alive after boot)"
else
  report 1 "app launched" "process died during boot — last output:"
  tail -n 20 "$BOOT_LOG" 2>/dev/null || true
fi

# 3. Terminate gracefully (SIGTERM), wait up to ~4s, then SIGKILL. APP_PID is
#    the real Electron process, so this check is meaningful (not the wrapper).
kill "$APP_PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$APP_PID" 2>/dev/null || break
  sleep 0.2
done
kill -9 "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true
if kill -0 "$APP_PID" 2>/dev/null; then
  report 1 "app exited (terminated cleanly)" "process still alive"
else
  report 0 "app exited (terminated cleanly)"
fi

if [ "$failures" -gt 0 ]; then
  echo "linux release verification FAILED ($failures checks)"
  exit 1
fi
echo "linux release verification OK"
exit 0
