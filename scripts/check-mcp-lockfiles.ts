#!/usr/bin/env npx tsx
/**
 * Validates that bundled TypeScript packages have a package-lock.json.
 *
 * Covers:
 * - All TypeScript MCPs under `resources/mcp/*` (original scope)
 * - `packages/browser-extension/` (added 2026-04-21 alongside the clean-install
 *   pipeline fix — `npm run package` now depends on this lockfile via
 *   `scripts/build-browser-extension.ts::ensureExtensionDeps()`)
 * - `scripts/rebel-cli/` (standalone published CLI package)
 *
 * Without a lockfile, `npm install` / `npm ci` cannot guarantee reproducible
 * dependency resolution — dev installs can drift from CI and from packaged
 * builds. For the browser extension specifically, a missing lockfile also
 * breaks the SHA-256 drift check in `ensureExtensionDeps()`.
 *
 * Run via: npx tsx scripts/check-mcp-lockfiles.ts
 * Part of validate:fast pipeline.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const mcpRoot = join(repoRoot, 'resources', 'mcp');
const browserExtensionDir = join(repoRoot, 'packages', 'browser-extension');
const rebelCliDir = join(repoRoot, 'scripts', 'rebel-cli');

interface MissingLockfile {
  label: string;
  fixCommand: string;
}

function main(): void {
  console.log('🔒 Lockfile Presence Check (bundled TS packages)');
  console.log('================================================\n');

  const missing: MissingLockfile[] = [];

  // 1) TypeScript MCPs under resources/mcp/*
  if (existsSync(mcpRoot)) {
    for (const name of readdirSync(mcpRoot).sort()) {
      const mcpDir = join(mcpRoot, name);
      if (!statSync(mcpDir).isDirectory()) continue;
      if (!existsSync(join(mcpDir, 'package.json'))) continue;
      if (!existsSync(join(mcpDir, 'tsconfig.json'))) continue; // only TS MCPs need builds

      if (!existsSync(join(mcpDir, 'package-lock.json'))) {
        missing.push({
          label: `resources/mcp/${name}/`,
          fixCommand: `cd resources/mcp/${name} && npm install --package-lock-only`,
        });
      }
    }
  } else {
    console.log('⏭️  resources/mcp not found — skipping MCP check\n');
  }

  // 2) packages/browser-extension/ — depends on its lockfile for ensureExtensionDeps()
  if (existsSync(join(browserExtensionDir, 'package.json'))) {
    if (!existsSync(join(browserExtensionDir, 'package-lock.json'))) {
      missing.push({
        label: 'packages/browser-extension/',
        fixCommand: 'cd packages/browser-extension && npm install --package-lock-only',
      });
    }
  }

  // 3) scripts/rebel-cli/ — published CLI package; publish CI runs npm ci here
  if (existsSync(join(rebelCliDir, 'package.json'))) {
    if (!existsSync(join(rebelCliDir, 'package-lock.json'))) {
      missing.push({
        label: 'scripts/rebel-cli/',
        fixCommand: 'cd scripts/rebel-cli && npm install --package-lock-only',
      });
    }
  }

  if (missing.length === 0) {
    console.log('✅ All bundled TypeScript packages have lockfiles\n');
    return;
  }

  console.error(`❌ ${missing.length} package(s) missing package-lock.json:\n`);
  for (const item of missing) {
    console.error(`   - ${item.label}`);
    console.error(`     Fix: ${item.fixCommand}\n`);
  }
  console.error('Without a lockfile, npm install resolves latest versions which can');
  console.error('differ between local dev and cloud builds (dev/prod parity hazard).\n');
  process.exit(1);
}

main();
