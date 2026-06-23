/**
 * Stage B1 — KILL-BY-CONSTRUCTION guard for the analytics privacy contract
 * (`PRIVACY_CONTRACT.md`). These are static source scans, not behavioural tests:
 *
 *  1. The RudderStack SDK may be imported in EXACTLY ONE place
 *     (`mobile/src/analytics/analytics.ts`), the single chokepoint that bakes in
 *     the IDFA-free / device-id-free config and routes every payload through
 *     redaction. Any other importer could bypass the gate or the redaction layer.
 *     Scans BOTH `mobile/src` and `mobile/app` (expo-router routes) so a
 *     future route-level direct import is also caught (GPT F4).
 *
 *  2. The ad/device identifier SDK methods (`setAdvertisingId`,
 *     `putAdvertisingId`, `putDeviceToken`, `setDeviceToken`) must never appear
 *     in app source at all — calling them would defeat the IDFA/device-id-free
 *     posture regardless of the SDK config flags.
 *
 * If either invariant is violated the relevant test fails, mechanically
 * enforcing the contract before any future caller can erode it.
 */

import fs from 'node:fs';
import path from 'node:path';

// Scan roots: mobile/src AND mobile/app (expo-router routes). A future
// route-level direct RudderStack import would bypass the single-chokepoint
// guard if `mobile/app` were not scanned (GPT F4).
const MOBILE_ROOT = path.resolve(__dirname, '../../..');
const SRC_ROOT = path.join(MOBILE_ROOT, 'src');
const APP_ROOT = path.join(MOBILE_ROOT, 'app');
const SCAN_ROOTS = [SRC_ROOT, APP_ROOT];
const RUDDER_PACKAGE = '@rudderstack/rudder-sdk-react-native';

// The ONLY file permitted to import the raw SDK (path relative to mobile/).
const ALLOWED_SDK_IMPORTER = path.join('src', 'analytics', 'analytics.ts');

// Ad / device identifier APIs that must never appear in app source.
const FORBIDDEN_SDK_METHODS = [
  'setAdvertisingId',
  'putAdvertisingId',
  'putDeviceToken',
  'setDeviceToken',
] as const;

const SCANNABLE_EXT = new Set(['.ts', '.tsx']);

// Test files legitimately `jest.mock('@rudderstack/...')` and may name the
// forbidden SDK methods as assertion strings. The privacy contract is about
// APP SOURCE — never test scaffolding — so test dirs/files are excluded.
function isTestPath(name: string): boolean {
  return (
    name === '__tests__' ||
    name.endsWith('.test.ts') ||
    name.endsWith('.test.tsx')
  );
}

/** Recursively collect all app source files under a scan root (excludes tests). */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isTestPath(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (SCANNABLE_EXT.has(path.extname(entry.name))) {
      acc.push(full);
    }
  }
  return acc;
}

/** True when a source file references the raw RudderStack SDK package. */
function importsRudderSdk(source: string): boolean {
  return source.includes(RUDDER_PACKAGE);
}

describe('analytics privacy contract (static guard)', () => {
  const sourceFiles = SCAN_ROOTS.flatMap((root) => collectSourceFiles(root));

  it('finds source files to scan (guard sanity)', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('scans BOTH mobile/src AND mobile/app (route-level guard coverage — F4)', () => {
    const rels = sourceFiles.map((f) => path.relative(MOBILE_ROOT, f));
    expect(rels.some((r) => r.startsWith(`src${path.sep}`))).toBe(true);
    expect(rels.some((r) => r.startsWith(`app${path.sep}`))).toBe(true);
  });

  it(`imports ${RUDDER_PACKAGE} ONLY from ${ALLOWED_SDK_IMPORTER}`, () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const rel = path.relative(MOBILE_ROOT, file);
      if (rel === ALLOWED_SDK_IMPORTER) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (importsRudderSdk(source)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never references ad/device identifier SDK methods in app source', () => {
    const offenders: Array<{ file: string; method: string }> = [];
    for (const file of sourceFiles) {
      const rel = path.relative(MOBILE_ROOT, file);
      const source = fs.readFileSync(file, 'utf8');
      for (const method of FORBIDDEN_SDK_METHODS) {
        if (source.includes(method)) {
          offenders.push({ file: rel, method });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
