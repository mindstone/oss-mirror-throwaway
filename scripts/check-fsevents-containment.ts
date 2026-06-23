#!/usr/bin/env npx tsx
/**
 * CI guard: fsevents containment (PLAN.md docs/plans/260611_fsevents-shutdown-crash,
 * Stage 3b — Arbitrator F4, lockfile-graph semantics per amendment review F6).
 *
 * Why: on Electron 39 (Node 22.x) ANY live fsevents native instance at env teardown can
 * SIGABRT in the fsevents finalizer (nodejs/node#55706 — the quit-time crash-dialog
 * class; fixed upstream only in Node >= 24.14 → Electron >= 41). The shipped fix tracks
 * and sweeps fsevents instances via `src/main/services/fseventsLeakGuard.ts`, whose
 * interception is verified against chokidar@3.x's `require('fsevents')` call-time lookup.
 * Two residual escape paths would silently reopen the class:
 *   1. a NEW production dependency that loads fsevents outside the wrapper's patched
 *      module (different nested copy → different exports object → untracked instances);
 *   2. a chokidar major bump (v4 dropped fsevents; its close() semantics also differ
 *      catastrophically — see PLAN.md spike data) changing the verified mechanics.
 * This guard turns both into CI-red events.
 *
 * Semantics (deliberate): this is a PRODUCTION LOCKFILE-GRAPH check — it walks
 * package-lock.json from the root's prod dependencies using npm's nested-resolution
 * rules. It does NOT inspect the runtime node_modules tree and does NOT shell out to
 * `npm ls` (both describe whatever happens to be installed locally, including dev/stale
 * state — the lockfile is what packaging installs). Dev-only paths (playwright, vite,
 * tsx, rollup all carry their own fsevents copies) are ignored by construction: the walk
 * simply never enters dev dependencies.
 *
 * Asserts:
 *   A. chokidar is a root prod dependency resolving to semver-major 3 (a major bump must
 *      be a deliberate, plan-level revisit — it invalidates the verified interception
 *      AND exit-latency mechanics);
 *   B. every prod-reachable lockfile edge into ANY `fsevents` package comes from
 *      chokidar@3.x (no new prod consumer, no second prod path);
 *   C. fsevents absence is tolerated (it is an optional dep — absent off-darwin installs
 *      and from non-darwin lockfile prunes; zero edges is a pass for B);
 *   D. the wrapper half of the invariant: `src/main/services/fseventsLeakGuard.ts`
 *      exists and bootstrap.ts both imports and CALLS `installFseventsLeakGuard` from
 *      executed code (the sweep is useless if the guard never installs).
 *
 * Wired into scripts/run-validate-fast.ts (validate:fast → pre-push gate) next to the
 * sibling fsevents chokepoint guards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './check-app-exit-chokepoint';

const REPO_ROOT = process.cwd();

export const WRAPPER_MODULE = 'src/main/services/fseventsLeakGuard.ts';
export const BOOTSTRAP_MODULE = 'src/main/bootstrap.ts';
export const REQUIRED_CHOKIDAR_MAJOR = 3;

// --- Lockfile graph walk (pure; unit-tested with fixture lockfile fragments) ----------

interface LockfilePackageEntry {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface LockfileLike {
  lockfileVersion?: number;
  packages?: Record<string, LockfilePackageEntry>;
}

/** A prod-reachable lockfile edge into an fsevents package. */
export interface FseventsEdge {
  /** Lockfile key of the dependent (e.g. 'node_modules/chokidar'); '' = root. */
  fromKey: string;
  fromName: string;
  fromVersion: string;
  /** Lockfile key of the fsevents copy it resolves to. */
  toKey: string;
  toVersion: string;
}

export interface ContainmentAnalysis {
  violations: string[];
  fseventsEdges: FseventsEdge[];
  chokidarVersion: string | null;
  prodPackagesVisited: number;
}

/** Name of the package a lockfile `packages` key denotes (handles scoped names). */
export function packageNameFromKey(key: string): string {
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  return idx === -1 ? key : key.slice(idx + marker.length);
}

/**
 * npm nested resolution: from the package at `fromKey`, dependency `depName` resolves to
 * the nearest enclosing node_modules that contains it.
 */
export function resolveDependencyKey(
  fromKey: string,
  depName: string,
  packages: Record<string, LockfilePackageEntry>,
): string | null {
  let base = fromKey;
  for (;;) {
    const candidate = base === '' ? `node_modules/${depName}` : `${base}/node_modules/${depName}`;
    if (candidate in packages) {
      return candidate;
    }
    if (base === '') {
      return null;
    }
    const idx = base.lastIndexOf('/node_modules/');
    base = idx === -1 ? '' : base.slice(0, idx);
  }
}

