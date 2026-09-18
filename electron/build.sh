#!/bin/bash
set -e
cd "$(dirname "$0")/.."
rm -rf dist-electron
npx tsc -p electron/tsconfig.json
mv dist-electron/main.js dist-electron/main.cjs
mv dist-electron/preload.js dist-electron/preload.cjs
# package.json has "type": "module", so every CJS output must use .cjs.
# Rename any additional compiled units and fix up require() paths.
for f in dist-electron/*.js; do
  [ -e "$f" ] || continue
  mv "$f" "${f%.js}.cjs"
done
# BSD sed (macOS) needs an explicit empty backup arg after -i; GNU sed (Linux
# CI) treats that arg as the script — detect and use the right form.
if sed --version >/dev/null 2>&1; then
  sed -i -E 's|require\("\./([a-zA-Z0-9_-]+)"\)|require("./\1.cjs")|g' dist-electron/*.cjs
else
  sed -i '' -E 's|require\("\./([a-zA-Z0-9_-]+)"\)|require("./\1.cjs")|g' dist-electron/*.cjs
fi
echo "✓ Electron main+preload built to dist-electron/"
