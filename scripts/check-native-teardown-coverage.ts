#!/usr/bin/env npx tsx
/**
 * Native-teardown coverage guard (Stage 1 of
 * docs/plans/260622_teardown-lifecycle-contract/PLAN.md).
 *
 * WHY THIS EXISTS: a native-resource owner (an in-MAIN-process holder of a
 * native worker/TSFN/handle — an ORT InferenceSession, a LanceDB connection, a
 * BLE central) can be added to the codebase and be COMPLETELY INVISIBLE to
 * shutdown. Nothing structurally forces a new owner to be classified against
 * the teardown contract. That is the exact structural miss that hid moonshine
 * ONNX (no disposer at all) and the file-index LanceDB connection (closeIndex
 * exists, never called on desktop quit) — both now prime quit-deadlock suspects
 * (Sentry REBEL-6AM). See docs/plans/260622_teardown-lifecycle-contract/PLAN.md
 * and subagent_reports/260622_researcher.md.
 *
 * This guard makes "an invisible native owner" UNREPRESENTABLE: it scans the
 * source tree for a PINNED, NARROW set of native-owner signatures and FAILS
 * when a matched file is NOT mapped to an entry in the
 * `nativeTeardownRegistry.ts` manifest AND not on the explicit EXEMPT list.
 *
 * MANIFEST-DRIVEN, NOT regex-as-source-of-truth (GPT design F3): the regex
 * SIGNATURES only FIND candidate owners; the source of truth for "is this owner
 * covered" is the registry manifest. The signatures are deliberately narrow —
 * they match the call that ESTABLISHES a long-lived native handle
 * (`lancedb.connect(`, `InferenceSession.create(`, a BLE central's
 * `startScanning(`), NOT every reference to a native package (which would
 * over-match the loader util, type-only imports, JSDoc, etc.). A pasted current
 * match list (CURRENT_MATCH_BASELINE) keeps this deterministic and
 * review-visible; a NEW unrecognised match FAILS loud, forcing a human to
 * classify it (register it, or EXEMPT it with a reason).
 *
 * Wired into scripts/run-validate-fast.ts with a step-identity baseline.
 *
 * Usage: npx tsx scripts/check-native-teardown-coverage.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getNativeTeardownManifestNames } from '../src/main/services/nativeTeardownManifest';

const REPO_ROOT = path.resolve(__dirname, '..');

/** Source roots scanned for native-owner signatures (no tests / built output). */
const SCAN_ROOTS = ['src/main', 'src/core'] as const;

const EXCLUDE_PARTS = new Set(['__tests__', '__mocks__', 'node_modules', 'build', 'dist', '.vite']);

// --- Native-owner signatures (narrow, pinned) -------------------------------------------

/**
 * A signature that identifies a file as a native-resource OWNER. Each matches
 * the call that ESTABLISHES a long-lived in-process native handle — not a mere
 * reference to a native package. Deliberately narrow to avoid the over-match
 * the broad-regex approach risks (GPT design F3).
 */
export interface NativeOwnerSignature {
  /** Human label for diagnostics. */
  readonly label: string;
  /** Matches the handle-establishing call. */
  readonly pattern: RegExp;
}

