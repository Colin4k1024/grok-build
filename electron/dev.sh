#!/bin/bash
# Simple dev runner for Electron. Starts vite in background, waits for the
# port, then starts Electron. Ctrl-C kills both.
set -e
cd "$(dirname "$0")/.."

echo "[1/3] Building Electron main+preload..."
bash electron/build.sh

echo "[2/3] Starting vite dev server on 5173..."
npm run dev > /tmp/electron-vite.log 2>&1 &
VITE_PID=$!

# Wait for the port (curl loops until 200)
echo "[3/3] Waiting for vite to be ready..."
for i in $(seq 1 30); do
  if curl -sS -o /dev/null --max-time 1 http://localhost:5173/ 2>/dev/null; then
    echo "  vite ready after ${i}s"
    break
  fi
  sleep 1
done

# Trap: kill vite when this script exits
trap "kill $VITE_PID 2>/dev/null || true" EXIT

echo "Starting Electron..."
VITE_DEV_SERVER_URL=http://localhost:5173 NODE_ENV=development npx electron .
