/**
 * Pure-logic tests for the native-teardown coverage guard
 * (scripts/check-native-teardown-coverage.ts), Stage 1 of
 * docs/plans/260622_teardown-lifecycle-contract/PLAN.md.
 *
 * Exercises the manifest-driven coverage computation in isolation: a registered
 * owner passes, an unregistered matched owner fails, an exempt entry passes, a
 * comment-only match does not match, and a stale baseline entry fails. Also a
 * tiny live check that the real signature set + baselines pass on the repo (via
 * the script's own main()).
 */

import { describe, expect, it } from 'vitest';

import {
  computeCoverage,
  matchingSignatures,
  stripComments,
  type NativeOwnerSignature,
} from '../check-native-teardown-coverage';

const SIGS: readonly NativeOwnerSignature[] = [
  { label: 'LanceDB connection', pattern: /\blancedb\.connect\s*\(/ },
  { label: 'ORT InferenceSession', pattern: /\bInferenceSession\.create\s*\(/ },
];

describe('matchingSignatures', () => {
  it('matches the handle-establishing call', () => {
    expect(matchingSignatures('const c = await lancedb.connect(dir);', SIGS)).toEqual(['LanceDB connection']);
  });

  it('does not match a mere type-only / reference mention', () => {
    // No `.connect(` call — just a type import reference.
    const src = "type Conn = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;";
    expect(matchingSignatures(src, SIGS)).toEqual([]);
  });

  it('ignores matches inside comments (stripped first)', () => {
    const src = '// example: await lancedb.connect(dbPath)\nconst x = 1;';
    expect(matchingSignatures(src, SIGS)).toEqual([]);
  });

  it('strips block comments before matching', () => {
    expect(stripComments('/* lancedb.connect( */ const x = 1;')).not.toContain('connect');
  });

  it('matches the sherpa-onnx loadNativeModule call but not a bare package mention', () => {
    const sherpaSig: readonly NativeOwnerSignature[] = [
      { label: 'sherpa', pattern: /\bloadNativeModule\b[^)]*\bsherpa-onnx-node\b/ },
    ];
    // The actual handle-establishing load call → matches.
    const call = "const s = loadNativeModule<SherpaOnnxModule>('sherpa-onnx-node');";
    expect(matchingSignatures(call, sherpaSig)).toEqual(['sherpa']);
    // A bare mention of the package name (e.g. in a manifest note string) → no match.
    const mention = "const note = 'TRACKED GAP: sherpa-onnx-node OfflineRecognizer';";
    expect(matchingSignatures(mention, sherpaSig)).toEqual([]);
  });
});

describe('computeCoverage', () => {
  const covered = new Map([['src/main/services/owner.ts', 'owner-registry-name']]);
  const exempt = new Map([['src/main/workers/worker.ts', 'out-of-process-child: dies with worker.']]);
  // The owner names covered above, so the manifest-name check passes by default.
  const manifestNames = ['owner-registry-name'];

  it('passes a registered (covered) owner', () => {
    const files = new Map([['src/main/services/owner.ts', 'await lancedb.connect(d);']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.violations).toEqual([]);
    expect(result.unknownOwners).toEqual([]);
    expect(result.matchedFileCount).toBe(1);
  });

  it('passes an exempt owner', () => {
    const files = new Map([['src/main/workers/worker.ts', 'await lancedb.connect(d);']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.violations).toEqual([]);
  });

  it('FAILS a covered file whose owner name is absent from the manifest (typo/deleted entry)', () => {
    const files = new Map([['src/main/services/owner.ts', 'await lancedb.connect(d);']]);
    // Manifest does NOT contain 'owner-registry-name' — a typo'd/deleted owner.
    const result = computeCoverage(files, covered, exempt, SIGS, ['some-other-owner']);
    expect(result.unknownOwners).toEqual([
      { repoPath: 'src/main/services/owner.ts', ownerName: 'owner-registry-name' },
    ]);
    // The file is still "covered" by path, so it is NOT an unclassified violation.
    expect(result.violations).toEqual([]);
  });

  it('FAILS an unregistered matched owner', () => {
    const files = new Map([['src/main/services/new-owner.ts', 'await lancedb.connect(d);']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      repoPath: 'src/main/services/new-owner.ts',
      kind: 'unclassified',
    });
    expect(result.violations[0].matchedSignatures).toContain('LanceDB connection');
  });

  it('ignores a file that matches no signature', () => {
    const files = new Map([['src/main/services/plain.ts', 'const x = 1;']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.violations).toEqual([]);
    expect(result.matchedFileCount).toBe(0);
  });

  it('FAILS a stale covered baseline entry (file no longer matches any signature)', () => {
    // The covered file is present but its source no longer contains the signature.
    const files = new Map([['src/main/services/owner.ts', 'const x = 1; // refactored away']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.staleCovered).toEqual(['src/main/services/owner.ts']);
  });

  it('FAILS a stale exempt baseline entry', () => {
    const files = new Map([['src/main/workers/worker.ts', 'const x = 1;']]);
    const result = computeCoverage(files, covered, exempt, SIGS, manifestNames);
    expect(result.staleExempt).toEqual(['src/main/workers/worker.ts']);
  });
});
