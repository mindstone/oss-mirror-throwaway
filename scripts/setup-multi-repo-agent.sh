#!/bin/bash
#
# Setup script to enable Factory agents to work across both rebel-app and rebel-platform
#
# This creates symlinks in the parent mindstone/ directory pointing to rebel-app's:
# - coding-agent-instructions/ (shared coding principles)
# - .factory/droids/ (custom subagents)
#
# It also creates a lightweight AGENTS.md that directs agents to read repo-specific instructions.
#
# Usage: ./scripts/setup-multi-repo-agent.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REBEL_DIR="$(dirname "$SCRIPT_DIR")"
PARENT_DIR="$(dirname "$REBEL_DIR")"

echo "Setting up multi-repo agent configuration..."
echo "  Source: $REBEL_DIR"
echo "  Target: $PARENT_DIR"
echo ""

# Create parent .factory directory if it doesn't exist
mkdir -p "$PARENT_DIR/.factory"

# Create symlink for coding-agent-instructions
echo "Creating symlink for coding-agent-instructions..."
if [ -L "$PARENT_DIR/coding-agent-instructions" ]; then
    rm "$PARENT_DIR/coding-agent-instructions"
elif [ -d "$PARENT_DIR/coding-agent-instructions" ]; then
    echo "  Warning: coding-agent-instructions exists as a directory, skipping..."
else
    ln -s "rebel-app/coding-agent-instructions" "$PARENT_DIR/coding-agent-instructions"
    echo "  Created: coding-agent-instructions -> rebel-app/coding-agent-instructions"
fi

# Create symlink for .factory/droids
echo "Creating symlink for .factory/droids..."
if [ -L "$PARENT_DIR/.factory/droids" ]; then
    rm "$PARENT_DIR/.factory/droids"
elif [ -d "$PARENT_DIR/.factory/droids" ]; then
    echo "  Warning: .factory/droids exists as a directory, removing..."
    rm -rf "$PARENT_DIR/.factory/droids"
fi
ln -s "../rebel-app/.factory/droids" "$PARENT_DIR/.factory/droids"
echo "  Created: .factory/droids -> ../rebel-app/.factory/droids"

# Create the parent AGENTS.md
echo "Creating parent AGENTS.md..."
cat > "$PARENT_DIR/AGENTS.md" << 'EOF'
# Multi-Repo Workspace: mindstone

This workspace contains multiple related repositories. When working here, you have access to:

## Repositories

### rebel-app/
Electron desktop app (React + TypeScript + Vite). The main Rebel AI assistant application.
- **Read**: `rebel-app/AGENTS.md` for repo-specific guidelines and detailed coding conventions

### rebel-platform/
Backend platform (Hono + React + Drizzle + Postgres). Authentication, user management, and platform services.
- **Read**: `rebel-platform/AGENTS.md` for repo-specific guidelines

## Shared Resources

- `coding-agent-instructions/` - Shared coding principles (symlinked from rebel-app)
- `.factory/droids/` - Custom subagents (symlinked from rebel-app)

## Instructions

**Before making any changes to a repository:**
1. Read that repository's `AGENTS.md` file for repo-specific conventions
2. Follow the coding principles in `coding-agent-instructions/AGENTS-BASE.md`

**When working across both repos:**
- rebel-app is the Electron client; rebel-platform is the backend
- They share authentication via better-auth (see `rebel-platform/docs/ELECTRON_AUTH.md`)
- Use consistent TypeScript patterns across both
EOF

echo ""
echo "Done! Parent directory configured with symlinks:"
echo ""
echo "  $PARENT_DIR/"
echo "    AGENTS.md                      <- Lightweight multi-repo instructions"
echo "    coding-agent-instructions/     -> rebel-app/coding-agent-instructions (symlink)"
echo "    .factory/"
echo "      droids/                      -> ../rebel-app/.factory/droids (symlink)"
echo ""
echo "Notes:"
echo "  - Symlinks mean changes in rebel-app are immediately available"
echo "  - Each repo's AGENTS.md provides repo-specific overrides"
echo "  - No need to re-run this script unless symlinks are broken"
