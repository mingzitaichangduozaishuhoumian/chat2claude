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
export MOCK_BACKEND_MODELS_JSON="${MOCK_BACKEND_MODELS_JSON:-[{\"id\":\"backend-test-model\",\"displayName\":\"Backend Test Model\"}]}"

if [ -n "${API_KEYS:-}" ]; then
  echo "API_KEYS detected from existing environment; /v1/* will require one of those keys."
else
  echo "API_KEYS is not set. Open admin after startup to enable development access."
fi
echo "Starting API service at http://localhost:3000"
echo "Admin setup: http://localhost:3000/admin"
echo "Health check: http://localhost:3000/healthz"
exec corepack pnpm start
