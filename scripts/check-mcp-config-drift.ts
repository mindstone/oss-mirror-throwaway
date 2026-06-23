#!/usr/bin/env npx tsx
/**
 * Validates that scripts/mcp-config.json stays in sync with resources/mcp/.
 *
 * Checks both directions:
 * 1. TypeScript MCPs on disk that are missing from bundledMcps (and not in ALWAYS_UNBUNDLED)
 * 2. Entries in bundledMcps that don't exist on disk
 *
 * Run via: npx tsx scripts/check-mcp-config-drift.ts
 * Part of validate:fast pipeline.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const mcpRoot = join(__dirname, '..', 'resources', 'mcp');
const configPath = join(__dirname, 'mcp-config.json');

function main(): void {
  console.log('🔗 MCP Config Drift Check');
  console.log('=========================\n');

  if (!existsSync(mcpRoot)) {
    console.log('⏭️  resources/mcp not found — skipping\n');
    return;
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const bundledMcps: string[] = config.bundledMcps;
  const alwaysUnbundled: string[] = config.alwaysUnbundled ?? [];

  // Discover TypeScript MCPs on disk (dirs with tsconfig.json)
  const onDisk: string[] = [];
  for (const name of readdirSync(mcpRoot).sort()) {
    const mcpDir = join(mcpRoot, name);
    if (!statSync(mcpDir).isDirectory()) continue;
    if (!existsSync(join(mcpDir, 'tsconfig.json'))) continue;
    onDisk.push(name);
  }

  const knownSet = new Set([...bundledMcps, ...alwaysUnbundled]);
  const onDiskSet = new Set(onDisk);

  const missingFromConfig = onDisk.filter(name => !knownSet.has(name));
  const bundledMissingFromDisk = bundledMcps.filter(name => !onDiskSet.has(name));
  const unbundledMissingFromDisk = alwaysUnbundled.filter(name => !onDiskSet.has(name));

  if (missingFromConfig.length === 0 && bundledMissingFromDisk.length === 0 && unbundledMissingFromDisk.length === 0) {
    console.log(`✅ ${bundledMcps.length} bundled + ${alwaysUnbundled.length} unbundled = ${onDisk.length} on disk — all in sync\n`);
    return;
  }

  let hasError = false;

  if (missingFromConfig.length > 0) {
    console.error(`❌ ${missingFromConfig.length} MCP(s) on disk but missing from scripts/mcp-config.json:\n`);
    for (const name of missingFromConfig) {
      console.error(`   - resources/mcp/${name}/`);
    }
    console.error(`\n   Fix: Add to bundledMcps or alwaysUnbundled in scripts/mcp-config.json\n`);
    hasError = true;
  }

  if (bundledMissingFromDisk.length > 0) {
    console.error(`❌ ${bundledMissingFromDisk.length} bundledMcps entry/entries not on disk:\n`);
    for (const name of bundledMissingFromDisk) {
      console.error(`   - ${name} (in bundledMcps but resources/mcp/${name}/ not found)`);
    }
    console.error(`\n   Fix: Remove from bundledMcps or create the MCP directory\n`);
    hasError = true;
  }

  if (unbundledMissingFromDisk.length > 0) {
    console.error(`❌ ${unbundledMissingFromDisk.length} alwaysUnbundled entry/entries not on disk:\n`);
    for (const name of unbundledMissingFromDisk) {
      console.error(`   - ${name} (in alwaysUnbundled but resources/mcp/${name}/ not found)`);
    }
    console.error(`\n   Fix: Remove from alwaysUnbundled or create the MCP directory\n`);
    hasError = true;
  }

  if (hasError) {
    process.exit(1);
  }
}

main();
