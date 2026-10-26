#!/usr/bin/env bash
set -euo pipefail

# GitHub Pages needs only the game runtime. Keep Worker source, tests, patch archives,
# developer tools and repository history out of the public web artifact.
rm -rf dist
mkdir -p dist
cp index.html dist/
cp -R assets src staging dist/
touch dist/.nojekyll

test -f dist/index.html
test -f dist/staging/index.html
test -f dist/staging/audience.html
test -d dist/assets
test -d dist/src
test -d dist/staging
test ! -e dist/worker
test ! -e dist/tests
test ! -e dist/tools

if find dist -type f \( -name '*.zip' -o -name '*.patch' \) -print -quit | grep -q .; then
  echo "Unexpected patch/archive file found in the public Pages artifact."
  exit 1
fi

echo "Minimal Pages artifact is ready: index.html, assets/, src/ and staging/."
