#!/usr/bin/env npx tsx
/**
 * Equivalence gate for the vendored `atomicCredentialWrite.ts` helper.
 *
 * The host copy at `src/core/utils/atomicCredentialWrite.ts` is canonical. Every
 * OSS-vendored copy in the `mcp-servers` repo MUST stay byte-equivalent to it,
 * modulo (a) the import line (host uses the `@core` alias; OSS uses a relative
 * `./emfileRetry.js` path) and (b) the leading `// vendored from …` header block.
 *
 * Why this gate exists / how it rots: the previous version hardcoded a *sibling*
 * clone root (`../mcp-servers`, predating the 2026-05-25 submodule) and a package
 * path that no longer exists (`packages/mcp-server-hubspot` → `connectors/hubspot`),
 * and treated "file not found" as an acceptable steady state (silent SKIP). It was
 * inert for weeks while real drift accumulated. The kill-by-construction fix: when a
 * real `mcp-servers` root is present (the universal state now — it is a submodule),
 * discovering ZERO helper copies is a HARD FAIL naming the path-rot, not a SKIP.
 *
 * Dependency-light by design (node builtins only): runs inside `validate:fast`.
 *
 * @see docs/plans/260611_fix-mcp-equivalence-gate/PLAN.md
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

/**
 * Bounded glob roots inside the mcp-servers repo where a vendored copy may live.
 * Bounded (one path segment, fixed suffix) so we never match generated artifacts
 * (`dist/`) or test fixtures via a recursive walk.
 */
const COPY_GLOB_DIRS = ['connectors', 'packages'] as const;
const COPY_SUFFIX = path.join('src', 'utils', 'atomicCredentialWrite.ts');

/**
 * A content marker proving an mcp-servers root is genuinely the repo (not a bare
 * empty dir from an uninitialized submodule). We require the `connectors/` dir.
 */
function isMcpServersRoot(root: string): boolean {
  try {
    return fs.statSync(path.join(root, 'connectors')).isDirectory();
  } catch {
    return false;
  }
}

export type RootResolution =
  | { kind: 'resolved'; root: string; source: 'env' | 'submodule' | 'sibling' }
  | { kind: 'none' };

/**
 * Resolution ladder (mirrors scripts/dev-mcp-managed-install.ts):
 *   1. env `MCP_SERVERS_REPO` (explicit override — used by CI / out-of-tree clones)
 *   2. in-repo submodule `<repo>/mcp-servers` when *initialized* (content marker,
 *      not bare dir existence — an uninitialized submodule is an empty dir)
 *   3. legacy sibling `<repo>/../mcp-servers`
 * An env override that points at a non-repo is still honored as `resolved` so the
 * caller fails loud (path-rot) rather than silently falling through to the sibling.
 */
export function resolveMcpServersRoot(repo: string, env: NodeJS.ProcessEnv = process.env): RootResolution {
  const override = env.MCP_SERVERS_REPO;
  if (override) {
    return { kind: 'resolved', root: path.resolve(override), source: 'env' };
  }
  const submodule = path.join(repo, 'mcp-servers');
  if (isMcpServersRoot(submodule)) {
    return { kind: 'resolved', root: submodule, source: 'submodule' };
  }
  const sibling = path.join(repo, '..', 'mcp-servers');
  if (isMcpServersRoot(sibling)) {
    return { kind: 'resolved', root: path.resolve(sibling), source: 'sibling' };
  }
  return { kind: 'none' };
}

/**
 * Discover every vendored copy under the bounded glob roots
 * (`connectors/*​/src/utils/atomicCredentialWrite.ts`,
 *  `packages/*​/src/utils/atomicCredentialWrite.ts`). Returns absolute paths, sorted.
 */
export function discoverCopies(root: string): string[] {
  const found: string[] = [];
  for (const dir of COPY_GLOB_DIRS) {
    const base = path.join(root, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name, COPY_SUFFIX);
      if (fs.existsSync(candidate)) {
        found.push(candidate);
      }
    }
  }
  return found.sort();
}

/**
 * Canonicalize for comparison:
 *  - normalize CRLF → LF
 *  - strip the FULL contiguous leading vendored-header block (multi-line: both the
 *    `// vendored from …` line and the `// keep byte-equivalent …` line). A
 *    single-line strip would leave the second header line in OSS copies and never
 *    match host (the F4 bug).
 *  - replace local/aliased import lines with a stable placeholder (host `@core` vs
 *    OSS `./emfileRetry.js` differ legitimately).
 */
