#!/bin/bash
# agent-video-engine-lab - local development start script
# Starts the inherited OpenReel browser editor (apps/web) via Vite.

set -e

echo "=== agent-video-engine-lab - Dev Setup ==="

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

# Build WASM modules if not built
if [ ! -d "packages/core/src/wasm/build" ]; then
  echo "Building WASM modules..."
  pnpm build:wasm
fi

echo "Starting dev server at http://localhost:5174"
pnpm dev -- --port 5174
