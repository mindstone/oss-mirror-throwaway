#!/usr/bin/env npx tsx
/**
 * IPC schema strictness ratchet — prevents z.any() and z.unknown() from
 * accumulating in IPC contract definitions.
 *
 * z.any() and z.unknown() in IPC schemas bypass Zod's runtime validation,
 * allowing arbitrary data to cross the process boundary unchecked. Each usage
 * is tracked with an independent baseline.
 *
 * Uses Node.js file walking (no shell dependencies) for cross-platform reliability.
 * Counts actual occurrences per line, not just lines containing matches.
 *
 * When you replace a z.any()/z.unknown() with a proper schema, lower the baselines!
 *
 * Usage: npx tsx scripts/check-ipc-schema-strictness.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './lib/source-text';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Baselines — lower these as schemas are tightened
// ---------------------------------------------------------------------------
export const Z_ANY_BASELINE = 7;      // z.any() calls in IPC schemas
// Lowered 2026-05-23 (31 → 30) by the 260523 follow-up sweep, which audited
// the +1 drift introduced by commit 8bc9069077 (ResolutionFailureSchema.metadata
// in src/shared/ipc/schemas/agent.ts). The metadata field was retyped from
// z.record(z.string(), z.unknown()) to z.record(z.string(), JsonValueSchema)
// using a new shared recursive JSON-value schema in src/shared/ipc/schemas/common.ts.
// Bumped 2026-05-25 (30 → 31) at sync time to acknowledge a new z.unknown() in
// `src/shared/ipc/schemas/settings.ts:268` (inboundAuthorPolicyBackup) introduced
// by upstream Slack inbound-author-policy work that landed in origin/dev. The
// field is an opaque policy backup blob; future audit can decide whether to
// model its actual shape or keep z.unknown() with a rationale comment.
// Lowered 2026-06-10 (32 → 31) after validation reported the current IPC
// schema count below the pinned baseline during Stage A Safe Mode enum work
// (independently confirmed by the 260610 weekly code-health pass).
export const Z_UNKNOWN_BASELINE = 31; // z.unknown() calls in IPC schemas

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------
export function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      results.push(...walkDir(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Pattern counting
// ---------------------------------------------------------------------------
export interface CountResult {
  count: number;
  locations: string[]; // file:line:content entries
}

export function countPattern(files: string[], pattern: RegExp, relativeRoot: string): CountResult {
  let count = 0;
  const locations: string[] = [];

  for (const filePath of files) {
    const rawContent = fs.readFileSync(filePath, 'utf8');
    const rawLines = rawContent.split('\n');
    const stripped = stripComments(rawContent);
    const strippedLines = stripped.split('\n');
    const relPath = path.relative(relativeRoot, filePath);

    for (let i = 0; i < strippedLines.length; i++) {
      pattern.lastIndex = 0;
      const matches = strippedLines[i].match(pattern);
      if (matches) {
        count += matches.length;
        locations.push(`${relPath}:${i + 1}: ${rawLines[i].trim()}`);
      }
    }
  }

  return { count, locations };
}

// ---------------------------------------------------------------------------
// Exported analysis function (for testing)
// ---------------------------------------------------------------------------
export interface SchemaCheckResult {
  name: string;
  count: number;
  baseline: number;
  exceeded: boolean;
  locations: string[];
}

export interface FindSchemaStrictnessViolationsOptions {
  ipcDir?: string;
  zAnyBaseline?: number;
  zUnknownBaseline?: number;
}

export interface FindSchemaStrictnessViolationsResult {
  fileCount: number;
  zAny: SchemaCheckResult;
  zUnknown: SchemaCheckResult;
  failed: boolean;
}

export function findSchemaStrictnessViolations(
  options: FindSchemaStrictnessViolationsOptions = {},
): FindSchemaStrictnessViolationsResult {
  const ipcDir = options.ipcDir ?? path.join(ROOT, 'src/shared/ipc');
  const zAnyBaseline = options.zAnyBaseline ?? Z_ANY_BASELINE;
  const zUnknownBaseline = options.zUnknownBaseline ?? Z_UNKNOWN_BASELINE;

  const files = walkDir(ipcDir);
  const anyResult = countPattern(files, /z\.any\(\)/g, path.resolve(ipcDir, '../..'));
  const unknownResult = countPattern(files, /z\.unknown\(\)/g, path.resolve(ipcDir, '../..'));

  const zAny: SchemaCheckResult = {
    name: 'z.any()',
    count: anyResult.count,
    baseline: zAnyBaseline,
    exceeded: anyResult.count > zAnyBaseline,
    locations: anyResult.locations,
  };

  const zUnknown: SchemaCheckResult = {
    name: 'z.unknown()',
    count: unknownResult.count,
    baseline: zUnknownBaseline,
    exceeded: unknownResult.count > zUnknownBaseline,
    locations: unknownResult.locations,
  };

  return {
    fileCount: files.length,
    zAny,
    zUnknown,
    failed: zAny.exceeded || zUnknown.exceeded,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function main(): void {
  console.log('🔍 IPC Schema Strictness Ratchet');
  console.log('=================================\n');

  const result = findSchemaStrictnessViolations();
  if (result.fileCount === 0) {
    console.error('❌ No .ts files found in IPC directory');
    process.exit(1);
  }

  for (const check of [result.zAny, result.zUnknown]) {
    if (check.exceeded) {
      console.error(`  ✘ ${check.name}: ${check.count} usages (baseline: ${check.baseline}) — new untyped schemas introduced`);
      for (const loc of check.locations) {
        console.error(`    ${loc}`);
      }
    } else {
      console.log(`  ✔ ${check.name}: ${check.count}/${check.baseline} (within baseline)`);
      if (check.count < check.baseline) {
        console.warn(`  ⚠ ${check.name}: ${check.count} is below baseline ${check.baseline}; lower the baseline.`);
      }
    }
  }

  console.log('');

  if (result.failed) {
    console.error('❌ IPC schema strictness ratchet failed.\n');
    console.error('Fix: Replace z.any()/z.unknown() with a proper Zod schema. If the type is');
    console.error('     genuinely opaque (e.g. binary audio), raise the baseline with a comment.\n');
    process.exit(1);
  } else {
    console.log('✅ IPC schema strictness ratchet passed\n');
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
