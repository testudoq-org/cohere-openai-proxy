#!/usr/bin/env bash
# Minimal repro: call local router /chat/completions forwarding to Cohere
set -euo pipefail

# Use environment variable ROUTER_BASE (default http://localhost:3000)
ROUTER_BASE=${ROUTER_BASE:-http://localhost:3000}
MODEL=${MODEL:-command-a-vision-07-2025}

# Proper JSON payload (expected by router)
PAYLOAD=$(cat <<JSON
{
  "messages": [{ "role": "user", "content": "What is a firewall?" }],
  "model": "${MODEL}"
}
JSON
)

echo "POST ${ROUTER_BASE}/chat/completions with model=${MODEL}"
curl -v -sS -X POST "${ROUTER_BASE}/chat/completions" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"

# Also test using model alias command-r
MODEL=command-r
PAYLOAD=$(cat <<JSON
{
  "messages": [{ "role": "user", "content": "What is a firewall?" }],
  "model": "${MODEL}"
}
JSON
)

echo "\nPOST ${ROUTER_BASE}/chat/completions with model=${MODEL}"
curl -v -sS -X POST "${ROUTER_BASE}/chat/completions" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
