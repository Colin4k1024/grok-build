#!/usr/bin/env bash
set -euo pipefail

# Pack TSP .grok-build/ output into a tar.gz archive compatible with
# grok-build's extract_bundle_archive() function.
#
# Archive structure:
#   bundle.json                        {"version":"<tsp-version>"}
#   skills/{name}/SKILL.md             (255 skill dirs)
#   subagents/agents/{name}.md         (24 agent files)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TSP_ROOT="${TSP_ROOT:-$(cd "$REPO_ROOT/../tsp" && pwd)}"
GROK_BUILD_DIR="$TSP_ROOT/.grok-build"
OUTPUT="$REPO_ROOT/crates/codegen/xai-grok-shell/tsp-bundle.tar.gz"

if [ ! -d "$GROK_BUILD_DIR/skills" ]; then
  echo "ERROR: $GROK_BUILD_DIR/skills not found."
  echo "Run: cd $TSP_ROOT && node scripts/grok/grok-packager.js"
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Extract version from provenance.json
TSP_VERSION=$(python3 -c "
import json, sys
with open('$GROK_BUILD_DIR/provenance.json') as f:
    print(json.load(f).get('tsp_version', '0.0.0'))
")

echo "Packing TSP bundle v${TSP_VERSION}..."

# Write bundle.json
echo "{\"version\":\"${TSP_VERSION}\"}" > "$TMPDIR/bundle.json"

# Copy skills (each as skills/{name}/SKILL.md)
mkdir -p "$TMPDIR/skills"
for skill_dir in "$GROK_BUILD_DIR/skills"/*/; do
  name=$(basename "$skill_dir")
  if [ -f "$skill_dir/SKILL.md" ]; then
    mkdir -p "$TMPDIR/skills/$name"
    cp "$skill_dir/SKILL.md" "$TMPDIR/skills/$name/SKILL.md"
  fi
done

# Copy agents (as subagents/agents/{name}.md)
mkdir -p "$TMPDIR/subagents/agents"
for agent_file in "$GROK_BUILD_DIR/agents"/*.md; do
  if [ -f "$agent_file" ]; then
    cp "$agent_file" "$TMPDIR/subagents/agents/"
  fi
done

# Create tar.gz
tar -czf "$OUTPUT" -C "$TMPDIR" .

SKILL_COUNT=$(find "$TMPDIR/skills" -name "SKILL.md" | wc -l | tr -d ' ')
AGENT_COUNT=$(find "$TMPDIR/subagents/agents" -name "*.md" | wc -l | tr -d ' ')
SIZE=$(du -h "$OUTPUT" | cut -f1)

echo "Done: $OUTPUT ($SIZE)"
echo "  Skills: $SKILL_COUNT"
echo "  Agents: $AGENT_COUNT"
echo "  Version: $TSP_VERSION"
