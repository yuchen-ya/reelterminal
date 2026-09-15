#!/bin/bash
# ReelTerminal - local development start script
# Starts the inherited OpenReel browser editor (apps/web) via Vite.

set -e

echo "=== ReelTerminal - Dev Setup ==="

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

# Build WASM modules if not built (build:wasm emits per-module outputs;
# check one real artifact — there is no single src/wasm/build directory)
if [ ! -f "packages/core/src/wasm/fft/build/fft.wasm" ]; then
  echo "Building WASM modules..."
  pnpm build:wasm
fi

echo "Starting dev server at http://localhost:5174"
pnpm dev -- --port 5174
