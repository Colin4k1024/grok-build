#!/bin/bash
set -euo pipefail
cd /Users/ailabuser1/Desktop/gitcode/grok-build
TS=$(date +%Y%m%d_%H%M%S)
LOG="/tmp/tauri-test-logs/test_$TS.log"
mkdir -p /tmp/tauri-test-logs

echo "=== Tauri Test Runner (session_search DISABLED) ==="
echo "Log: $LOG"

echo "[1] Cleanup..."
pkill -f "grok-build-desktop" 2>/dev/null || true
pkill -f "vite.*5173" 2>/dev/null || true
sleep 1
lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null || true
tmux kill-session -t tauri 2>/dev/null || true

echo "[2] Starting tauri dev (RUST_LOG=debug, GROK_SESSION_SEARCH=false)..."
tmux new-session -d -s tauri \
  "export RUST_BACKTRACE=full RUST_LOG=debug \
   GROK_SESSION_SEARCH=false \
   NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 \
   https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=http://127.0.0.1:7890 \
   && npx tauri dev 2>&1 | tee $LOG"

echo "[3] Waiting for build..."
for i in $(seq 1 60); do
  sleep 2
  if grep -q "Running.*grok-build-desktop" "$LOG" 2>/dev/null; then
    echo "  Launched after ${i}x2s"; break
  fi
  if grep -q "error\[" "$LOG" 2>/dev/null; then
    echo "  BUILD ERROR:"; grep "error\[" "$LOG" | head -5; exit 1
  fi
  [ $i -eq 60 ] && { echo "  TIMEOUT"; tail -20 "$LOG"; exit 1; }
done
sleep 4

echo "[4] Verify..."
PID=$(pgrep -f "grok-build-desktop" | head -1)
echo "  PID=$PID"
echo "  Vite=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' http://localhost:5173/ 2>/dev/null || echo 000)"
echo "  Window=$(osascript -e 'tell app "System Events" to tell proc "grok-build-desktop" to get title of win 1' 2>/dev/null || echo NONE)"

echo "[5] Focus + click New Session via AX..."
osascript -e 'tell app "System Events" to set frontmost of 1st proc whose name is "grok-build-desktop" to true' 2>/dev/null || true
sleep 2

# Click the "+ New Session" button
osascript << 'OSA'
tell application "System Events"
  tell process "grok-build-desktop"
    try
      set targetButton to first button of group 1 of group 2 of UI element 1 of scroll area 1 of group 1 of group 1 of window 1 whose title is "+ New Session"
      click targetButton
    end try
  end tell
end tell
OSA
echo "  Clicked + New Session"

echo "[6] Wait and check result..."
sleep 8
if ps -p $PID > /dev/null 2>&1; then
  echo "  ✓ App ALIVE after session creation!"
  echo "  Checking for session in log..."
  grep -E "CMD|BRIDGE|FE " "$LOG" | tail -10
else
  echo "  ✗ App CRASHED!"
  echo "  === Last 20 log lines ==="
  tail -20 "$LOG"
  echo "  === Crash report ==="
  ls -t ~/Library/Logs/DiagnosticReports/grok-build-desktop-*.ips 2>/dev/null | head -1
fi

echo ""
echo "=== DONE ==="
echo "Log: $LOG"