function semverMajor(version: string | undefined): number | null {
  if (!version) {
    return null;
  }
  const match = /^(\d+)\./.exec(version) ?? /^(\d+)$/.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * Walk the production dependency graph (dependencies + optionalDependencies +
 * peerDependencies — everything npm installs for a prod install) from the lockfile
 * root and check the containment invariants A–C. Pure: no fs access.
 */
export function analyzeFseventsContainment(lockfile: LockfileLike): ContainmentAnalysis {
  const violations: string[] = [];
  const packages = lockfile.packages;
  if (!packages || typeof packages !== 'object' || !('' in packages)) {
    return {
      violations: [
        'package-lock.json has no `packages` map with a root entry — lockfileVersion ' +
          `${lockfile.lockfileVersion ?? '?'} is not the v2/v3 shape this guard understands. ` +
          'Update scripts/check-fsevents-containment.ts for the new lockfile format (fail-closed).',
      ],
      fseventsEdges: [],
      chokidarVersion: null,
      prodPackagesVisited: 0,
    };
  }

  // A: chokidar must be a root prod dependency at major 3.
  const rootEntry = packages[''];
  const rootProdDeps = {
    ...(rootEntry.dependencies ?? {}),
    ...(rootEntry.optionalDependencies ?? {}),
  };
  let chokidarVersion: string | null = null;
  if (!('chokidar' in rootProdDeps)) {
    violations.push(
      'chokidar is no longer a root production dependency. The fsevents leak-guard interception is ' +
        "verified against chokidar@3.x's require('fsevents') mechanics — removing/relocating chokidar " +
        'must be a deliberate plan-level revisit (see docs/plans/260611_fsevents-shutdown-crash/PLAN.md).',
    );
  } else {
    const chokidarKey = resolveDependencyKey('', 'chokidar', packages);
    chokidarVersion = chokidarKey ? (packages[chokidarKey]?.version ?? null) : null;
    const major = semverMajor(chokidarVersion ?? undefined);
    if (major !== REQUIRED_CHOKIDAR_MAJOR) {
      violations.push(
        `chokidar resolves to ${chokidarVersion ?? 'unknown'} (major ${major ?? '?'}), expected major ` +
          `${REQUIRED_CHOKIDAR_MAJOR}. A chokidar major bump invalidates the verified fsevents ` +
          'interception AND the measured close()/exit-latency mechanics (chokidar v4 close() is a ' +
          'synchronous main-thread forEach — 19-59s at real workspace scale). This must be a ' +
          'deliberate revisit of docs/plans/260611_fsevents-shutdown-crash/PLAN.md, not a routine bump.',
      );
    }
  }

  // B/C: BFS the prod graph, recording every edge into an fsevents package.
  const fseventsEdges: FseventsEdge[] = [];
  const visited = new Set<string>(['']);
  const queue: string[] = [''];
  const seenEdges = new Set<string>();
  while (queue.length > 0) {
    const fromKey = queue.shift() as string;
    const fromEntry = packages[fromKey];
    if (!fromEntry) {
      continue;
    }
    const deps = {
      ...(fromEntry.dependencies ?? {}),
      ...(fromEntry.optionalDependencies ?? {}),
      ...(fromEntry.peerDependencies ?? {}),
    };
    for (const depName of Object.keys(deps)) {
      const toKey = resolveDependencyKey(fromKey, depName, packages);
      if (toKey === null) {
        // Unresolvable = optional/peer dep pruned from the lockfile (e.g. fsevents on a
        // lockfile generated off-darwin). Tolerated (assert C).
        continue;
      }
      if (depName === 'fsevents') {
        const edgeId = `${fromKey}=>${toKey}`;
        if (!seenEdges.has(edgeId)) {
          seenEdges.add(edgeId);
          fseventsEdges.push({
            fromKey,
            fromName: packageNameFromKey(fromKey) || '(root)',
            fromVersion: packages[fromKey]?.version ?? 'unknown',
            toKey,
            toVersion: packages[toKey]?.version ?? 'unknown',
          });
        }
      }
      if (!visited.has(toKey)) {
        visited.add(toKey);
        queue.push(toKey);
      }
    }
  }

  for (const edge of fseventsEdges) {
    const fromMajor = semverMajor(edge.fromVersion);
    const viaChokidar3 = edge.fromName === 'chokidar' && fromMajor === REQUIRED_CHOKIDAR_MAJOR;
    if (!viaChokidar3) {
      violations.push(
        `fsevents (${edge.toKey}@${edge.toVersion}) is production-reachable via ` +
          `${edge.fromName}@${edge.fromVersion} (${edge.fromKey || 'root'}) — only chokidar@` +
          `${REQUIRED_CHOKIDAR_MAJOR}.x may depend on fsevents in the prod graph. A second consumer ` +
          'can load a DIFFERENT fsevents copy the leak-guard wrapper never patched, silently reopening ' +
          'the quit-time SIGABRT class (nodejs/node#55706, unfixed until Electron >= 41). Either drop ' +
          'the dependency or extend the leak-guard interception deliberately ' +
          '(docs/plans/260611_fsevents-shutdown-crash/PLAN.md).',
      );
    }
  }

  return { violations, fseventsEdges, chokidarVersion, prodPackagesVisited: visited.size };
}

// --- Wrapper-present half (pure core; fs shim in main) ---------------------------------

export interface WrapperPresenceInput {
  wrapperExists: boolean;
  /** Contents of src/main/bootstrap.ts, or null if unreadable. */
  bootstrapSource: string | null;
}

export function checkWrapperPresence(input: WrapperPresenceInput): string[] {
  const violations: string[] = [];
  if (!input.wrapperExists) {
    violations.push(
      `${WRAPPER_MODULE} is missing — the fsevents leak-guard wrapper is the tracking half of the ` +
        'quit-time SIGABRT fix. If it moved, update scripts/check-fsevents-containment.ts.',
    );
  }
  if (input.bootstrapSource === null) {
    violations.push(`${BOOTSTRAP_MODULE} is missing/unreadable — cannot verify the leak guard installs.`);
    return violations;
  }
  // Comment-stripped first (stage-3 review F2): a commented-out import/call must not
  // satisfy an "installs from executed code" guard. Reuses the sibling chokepoint
  // guard's line/block stripper (same naive-about-strings trade-off, documented there).
  const executedSource = stripComments(input.bootstrapSource);
  const importsGuard = /import\s*\{[^}]*\binstallFseventsLeakGuard\b[^}]*\}\s*from\s*['"][^'"]*fseventsLeakGuard['"]/.test(
    executedSource,
  );
  const callsGuard = /\binstallFseventsLeakGuard\s*\(/.test(executedSource);
  if (!importsGuard || !callsGuard) {
    violations.push(
      `${BOOTSTRAP_MODULE} no longer ${importsGuard ? 'calls' : 'imports'} installFseventsLeakGuard — ` +
        'the wrapper must install from executed bootstrap code BEFORE ./index loads (load-order spec, ' +
        'PLAN.md Stage 1), otherwise chokidar gets the unpatched fsevents and the quit sweep tracks nothing.',
    );
  }
  return violations;
}

