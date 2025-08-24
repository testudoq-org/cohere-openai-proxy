#!/bin/sh
# verify-dist.sh - quick check that required runtime files exist in dist/prod (ESM-only)
set -e
if [ -z "$1" ]; then
  echo "Usage: $0 <dist-path>"
  exit 2
fi
DIST="$1"
MUST_HAVE_ESM="src/index.mjs src/vecdb/mockAdapter.mjs package.json"

for f in $MUST_HAVE_ESM; do
  if [ ! -f "$DIST/$f" ]; then
    echo "[ERROR] Missing required file: $DIST/$f"
    exit 2
  fi
done

echo "[OK] All required ESM files present in $DIST"
exit 0