export function canonicalize(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^(?:\/\/\s*(?:vendored from|keep byte-equivalent).*\n)+/i, '')
    .replace(/^import.*from\s+['"][./@].*['"].*$/gm, '// IMPORT_STRIPPED')
    .trim();
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export type CheckResult =
  | { status: 'pass'; hash: string; copies: string[] }
  | { status: 'skip'; message: string }
  | { status: 'fail'; message: string; details: string[] };

/**
 * Pure evaluation core — testable without spawning. The CLI `main()` wraps it.
 */
export function evaluate(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
): CheckResult {
  if (!fs.existsSync(hostHelperPathFor(repo))) {
    return { status: 'fail', message: `Host helper missing: ${hostHelperPathFor(repo)}`, details: [] };
  }

  const requireEquivalence = env.REQUIRE_MCP_OSS_EQUIVALENCE === '1';
  const resolution = resolveMcpServersRoot(repo, env);

  if (resolution.kind === 'none') {
    const msg =
      'mcp-servers root not found (submodule uninitialized and no sibling clone).\n' +
      'Run `git submodule update --init mcp-servers` to enable the equivalence check.';
    if (requireEquivalence) {
      return {
        status: 'fail',
        message: `${msg}\nREQUIRE_MCP_OSS_EQUIVALENCE=1 forbids skipping.`,
        details: [],
      };
    }
    return { status: 'skip', message: msg };
  }

  const copies = discoverCopies(resolution.root);
  if (copies.length === 0) {
    // PATH ROT: a real mcp-servers root is present but no vendored copy was found.
    // This is exactly how the prior gate silently rotted — treat it as a hard fail.
    return {
      status: 'fail',
      message:
        `Path rot: mcp-servers root present (${resolution.source}: ${resolution.root}) ` +
        'but ZERO vendored atomicCredentialWrite.ts copies discovered.\n' +
        `Searched: ${COPY_GLOB_DIRS.map((d) => path.join(d, '*', COPY_SUFFIX)).join(', ')}\n` +
        'Either the vendored copies moved (fix the glob roots in this script) or were removed.',
      details: [],
    };
  }

  const hostCanonical = canonicalize(fs.readFileSync(hostHelperPathFor(repo), 'utf8'));
  const hostHash = sha256(hostCanonical);

  const mismatches: string[] = [];
  const perFile: string[] = [`host  ${hostHash}  ${hostHelperPathFor(repo)}`];
  for (const copy of copies) {
    const copyHash = sha256(canonicalize(fs.readFileSync(copy, 'utf8')));
    perFile.push(`copy  ${copyHash}  ${copy}`);
    if (copyHash !== hostHash) {
      mismatches.push(copy);
    }
  }

  if (mismatches.length > 0) {
    return {
      status: 'fail',
      message:
        `atomicCredentialWrite helper mismatch: ${mismatches.length} of ${copies.length} ` +
        'OSS copies differ from the host canonical.\n' +
        `Mismatched:\n  ${mismatches.join('\n  ')}`,
      details: perFile,
    };
  }

  return { status: 'pass', hash: hostHash, copies };
}

function hostHelperPathFor(repo: string): string {
  return path.join(repo, 'src/core/utils/atomicCredentialWrite.ts');
}

function main(): void {
  const result = evaluate(repoRoot);
  switch (result.status) {
    case 'pass':
      console.log(`✅ atomicCredentialWrite helper equivalence check passed (${result.copies.length} OSS copies).`);
      console.log(`SHA256: ${result.hash}`);
      process.exit(0);
      break;
    case 'skip':
      console.warn(`⚠️ SKIP: ${result.message}`);
      process.exit(0);
      break;
    case 'fail':
      console.error(`❌ ${result.message}`);
      for (const line of result.details) {
        console.error(line);
      }
      process.exit(1);
      break;
    default: {
      // Exhaustiveness backstop (CheckResult is a closed, locally-owned union):
      // a future status added without a case here must not fall through to a
      // silent exit 0 — that is the silent-pass class this gate exists to kill.
      const unhandled: never = result;
      console.error(`❌ Unhandled check status: ${JSON.stringify(unhandled)}`);
      process.exit(1);
    }
  }
}

// Only run when invoked directly (not when imported by tests).
if (require.main === module) {
  main();
}
