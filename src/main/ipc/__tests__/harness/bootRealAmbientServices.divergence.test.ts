/**
 * Divergence guard (Stage 3, architecture-F3 / impl-readiness-F2).
 *
 * Parses the actual `set*Factory(` call identifiers out of the ambient region
 * of `cloud-service/src/bootstrap.ts` AT TEST TIME (NOT a hardcoded list) and
 * asserts that `bootRealAmbientServices()` installs a SUPERSET. When cloud adds
 * a 13th ambient factory to that region without it being added to the harness
 * helper, this goes RED with a clear, actionable message — instead of the
 * harness later failing with a mystery "X not initialized" deep inside a
 * registrar boot.
 *
 * The region is delimited by anchor comments/lines rather than hardcoded line
 * numbers so it survives unrelated edits to bootstrap.ts. We anchor on the
 * first ambient factory (`setStoreFactory`) and stop at the cloud-coupled tail
 * (`setCodexAuthProvider`), which is the 469-480 vs 481+ boundary the PLAN
 * draws (the tail is the cloud-only set the harness deliberately does NOT copy).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { INSTALLED_AMBIENT_FACTORIES } from './bootRealAmbientServices';

const BOOTSTRAP_PATH = path.resolve(
  __dirname,
  '../../../../../cloud-service/src/bootstrap.ts',
);

/** The helper itself — parsed to assert the literal list matches its real calls. */
const HELPER_PATH = path.resolve(__dirname, 'bootRealAmbientServices.ts');

/**
 * Start of the ambient `set*Factory` block (469-480). `setStoreFactory` is the
 * first ambient shim cloud installs.
 */
const AMBIENT_REGION_START = 'setStoreFactory(';

/**
 * Start of the cloud-coupled tail (481+) the harness must NOT copy. The first
 * non-factory cloud setter after the 12 ambient factories is
 * `setCodexAuthProvider`. We stop scanning here so cloud-only factory-shaped
 * setters added to the TAIL are not mistaken for ambient ones.
 */
const CLOUD_TAIL_MARKER = 'setCodexAuthProvider(';

/**
 * Anchors delimiting the actual `set*Factory(` CALL block in the helper's
 * `installAmbient()` (NOT the destructured import list above it, which has no
 * call parens, and NOT the `INSTALLED_AMBIENT_FACTORIES` literal). Start after
 * the factory-shims comment; stop at the fresh-registry comment.
 */
const HELPER_CALLS_START = '// The 12 ambient factory shims';
const HELPER_CALLS_END = '// Fresh registry last';

/**
 * Parse the helper's REAL `set*Factory(...)` invocations (the call sites that
 * actually mis-boot if a factory is missing), so the exported literal list
 * cannot drift from them — "added to the list but forgot the call" or vice
 * versa both go RED.
 */
function extractHelperFactoryCalls(source: string): string[] {
  const startIdx = source.indexOf(HELPER_CALLS_START);
  expect(
    startIdx,
    `Could not find the helper call-block anchor "${HELPER_CALLS_START}" in ` +
      'bootRealAmbientServices.ts — update the self-consistency guard anchors.',
  ).toBeGreaterThanOrEqual(0);

  const endIdx = source.indexOf(HELPER_CALLS_END, startIdx);
  expect(
    endIdx,
    `Could not find the helper call-block end anchor "${HELPER_CALLS_END}" after the ` +
      'factory calls in bootRealAmbientServices.ts — update the self-consistency guard anchors.',
  ).toBeGreaterThan(startIdx);

  const region = source.slice(startIdx, endIdx);
  const matches = region.matchAll(/\b(set\w*Factory)\s*\(/g);
  const names = new Set<string>();
  for (const m of matches) {
    names.add(m[1]);
  }
  return Array.from(names).sort();
}

function extractAmbientFactoryNames(source: string): string[] {
  const startIdx = source.indexOf(AMBIENT_REGION_START);
  expect(
    startIdx,
    `Could not find the ambient region anchor "${AMBIENT_REGION_START}" in bootstrap.ts — ` +
      'the divergence guard region anchors need updating.',
  ).toBeGreaterThanOrEqual(0);

  const tailIdx = source.indexOf(CLOUD_TAIL_MARKER, startIdx);
  expect(
    tailIdx,
    `Could not find the cloud-tail marker "${CLOUD_TAIL_MARKER}" after the ambient region in ` +
      'bootstrap.ts — the divergence guard region anchors need updating.',
  ).toBeGreaterThan(startIdx);

  const region = source.slice(startIdx, tailIdx);

  // Match `set<Name>Factory(` invocations (not type/import references).
  const matches = region.matchAll(/\b(set\w*Factory)\s*\(/g);
  const names = new Set<string>();
  for (const m of matches) {
    names.add(m[1]);
  }
  return Array.from(names).sort();
}

describe('bootRealAmbientServices divergence guard', () => {
  const source = readFileSync(BOOTSTRAP_PATH, 'utf8');
  const cloudAmbientFactories = extractAmbientFactoryNames(source);

  it('the exported INSTALLED_AMBIENT_FACTORIES list matches the helper\'s real set*Factory() call sites (no list/call drift)', () => {
    const helperSource = readFileSync(HELPER_PATH, 'utf8');
    const actualCalls = extractHelperFactoryCalls(helperSource);
    const declared = [...INSTALLED_AMBIENT_FACTORIES].sort();

    // Sanity: the parse actually found calls (guards against an anchor-region
    // miss producing a vacuous empty match that trivially "matches" nothing).
    expect(actualCalls.length).toBe(declared.length);

    // The literal list and the real calls must be identical sets — so "added to
    // the list but forgot the set*Factory() call" (or the reverse) goes RED.
    expect(actualCalls).toEqual(declared);
  });

  it('finds the expected ambient factory call sites in cloud bootstrap.ts', () => {
    // Sanity: the region parse actually found the 12 factories (so a future
    // refactor that moves/renames them surfaces as a guard failure, not a
    // silently-empty match producing a vacuous superset pass).
    expect(cloudAmbientFactories.length).toBe(12);
  });

  it('bootRealAmbientServices installs a superset of cloud bootstrap ambient factories', () => {
    const installed = new Set(INSTALLED_AMBIENT_FACTORIES);
    const missing = cloudAmbientFactories.filter((name) => !installed.has(name));

    expect(
      missing,
      missing.length === 0
        ? ''
        : `cloud bootstrap installs factory ${missing.join(', ')} not in bootRealAmbientServices — ` +
            'add the in-memory fake + its name to INSTALLED_AMBIENT_FACTORIES in ' +
            'src/main/ipc/__tests__/harness/bootRealAmbientServices.ts',
    ).toEqual([]);
  });
});
