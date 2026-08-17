#!/usr/bin/env sh
set -e

cd "$(dirname "$0")"

echo "Enabling corepack..."
corepack enable

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  corepack pnpm install
fi

export DEFAULT_REASONING_EFFORT="${DEFAULT_REASONING_EFFORT:-medium}"
export DEFAULT_RESPONSE_SPEED="${DEFAULT_RESPONSE_SPEED:-balanced}"
export PORT="${PORT:-3000}"
export HOST="${HOST:-127.0.0.1}"
export CHATGPT_BACKEND="${CHATGPT_BACKEND:-session}"

if [ -n "${API_KEYS:-}" ]; then
  echo "API_KEYS detected from existing environment; /v1/* will require one of those keys."
else
  echo "API_KEYS is not set. Open admin and click \"授权 ChatGPT\" to generate a runtime key."
fi
if [ "${HOST}" = "0.0.0.0" ]; then
  echo "HOST=0.0.0.0 exposes the service on your LAN; set API_KEYS before enabling LAN/public access."
fi
echo "CHATGPT_BACKEND=${CHATGPT_BACKEND}"
echo "Starting API service at http://${HOST}:${PORT}"
echo "Admin setup: http://${HOST}:${PORT}/admin  <-- click \"授权 ChatGPT\""
echo "Health check: http://${HOST}:${PORT}/healthz"
exec corepack pnpm start
