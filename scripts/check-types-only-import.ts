#!/usr/bin/env node
/**
 * Guardrail: `packages/shared/src/intentClient/types.ts` must remain
 * type-only exports (`export type ...`) so the shared intent client layer
 * cannot accidentally pull runtime code from core app-bridge modules.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetFile = join(
  __dirname,
  '..',
  'packages',
  'shared',
  'src',
  'intentClient',
  'types.ts',
);

function main(): void {
  const source = readFileSync(targetFile, 'utf8');
  const violations: Array<{ lineNumber: number; line: string }> = [];

  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('//')) continue;

    if (/^export\s+(?!type\b)/.test(line)) {
      violations.push({ lineNumber: index + 1, line });
    }
  }

  if (violations.length > 0) {
    console.error('❌ Runtime export(s) detected in intentClient/types.ts');
    for (const violation of violations) {
      console.error(`   - line ${violation.lineNumber}: ${violation.line}`);
    }
    process.exit(1);
  }

  console.log('✅ intentClient/types.ts is type-only (no runtime exports).');
}

main();
