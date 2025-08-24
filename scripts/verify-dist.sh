#!/bin/sh
# verify-dist.sh - quick check that required runtime files exist in dist/prod
set -e
MUST_HAVE="index.js memoryCache.js ragDocumentManager.js conversationManager.js package.json"
for f in $MUST_HAVE; do
  if [ ! -f "$1/$f" ]; then
    echo "[ERROR] Missing required file: $1/$f"
    exit 2
  fi
done
echo "[OK] All required files present in $1"
exit 0