// --- CLI -------------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\n✗ check-fsevents-containment: ${message}\n`);
  process.exit(1);
}

export function main(): void {
  const lockfilePath = path.join(REPO_ROOT, 'package-lock.json');
  if (!fs.existsSync(lockfilePath)) {
    fail('package-lock.json not found — run from the repo root.');
  }
  let lockfile: LockfileLike;
  try {
    lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8')) as LockfileLike;
  } catch (err) {
    fail(`package-lock.json is unparseable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const analysis = analyzeFseventsContainment(lockfile);
  const wrapperViolations = checkWrapperPresence({
    wrapperExists: fs.existsSync(path.join(REPO_ROOT, WRAPPER_MODULE)),
    bootstrapSource: fs.existsSync(path.join(REPO_ROOT, BOOTSTRAP_MODULE))
      ? fs.readFileSync(path.join(REPO_ROOT, BOOTSTRAP_MODULE), 'utf8')
      : null,
  });

  const violations = [...analysis.violations, ...wrapperViolations];
  if (violations.length > 0) {
    fail(`${violations.length} violation(s):\n` + violations.map((v) => `- ${v}`).join('\n'));
  }

  const edgeSummary =
    analysis.fseventsEdges.length === 0
      ? 'fsevents not prod-reachable (tolerated: optional dep absent)'
      : analysis.fseventsEdges
          .map((e) => `${e.fromName}@${e.fromVersion} -> ${e.toKey}@${e.toVersion}`)
          .join('; ');
  console.log(
    `✓ check-fsevents-containment: ${analysis.prodPackagesVisited} prod lockfile packages walked; ` +
      `chokidar@${analysis.chokidarVersion}; ${edgeSummary}; wrapper present + installed from bootstrap.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
