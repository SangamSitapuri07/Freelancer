#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5+ is required. Download it from https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22.5+ is required. You have $(node --version)." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --no-audit --no-fund
fi

if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
fi

echo "Starting GhostGate..."
echo "Dashboard: http://localhost:${PORT:-8080}"
exec node --disable-warning=ExperimentalWarning src/server.js
