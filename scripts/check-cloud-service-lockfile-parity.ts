#!/usr/bin/env npx tsx
/**
 * CI Validation: cloud-service package.json ↔ package-lock.json parity.
 *
 * The cloud-service Docker build runs `npm ci` against
 * `cloud-service/package-lock.json`. `npm ci` *fails hard* if the lockfile is
 * out of sync with `package.json`, so a manifest edit that lands without a
 * regenerated lockfile turns into a Cloud Service CI / Docker-build failure
 * discovered late (the 260531 regenerate-lockfile postmortem:
 * docs-private/postmortems/260531_regenerate_lockfile_to_add_157_transitive_*).
 *
 * This gate moves that failure left into `validate:fast`, statically, with no
 * network and no `npm ci`:
 *
 *   1. Manifest/lock dependency parity — the lockfile's root package
 *      (`packages[""]`) must declare exactly the same `dependencies` and
 *      `devDependencies` (names + version ranges) as `package.json`. This is
 *      the same invariant `npm ci` enforces at install time.
 *   2. Resolution presence — every declared dependency must have a resolved
 *      `node_modules/<name>` entry in the lockfile (i.e. the lockfile was
 *      actually regenerated, not just hand-edited at the root).
 *
 * Scope note: a sibling recommendation (fp 27b25b20) asked to also assert
 * native-dependency *platform completeness* (every OS/CPU/libc variant present).
 * That was prototyped and dropped: the set of "native" packages is a heuristic,
 * and the variant-naming conventions differ per package (separate
 * optionalDependencies for @lancedb/lancedb, bundled `.node` bindings for
 * onnxruntime-node, transitive @img/sharp for @huggingface/transformers), so
 * the check produced false positives on exactly the packages it targeted.
 * `npm ci` already fails on a partial lockfile at Docker-build time, and check 1
 * here catches the manifest/lock drift that actually recurs. Adding a noisy
 * platform-variant heuristic would trade a real gate for an unreliable one.
 *
 * Run: npx tsx scripts/check-cloud-service-lockfile-parity.ts
 * Wired into: npm run validate:fast (validate:cloud-service-lockfile-parity)
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const CLOUD_DIR = path.join(ROOT, 'cloud-service');
const PKG_PATH = path.join(CLOUD_DIR, 'package.json');
const LOCK_PATH = path.join(CLOUD_DIR, 'package-lock.json');

interface DepMap {
  [name: string]: string;
}

interface PackageJson {
  dependencies?: DepMap;
  devDependencies?: DepMap;
}

interface LockfilePackageEntry {
  version?: string;
  /** A `link: true` entry (workspace/file: link) has no version — npm resolves it differently. */
  link?: boolean;
  dependencies?: DepMap;
  devDependencies?: DepMap;
  optionalDependencies?: DepMap;
}

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockfilePackageEntry>;
}

export interface ParityResult {
  errors: string[];
  warnings: string[];
}

/** Compare two dependency maps; return human-readable mismatch descriptions. */
function diffDepMaps(label: string, manifest: DepMap, lock: DepMap): string[] {
  const errs: string[] = [];
  const manifestNames = new Set(Object.keys(manifest));
  const lockNames = new Set(Object.keys(lock));

  for (const name of manifestNames) {
    if (!lockNames.has(name)) {
      errs.push(
        `  [${label}] "${name}" is declared in package.json but absent from the lockfile's root ${label}.`,
      );
      continue;
    }
    if (manifest[name] !== lock[name]) {
      errs.push(
        `  [${label}] "${name}" version range differs: package.json wants "${manifest[name]}", ` +
          `lockfile root records "${lock[name]}".`,
      );
    }
  }
  for (const name of lockNames) {
    if (!manifestNames.has(name)) {
      errs.push(
        `  [${label}] "${name}" is in the lockfile's root ${label} but no longer declared in package.json.`,
      );
    }
  }
  return errs;
}

export function checkCloudServiceLockfileParity(
  pkg: PackageJson,
  lock: Lockfile,
): ParityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const root = lock.packages?.[''];
  if (!root) {
    errors.push(
      '  [lockfile] package-lock.json has no root package entry (packages[""]). ' +
        'It is malformed or pre-v2; regenerate with `cd cloud-service && npm install --package-lock-only`.',
    );
    return { errors, warnings };
  }

  const manifestDeps = pkg.dependencies ?? {};
  const manifestDevDeps = pkg.devDependencies ?? {};
  const lockDeps = root.dependencies ?? {};
  const lockDevDeps = root.devDependencies ?? {};

  // 1. Dependency parity (the npm ci invariant)
  errors.push(...diffDepMaps('dependencies', manifestDeps, lockDeps));
  errors.push(...diffDepMaps('devDependencies', manifestDevDeps, lockDevDeps));

  // 2. Resolution presence — every declared dep has a resolved tree entry.
  const allDeclared = { ...manifestDeps, ...manifestDevDeps };
  for (const name of Object.keys(allDeclared)) {
    const resolvedKey = `node_modules/${name}`;
    const resolved = lock.packages?.[resolvedKey];
    // A `link: true` entry (workspace / file: link) is resolved by symlink, not a
    // registry version — its presence (not a version field) is the install proof.
    if (resolved?.link) continue;
    if (!resolved || !resolved.version) {
      errors.push(
        `  [resolution] "${name}" is declared but has no resolved "${resolvedKey}" entry in the lockfile. ` +
          'The lockfile is stale or partial; regenerate it.',
      );
    }
  }

  return { errors, warnings };
}

function main(): void {
  if (!fs.existsSync(PKG_PATH)) {
    console.log('⏭️  cloud-service/package.json not found — skipping.');
    return;
  }
  if (!fs.existsSync(LOCK_PATH)) {
    console.error(
      '❌ cloud-service/package.json exists but cloud-service/package-lock.json is missing.\n' +
        '   The cloud Docker build runs `npm ci`, which requires a lockfile.\n' +
        '   Fix: cd cloud-service && npm install --package-lock-only\n',
    );
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')) as PackageJson;
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')) as Lockfile;

  const { errors, warnings } = checkCloudServiceLockfileParity(pkg, lock);

  for (const w of warnings) console.warn(`⚠️  ${w.trim()}`);

  if (errors.length > 0) {
    console.error(
      `\n❌ ${errors.length} cloud-service lockfile parity error(s):\n`,
    );
    for (const e of errors) console.error(e);
    console.error(
      '\ncloud-service/package.json and package-lock.json are out of sync.\n' +
        'The cloud Docker build (`npm ci`) will fail. Regenerate the lockfile:\n' +
        '  cd cloud-service && npm install --package-lock-only\n',
    );
    process.exit(1);
  }

  console.log('✔ cloud-service package.json ↔ package-lock.json are in parity.');
}

if (require.main === module) {
  main();
}
