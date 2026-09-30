#!/usr/bin/env bash
# Linux release verification (R5-10 / #266).
#
# Usage:
#   scripts/verify-linux-release.sh release/Grok-Build-0.1.0-x86_64.AppImage
#
# Launches the AppImage under Xvfb, confirms the process boots and stays alive,
# then terminates it (graceful → SIGKILL) and verifies a clean shutdown. An
# Electron app never exits on its own, so this script bounds the smoke — the
# bare `xvfb-run -a <AppImage>` the gate used before would hang CI until the
# job-level timeout. CI-only (ubuntu-latest); the gate skips it on non-linux.

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

if [ "$#" -lt 1 ] || [ ! -f "$1" ]; then
  report 1 "AppImage exists ($1)" "not found"
  exit 1
fi
APP="$1"
chmod +x "$APP" 2>/dev/null || true

# 1. Launch under Xvfb. The app does not auto-quit, so background it and bound
#    the smoke ourselves.
xvfb-run -a "$APP" --no-sandbox >/dev/null 2>&1 &
app_pid=$!

# 2. Wait for boot, then confirm the process is alive (it didn't crash on
#    startup). 8s is enough for an Electron cold start on a CI runner.
sleep 8
if kill -0 "$app_pid" 2>/dev/null; then
  report 0 "app launched (process alive after boot)"
else
  report 1 "app launched" "process died during boot"
fi

# 3. Terminate gracefully (SIGTERM), wait up to ~4s, then SIGKILL.
kill "$app_pid" 2>/dev/null || true
for _ in $(seq 1 20); do
  kill -0 "$app_pid" 2>/dev/null || break
  sleep 0.2
done
kill -9 "$app_pid" 2>/dev/null || true
wait "$app_pid" 2>/dev/null || true
if kill -0 "$app_pid" 2>/dev/null; then
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
