#!/usr/bin/env npx tsx

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_TOOL_REASON_MANAGER_ONLY_VALUES,
  HOST_TOOL_REASON_VALUES,
} from '../src/core/appBridge/installer/hostToolContracts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_JS_PATH = path.join(
  ROOT,
  'resources',
  'mcp',
  'rebel-app-bridge',
  'tools',
  'host.js',
);

function fail(message: string, details: string[] = []): never {
  console.error('\n❌ Host tool contract check FAILED\n');
  console.error(`   ${message}\n`);
  for (const detail of details) {
    console.error(`   - ${detail}`);
  }
  console.error('');
  process.exit(1);
}

function collectHostReasonLiterals(source: string): Set<string> {
  const reasonRegexes = [
    /reason:\s*['"]([^'"]+)['"]/g,
    /failureResult\(\s*['"]([^'"]+)['"]/g,
  ];
  const reasons = new Set<string>();

  for (const regex of reasonRegexes) {
    for (const match of source.matchAll(regex)) {
      const reason = match[1];
      if (reason) {
        reasons.add(reason);
      }
    }
  }

  return reasons;
}

function main(): void {
  console.log('🧪 Host Tool Contract Check');
  console.log('===========================\n');

  if (!fs.existsSync(HOST_JS_PATH)) {
    fail(`host.js not found at ${path.relative(ROOT, HOST_JS_PATH)}`);
  }

  const hostSource = fs.readFileSync(HOST_JS_PATH, 'utf8');
  const coreReasons = new Set<string>(HOST_TOOL_REASON_VALUES);
  const managerOnlyReasons = new Set<string>(HOST_TOOL_REASON_MANAGER_ONLY_VALUES);
  const emittedReasons = collectHostReasonLiterals(hostSource);

  const invalidManagerOnlyReasons = [...managerOnlyReasons].filter(
    (reason) => !coreReasons.has(reason),
  );
  if (invalidManagerOnlyReasons.length > 0) {
    fail('HOST_TOOL_REASON_MANAGER_ONLY_VALUES contains unknown HostToolReason values.', invalidManagerOnlyReasons);
  }

  const unknownHostReasons = [...emittedReasons].filter((reason) => !coreReasons.has(reason));
  if (unknownHostReasons.length > 0) {
    fail('host.js emits reason literals that are missing from HostToolReason.', unknownHostReasons);
  }

  const uncoveredCoreReasons = [...coreReasons].filter(
    (reason) => !emittedReasons.has(reason) && !managerOnlyReasons.has(reason),
  );
  if (uncoveredCoreReasons.length > 0) {
    fail(
      'HostToolReason values must appear in host.js or be marked manager-only.',
      uncoveredCoreReasons,
    );
  }

  console.log(
    `✅ ${emittedReasons.size} emitted host.js reason literals covered; ` +
      `${managerOnlyReasons.size} manager-only reason(s) explicitly annotated.\n`,
  );
}

main();
