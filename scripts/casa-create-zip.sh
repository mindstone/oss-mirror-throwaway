#!/bin/bash
# Creates a ZIP file for CASA Tier 2 SAST scan submission
# Excludes: node_modules, build artifacts, secrets, editor configs, AI agent files
#
# Usage: ./scripts/casa-create-zip.sh
# Output: casa/mindstone-rebel-source-for-casa.zip

set -e

cd "$(dirname "$0")/.."

OUTPUT_DIR="casa"
OUTPUT_FILE="$OUTPUT_DIR/mindstone-rebel-source-for-casa.zip"

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

zip -r "$OUTPUT_FILE" . \
  -x "node_modules/*" \
  -x ".git/*" \
  -x "out/*" \
  -x "dist/*" \
  -x "build/*" \
  -x "release/*" \
  -x "coverage/*" \
  -x ".env" \
  -x ".env.*" \
  -x "*.log" \
  -x "logs/*" \
  -x "tmp/*" \
  -x "temp/*" \
  -x ".cache/*" \
  -x ".factory/*" \
  -x ".vite/*" \
  -x ".turbo/*" \
  -x ".eslintcache" \
  -x ".stylelintcache" \
  -x "*.tsbuildinfo" \
  -x "*.tsbuildinfo.*" \
  -x ".nyc_output/*" \
  -x ".jest/*" \
  -x "test-results/*" \
  -x ".idea/*" \
  -x ".vscode/*" \
  -x ".cursor/*" \
  -x "*.dmg" \
  -x "*.exe" \
  -x "*.app" \
  -x "*.msi" \
  -x "*.deb" \
  -x "*.rpm" \
  -x "*.AppImage" \
  -x "*.asar" \
  -x "*.asar.unpacked/*" \
  -x "*.code-workspace" \
  -x ".DS_Store" \
  -x "._*" \
  -x "Thumbs.db" \
  -x "AGENTS.md" \
  -x "AGENTS-for-runtime.md" \
  -x "CLAUDE.md" \
  -x "config/app-config.json" \
  -x "gjdutils/*" \
  -x "docs-private/investigations/*" \
  -x "docs-private/reports/code-health/*.html" \
  -x "rebel-system/.git/*" \
  -x "rebel-system/AGENTS.md" \
  -x "rebel-system/CLAUDE.md" \
  -x "super-mcp/.git/*" \
  -x "super-mcp/node_modules/*" \
  -x "super-mcp/dist/*" \
  -x "super-mcp/AGENTS.md" \
  -x "super-mcp/CLAUDE.md" \
  -x "resources/mcp/*/node_modules/*" \
  -x "resources/mcp/*/build/*" \
  -x "resources/node-bundle/*" \
  -x "resources/git-bundle/*" \
  -x "scripts/*" \
  -x "casa/*"

echo ""
echo "=== Zip Created ==="
echo "Output: $OUTPUT_FILE"
echo "Size:   $(ls -lh "$OUTPUT_FILE" | awk '{print $5}')"