export const NATIVE_OWNER_SIGNATURES: readonly NativeOwnerSignature[] = [
  {
    label: 'LanceDB connection (native Rust addon + async runtime)',
    // `lancedb.connect(` — the call that opens a LanceDB connection handle.
    pattern: /\blancedb\.connect\s*\(/,
  },
  {
    label: 'ONNX Runtime InferenceSession (native runtime threads)',
    // `InferenceSession.create(` — creates an ORT session holding native threads.
    pattern: /\bInferenceSession\.create\s*\(/,
  },
  {
    label: 'BLE central scan (native @stoprocent/noble handle)',
    // `.startScanning(` on a noble central — opens an OS BLE handle.
    pattern: /\bstartScanning\s*\(/,
  },
  {
    label: 'sherpa-onnx ONNX Runtime recognizer (native runtime threads)',
    // `loadNativeModule<...>('sherpa-onnx-node')` — loads the native ORT-backed
    // sherpa module that the Windows local-STT path uses to build an
    // OfflineRecognizer (native threads) in the MAIN process. Matches the LOAD
    // call (not a bare mention of the package name), so the manifest's own note
    // string and the loadNativeModule JSDoc example do not false-match.
    pattern: /\bloadNativeModule\b[^)]*\bsherpa-onnx-node\b/,
  },
] as const;

// --- Coverage manifest (the source of truth) --------------------------------------------

/**
 * Maps a matched source file (repo-relative posix path) to its registered
 * owner NAME in `src/main/services/nativeTeardownRegistry.ts`. Every file the
 * signatures match MUST appear here (covered) or in EXEMPT (justified) — a
 * file matching a signature and present in NEITHER is a hard FAIL.
 *
 * This is the pasted CURRENT match baseline (PLAN.md / design F3): it is
 * deterministic and review-visible, and a NEW unrecognised match fails loud.
 */
export const COVERED_OWNER_FILES: ReadonlyMap<string, string> = new Map([
  // LanceDB main-process connection owners.
  ['src/main/services/conversationIndexService.ts', 'conversation-lancedb'],
  ['src/core/services/toolIndex/toolIndexService.ts', 'tool-lancedb'],
  ['src/main/services/fileIndexService/index.ts', 'file-lancedb'],
  // ONNX Runtime main-process session owners.
  ['src/main/services/moonshineTranscriber.ts', 'moonshine-onnx'],
  ['src/main/services/localSttService.ts', 'local-stt-sherpa'],
  // BLE central (device feature) — classified `tracked-gap` (in-MAIN OS BLE
  // handle, not yet on the shutdown roster); manifest-only, no liveness accessor.
  ['src/main/services/physicalRecording/physicalRecordingService.ts', 'noble-ble'],
]);

/**
 * Files that match a native-owner signature but are deliberately NOT a
 * registry main-owner, each with a one-line reason. These are owners whose
 * heavy native resource lives in a SEPARATE OS process (a utilityProcess
 * worker / offscreen window), so it dies with that process and cannot block
 * the main process's env teardown — OR a transient connect→use→close in a
 * single bounded call with no persistent in-main holder.
 */
export const EXEMPT_OWNER_FILES: ReadonlyMap<string, string> = new Map([
  [
    'src/main/workers/preTurnWorker.ts',
    'out-of-process-child: runs in a utilityProcess (its own OS process); LanceDB connections die with the worker, cannot hang main env teardown.',
  ],
  [
    'src/main/workers/indexHealthWorker.ts',
    'out-of-process-child: runs in a utilityProcess (force-killable on timeout); LanceDB connection dies with the worker.',
  ],
  [
    'src/core/services/indexHealthService.ts',
    'stateless-transient: opens a LanceDB connection for one bounded validate call and closes it before returning (no persistent in-main holder).',
  ],
]);

// --- Pure core (unit-tested) ------------------------------------------------------------

function toRepoPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

/** Strip block + line comments so JSDoc examples / commented code don't false-match. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Which signature labels (if any) match this (comment-stripped) source. */
export function matchingSignatures(
  source: string,
  signatures: readonly NativeOwnerSignature[] = NATIVE_OWNER_SIGNATURES,
): string[] {
  const code = stripComments(source);
  return signatures.filter((s) => s.pattern.test(code)).map((s) => s.label);
}

export interface CoverageViolation {
  readonly repoPath: string;
  readonly matchedSignatures: readonly string[];
  readonly kind: 'unclassified';
}

/** A covered-file → owner-name mapping whose owner name is absent from the manifest (FAIL). */
export interface UnknownOwnerViolation {
  readonly repoPath: string;
  readonly ownerName: string;
}

export interface CoverageResult {
  /** Files matching a signature that are neither covered nor exempt (FAIL). */
  readonly violations: readonly CoverageViolation[];
  /** Covered entries naming an owner that is not in the manifest (FAIL — guard is manifest-driven). */
  readonly unknownOwners: readonly UnknownOwnerViolation[];
  /** Covered-map entries whose file no longer matches any signature (stale baseline → FAIL). */
  readonly staleCovered: readonly string[];
  /** Exempt-map entries whose file no longer matches any signature (stale baseline → FAIL). */
  readonly staleExempt: readonly string[];
  readonly matchedFileCount: number;
}

/**
 * Pure coverage computation over a set of (repoPath → comment-stripped-source)
 * inputs. A file that matches a signature must be covered OR exempt; every
 * covered file's named owner MUST exist in the manifest (the guard is actually
 * manifest-driven — a typo'd/deleted owner name fails, GPT F1); and every
 * covered/exempt baseline entry must still match a signature (no stale
 * allowlisting — same anti-rot posture as check-packaged-native-modules).
 */
export function computeCoverage(
  files: ReadonlyMap<string, string>,
  covered: ReadonlyMap<string, string> = COVERED_OWNER_FILES,
  exempt: ReadonlyMap<string, string> = EXEMPT_OWNER_FILES,
  signatures: readonly NativeOwnerSignature[] = NATIVE_OWNER_SIGNATURES,
  manifestOwnerNames: readonly string[] = getNativeTeardownManifestNames(),
): CoverageResult {
  const violations: CoverageViolation[] = [];
  const matchedRepoPaths = new Set<string>();

  for (const [repoPath, source] of files) {
    const matched = matchingSignatures(source, signatures);
    if (matched.length === 0) {
      continue;
    }
    matchedRepoPaths.add(repoPath);
    if (covered.has(repoPath) || exempt.has(repoPath)) {
      continue;
    }
    violations.push({ repoPath, matchedSignatures: matched, kind: 'unclassified' });
  }

  // GPT F1: the guard is only manifest-driven if a covered file's named owner
  // actually exists in the manifest. A typo or a deleted manifest entry must FAIL.
  const manifestNameSet = new Set(manifestOwnerNames);
  const unknownOwners: UnknownOwnerViolation[] = [];
  for (const [repoPath, ownerName] of covered) {
    if (!manifestNameSet.has(ownerName)) {
      unknownOwners.push({ repoPath, ownerName });
    }
  }

  const staleCovered = [...covered.keys()].filter((p) => !matchedRepoPaths.has(p));
  const staleExempt = [...exempt.keys()].filter((p) => !matchedRepoPaths.has(p));

  return {
    violations,
    unknownOwners,
    staleCovered,
    staleExempt,
    matchedFileCount: matchedRepoPaths.size,
  };
}

// --- Filesystem scan --------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_PARTS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\.tsx?$/.test(entry.name)) continue;
    if (/\.d\.ts$/.test(entry.name)) continue;
    out.push(fullPath);
  }
  return out;
}

function collectScannedFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const filePath of walk(path.join(REPO_ROOT, root))) {
      files.set(toRepoPath(filePath), fs.readFileSync(filePath, 'utf8'));
    }
  }
  return files;
}

// --- CLI --------------------------------------------------------------------------------

export function main(): number {
  const result = computeCoverage(collectScannedFiles());

  let failed = false;

  if (result.violations.length > 0) {
    failed = true;
    process.stderr.write(
      '[check-native-teardown-coverage] FAIL: native-resource owner(s) not classified against the teardown contract.\n\n',
    );
    for (const v of result.violations) {
      process.stderr.write(`  ${v.repoPath}\n    matched: ${v.matchedSignatures.join('; ')}\n`);
    }
    process.stderr.write(
      '\nWhy this is RED: a file that establishes a long-lived native handle (LanceDB connection, ORT\n' +
        'InferenceSession, BLE central) in the MAIN process can hang the quit in FreeEnvironment →\n' +
        'Worker::JoinThread if it is still live at env teardown — the REBEL-6AM quit-deadlock class. A new\n' +
        'such owner that is invisible to shutdown is exactly how moonshine + file-index slipped through.\n' +
        'CLASSIFY it, in the SAME commit:\n' +
        '  - If it is an in-MAIN owner that should be torn down: add it to NATIVE_TEARDOWN_OWNERS in\n' +
        '    src/main/services/nativeTeardownRegistry.ts (main-owner, or tracked-gap if no disposer yet)\n' +
        '    AND add it to COVERED_OWNER_FILES in this script, pointing at the registry name. Wire its\n' +
        '    bounded disposal onto the shutdownInternal roster in gracefulShutdown.ts (a later stage).\n' +
        '  - If the heavy native resource lives OUT of the main process (utilityProcess / offscreen window\n' +
        '    / detached child) or is a transient connect→use→close: add it to EXEMPT_OWNER_FILES here with\n' +
        '    a one-line reason.\n' +
        'See docs/plans/260622_teardown-lifecycle-contract/PLAN.md.\n',
    );
  }

  if (result.unknownOwners.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: covered file(s) name an owner that is NOT in the\n' +
        'native-teardown manifest (src/main/services/nativeTeardownManifest.ts). The guard is\n' +
        'manifest-driven — a typo or a deleted manifest entry must not pass green. Fix the owner name\n' +
        'in COVERED_OWNER_FILES, or add the missing entry to the manifest:\n',
    );
    for (const u of result.unknownOwners) {
      process.stderr.write(`  ${u.repoPath} -> "${u.ownerName}" (not in manifest)\n`);
    }
  }

  if (result.staleCovered.length > 0 || result.staleExempt.length > 0) {
    failed = true;
    process.stderr.write(
      '\n[check-native-teardown-coverage] FAIL: stale coverage baseline entr(y/ies) — listed file(s) no longer\n' +
        'match any native-owner signature. Remove the stale entry so the baseline stays honest:\n',
    );
    for (const p of result.staleCovered) {
      process.stderr.write(`  COVERED_OWNER_FILES: ${p}\n`);
    }
    for (const p of result.staleExempt) {
      process.stderr.write(`  EXEMPT_OWNER_FILES: ${p}\n`);
    }
  }

  if (failed) {
    return 1;
  }

  process.stdout.write(
    `[check-native-teardown-coverage] OK: ${result.matchedFileCount} native-owner file(s) matched; ` +
      `all classified (${COVERED_OWNER_FILES.size} registered, ${EXEMPT_OWNER_FILES.size} exempt).\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exit(main());
}
