#!/usr/bin/env bash
# Auto-format hook: runs the appropriate formatter on edited files.
# Triggered by PostToolUse on Edit/Write/SearchReplace.
#
# Input: GROK_TOOL_FILE_PATH env var (the file that was edited)
# Exit 0: success (formatter ran or skipped)
# Exit non-zero: formatter failed (reported to user but non-blocking)

set -euo pipefail

FILE="${GROK_TOOL_FILE_PATH:-}"
[ -z "$FILE" ] && exit 0
[ -f "$FILE" ] || exit 0

case "$FILE" in
  *.rs)
    command -v rustfmt >/dev/null 2>&1 && rustfmt --edition 2024 "$FILE" 2>/dev/null || true
    ;;
  *.go)
    command -v gofmt >/dev/null 2>&1 && gofmt -w "$FILE" 2>/dev/null || true
    ;;
  *.py)
    if command -v ruff >/dev/null 2>&1; then
      ruff format "$FILE" 2>/dev/null || true
    elif command -v black >/dev/null 2>&1; then
      black --quiet "$FILE" 2>/dev/null || true
    fi
    ;;
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.scss|*.html|*.md)
    if command -v prettier >/dev/null 2>&1; then
      prettier --write "$FILE" 2>/dev/null || true
    elif command -v biome >/dev/null 2>&1; then
      biome format --write "$FILE" 2>/dev/null || true
    fi
    ;;
  *.swift)
    command -v swift-format >/dev/null 2>&1 && swift-format --in-place "$FILE" 2>/dev/null || true
    ;;
  *.kt|*.kts)
    command -v ktfmt >/dev/null 2>&1 && ktfmt "$FILE" 2>/dev/null || true
    ;;
esac
