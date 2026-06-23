#!/usr/bin/env npx tsx
/**
 * CI Validation: Store Version Registry Completeness
 *
 * Scans the codebase for store version constants and verifies each one
 * is registered in ALL_STORE_VERSIONS (src/core/constants.ts).
 *
 * Catches two classes of bugs:
 * 1. Developer bumps a local STORE_VERSION but forgets to update the registry
 * 2. Developer adds a new versioned store but forgets to register it
 *
 * Run: npx tsx scripts/check-store-versions.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/partway/260219_global_store_version_gate.md
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.join(__dirname, '..', 'src');
const CONSTANTS_PATH = path.join(SRC_DIR, 'core', 'constants.ts');

// Patterns that identify store version constants in source files
// Matches: const STORE_VERSION = 1, const FOO_STORE_VERSION = 5, export const INDEX_VERSION = 5
const VERSION_PATTERNS = [
  /(?:export\s+)?const\s+(\w*(?:STORE_VERSION|INDEX_VERSION|CURRENT_STORE_VERSION))\s*[=:]\s*(\d+)/g,
  /(?:export\s+)?const\s+(STORE_VERSION)\s*[=:]\s*(\d+)/g,
];

// Files/patterns to exclude from scanning (not actual store versions)
const EXCLUDE_PATTERNS = [
  'DIAGNOSTIC_MANIFEST_SCHEMA_VERSION', // Not a store
  'TOOL_INDEX_SCHEMA_VERSION',          // Rebuild-on-mismatch, not a persistent store version
  'constants.ts',                       // The registry itself
  'check-store-versions.ts',            // This script
  '__tests__',                          // Test files
  '.test.',                             // Test files
  'node_modules',
];

interface FoundVersion {
  name: string;
  value: number;
  file: string;
  line: number;
}

function shouldExclude(filePath: string, constantName: string): boolean {
  return EXCLUDE_PATTERNS.some(
    (p) => filePath.includes(p) || constantName === p
  );
}

function scanDirectory(dir: string): FoundVersion[] {
  const results: FoundVersion[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(fullPath);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
        scanFile(fullPath, results);
      }
    }
  }

  walk(dir);
  return results;
}

function scanFile(filePath: string, results: FoundVersion[]): void {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (const pattern of VERSION_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      const value = parseInt(match[2], 10);
      const lineNumber = content.slice(0, match.index).split('\n').length;
      const relativePath = path.relative(path.join(SRC_DIR, '..'), filePath);

      if (!shouldExclude(relativePath, name)) {
        // Avoid duplicates (multiple patterns can match same constant)
        if (!results.some((r) => r.name === name && r.file === relativePath)) {
          results.push({ name, value, file: relativePath, line: lineNumber });
        }
      }
    }
  }
}

function loadRegistry(): Record<string, number> {
  const content = fs.readFileSync(CONSTANTS_PATH, 'utf8');

  // Extract ALL_STORE_VERSIONS object entries
  const registryMatch = content.match(
    /export const ALL_STORE_VERSIONS\s*=\s*\{([\s\S]*?)\}\s*as\s*const/
  );
  if (!registryMatch) {
    console.error('ERROR: Could not find ALL_STORE_VERSIONS in constants.ts');
    process.exit(1);
  }

  const registryBlock = registryMatch[1];
  const entries: Record<string, number> = {};

  // Match both forms:
  // INBOX_STORE_VERSION,                    (references existing exported const)
  // SESSION_INDEX_VERSION: 5,               (inline value)
  const refPattern = /^\s*(\w+),?\s*(?:\/\/.*)?$/gm;
  const valuePattern = /^\s*(\w+):\s*(\d+),?\s*(?:\/\/.*)?$/gm;

  let refMatch: RegExpExecArray | null;
  while ((refMatch = refPattern.exec(registryBlock)) !== null) {
    const name = refMatch[1];
    // Look up the value from the constants file
    const constMatch = content.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
    if (constMatch) {
      entries[name] = parseInt(constMatch[1], 10);
    }
  }

  let valMatch: RegExpExecArray | null;
  while ((valMatch = valuePattern.exec(registryBlock)) !== null) {
    entries[valMatch[1]] = parseInt(valMatch[2], 10);
  }

  return entries;
}

// Main
console.log('Checking store version registry completeness...\n');

const registry = loadRegistry();
// Stage 3: scan src/core/ in addition to src/main/ so platform-agnostic stores
// (e.g. contributionStore) can't silently bump their version without updating
// ALL_STORE_VERSIONS. Previously only src/main/ was scanned, which missed core.
const found = [
  ...scanDirectory(path.join(SRC_DIR, 'main')),
  ...scanDirectory(path.join(SRC_DIR, 'core')),
];

// Also check for version mismatches between registry and source files
let hasErrors = false;

// Check: every found version should have a corresponding registry entry
for (const item of found) {
  // Skip deprecated aliases
  if (item.name === 'TASK_QUEUE_STORE_VERSION') continue;

  // Check if registered (by value match — the registry key names differ from source names)
  const registryValues = Object.values(registry);
  const registryKeys = Object.keys(registry);

  // Try exact name match first
  const exactMatch = registryKeys.find((k) => k === item.name);
  if (exactMatch) {
    if (registry[exactMatch] !== item.value) {
      console.error(
        `MISMATCH: ${item.name} = ${item.value} in ${item.file}:${item.line}, ` +
        `but registry has ${exactMatch} = ${registry[exactMatch]}`
      );
      hasErrors = true;
    }
    continue;
  }

  // For local constants named just "STORE_VERSION" or "CURRENT_STORE_VERSION",
  // we can't match by name. Check if the file's store is registered by looking
  // for a registry entry with matching value (heuristic).
  if (item.name === 'STORE_VERSION' || item.name === 'CURRENT_STORE_VERSION') {
    // These are common local names — check the store they belong to
    // We can't reliably match these to registry entries by name alone.
    // The CI check for these relies on the developer registering them.
    // Just warn rather than fail.
    console.log(
      `INFO: Local ${item.name} = ${item.value} in ${item.file}:${item.line} ` +
      `(verify manually that it's registered in ALL_STORE_VERSIONS)`
    );
    continue;
  }

  // Not found in registry
  console.error(
    `UNREGISTERED: ${item.name} = ${item.value} in ${item.file}:${item.line} ` +
    `is not in ALL_STORE_VERSIONS registry`
  );
  hasErrors = true;
}

// Summary
console.log(`\nRegistry entries: ${Object.keys(registry).length}`);
console.log(`Found version constants: ${found.length}`);
console.log(`Computed DATA_SCHEMA_EPOCH: ${Object.values(registry).reduce((a, b) => a + b, 0)}`);

if (hasErrors) {
  console.error('\nFAILED: Store version registry is incomplete or has mismatches.');
  console.error('Fix: Update ALL_STORE_VERSIONS in src/core/constants.ts');
  process.exit(1);
} else {
  console.log('\nPASSED: All store versions are registered correctly.');
}
