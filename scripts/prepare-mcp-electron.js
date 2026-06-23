#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const builtPreloadPath = path.join(projectRoot, 'out', 'preload', 'index.js');
const targetPreloadPath = path.join(projectRoot, 'out', 'main', 'preload.js');

if (!fs.existsSync(builtPreloadPath)) {
  console.error('[prepare-mcp-electron] Missing preload bundle:', builtPreloadPath);
  process.exit(1);
}

try {
  fs.copyFileSync(builtPreloadPath, targetPreloadPath);
  console.log('[prepare-mcp-electron] Copied preload bundle to', targetPreloadPath);
} catch (error) {
  console.error('[prepare-mcp-electron] Failed to copy preload bundle:', error.message);
  process.exit(1);
}

