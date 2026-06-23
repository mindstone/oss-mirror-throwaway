#!/usr/bin/env npx tsx
/**
 * Validates that the Permission union in rebel-plugin-api.d.ts stays in sync
 * with PluginPermissionIpcSchema (the single source of truth).
 *
 * Run via: npx tsx scripts/check-plugin-permission-sync.ts
 * Part of validate:fast pipeline.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SCHEMA_PATH = join(root, 'src/shared/ipc/schemas/plugins.ts');
const DTS_PATH = join(root, 'src/renderer/features/plugins/declarations/rebel-plugin-api.d.ts');

function extractSchemaValues(): string[] {
  const source = readFileSync(SCHEMA_PATH, 'utf8');
  const match = source.match(/PluginPermissionIpcSchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\)/);
  if (!match) {
    console.error('FAILED: Could not find PluginPermissionIpcSchema in', SCHEMA_PATH);
    process.exit(1);
  }
  const values = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (values.length === 0) {
    console.error('FAILED: PluginPermissionIpcSchema has no values');
    process.exit(1);
  }
  return values;
}

function extractDtsValues(): string[] {
  const source = readFileSync(DTS_PATH, 'utf8');
  // Match the `type Permission = 'a' | 'b' | ...;` block specifically
  const match = source.match(/type Permission\s*=\s*([\s\S]*?);/);
  if (!match) {
    console.error('FAILED: Could not find type Permission in', DTS_PATH);
    process.exit(1);
  }
  const values = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  if (values.length === 0) {
    console.error('FAILED: type Permission has no values');
    process.exit(1);
  }
  return values;
}

function main(): void {
  console.log('Checking plugin permission sync...\n');

  const schemaValues = extractSchemaValues();
  const dtsValues = extractDtsValues();

  const schemaSet = new Set(schemaValues);
  const dtsSet = new Set(dtsValues);

  const missingFromDts = schemaValues.filter(v => !dtsSet.has(v));
  const extraInDts = dtsValues.filter(v => !schemaSet.has(v));

  if (missingFromDts.length === 0 && extraInDts.length === 0) {
    console.log(`\u2713 Permission union in rebel-plugin-api.d.ts matches PluginPermissionIpcSchema (${schemaValues.length} values)`);
    return;
  }

  console.error('FAILED: Permission union drift detected\n');
  console.error(`Source of truth (PluginPermissionIpcSchema): ${schemaValues.join(', ')}`);
  console.error(`Declaration file (rebel-plugin-api.d.ts):    ${dtsValues.join(', ')}\n`);

  if (missingFromDts.length > 0) {
    console.error(`Missing from d.ts: ${missingFromDts.join(', ')}`);
  }
  if (extraInDts.length > 0) {
    console.error(`Extra in d.ts:     ${extraInDts.join(', ')}`);
  }

  console.error('\nFix: Update the Permission union in src/renderer/features/plugins/declarations/rebel-plugin-api.d.ts');
  process.exit(1);
}

main();
