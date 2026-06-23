#!/bin/bash
set -e

echo "=== Mission Init: Migrate Bundled MCP Connectors ==="

# Install rebel-app dependencies
cd /Users/you/development/desktop/rebel-app-1
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing rebel-app dependencies..."
  npm ci
fi

# Ensure mcp-servers repo is on main branch
cd /Users/you/development/mcp-servers
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "Switching mcp-servers to main branch (currently on $CURRENT_BRANCH)..."
  git stash 2>/dev/null || true
  git checkout main
fi

echo "=== Init complete ==="
