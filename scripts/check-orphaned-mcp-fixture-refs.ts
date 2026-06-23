#!/usr/bin/env npx tsx
/**
 * Guard against orphaned bundled-MCP generated-artifact references in tests.
 *
 * WHY: docs-private/postmortems/260531_unblock_release_build_ci_by_removing_85de264_p3_postmortem.md
 * records a Release Build CI failure where `resources/mcp/openai-image/` had
 * been intentionally removed during OSS migration, but an integration test
 * still touched `resources/mcp-generated/openai-image/server.cjs`. Fresh CI had
 * no generated artifact, so the test ENOENT'd.
 *
 * Design:
 * - Enumerate the repo's test universe through git (`ls-files` tracked plus
 *   untracked-but-not-ignored, including initialized submodules), mirroring the
 *   collection semantics in scripts/checks/checkOrphanedTests.ts.
 * - Extract connector names referenced in two text forms used by migrated MCP
 *   tests:
 *   1. Any `mcp-generated/<name>/` path substring, with any prefix and with
 *      case-insensitive matching for `resources/` and `mcp-generated/`.
 *   2. Path-join-style string literal arguments where `'mcp-generated'` is
 *      immediately followed by a connector literal, e.g.
 *      `path.join(root, 'mcp-generated', '<name>', 'server.cjs')`.
 *   This is intentionally a text scan, not a TypeScript parse. It will not
 *   resolve computed connector names, variables, or non-adjacent path segments.
 * - Treat a reference as orphaned when `resources/mcp/<name>/` no longer exists
 *   and `<name>` is not explicitly exempted with a rationale. The generated
 *   directory is a build output and is often empty in a fresh checkout; source
 *   directory presence is the durable signal.
 * - Seed/maintain the allowlist only for intentional mock/persisted-config
 *   string references, not filesystem stat/spawn behavior. Stale allowlist
 *   entries fail when the source directory returns or the reference disappears.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitCapture } from './lib/git-exec.js';
import { readFileToleratingVanished } from './lib/safeScanRead.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/u;
const MCP_GENERATED_PATH_REF_RE = /(?:resources[\\/])?mcp-generated[\\/]([A-Za-z0-9._-]+)(?=[\\/])/giu;
const MCP_GENERATED_PATH_JOIN_REF_RE = /['"]mcp-generated['"]\s*,\s*['"]([A-Za-z0-9._-]+)['"]/giu;

export interface OrphanMcpFixtureRefAllowlistEntry {
  readonly name: string;
  readonly rationale: string;
}

export interface McpGeneratedReference {
  readonly connector: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface OrphanMcpFixtureRefFinding {
  readonly connector: string;
  readonly references: readonly McpGeneratedReference[];
}

export interface StaleOrphanMcpFixtureRefAllowlistEntry {
  readonly name: string;
  readonly reason: 'source-restored' | 'not-referenced';
}

export interface OrphanMcpFixtureRefCheckResult {
  readonly ok: boolean;
  readonly scannedTestFiles: number;
  readonly referencedConnectors: readonly string[];
  readonly sourceAbsentReferencedConnectors: readonly string[];
  readonly orphanedReferences: readonly OrphanMcpFixtureRefFinding[];
  readonly staleAllowlistEntries: readonly StaleOrphanMcpFixtureRefAllowlistEntry[];
  readonly invalidAllowlistEntries: readonly string[];
  /**
   * Connectors whose `resources/mcp/<name>/` exists locally but holds only
   * build/tooling output (stale artifacts predating the OSS migration). Absent
   * on a clean CI checkout, so this is advisory ONLY — it does NOT affect `ok`.
   * Surfaced so the fix is "rm the stale dir", not "edit the allowlist".
   */
  readonly staleLocalBuildArtifacts: readonly string[];
  /**
   * Count of test files enumerated by the walk but deleted before we could
   * read them (concurrent deletion / TOCTOU — see scripts/lib/safeScanRead.ts).
   * Benign under parallel test runs; surfaced (never silently swallowed).
   */
  readonly vanishedDuringScan: number;
}

export const ORPHAN_MCP_FIXTURE_REF_ALLOWLIST: readonly OrphanMcpFixtureRefAllowlistEntry[] = [
  {
    name: 'google-workspace',
    rationale:
      'Intentional path-rewrite test string in src/main/services/__tests__/mcpConfigManager.test.ts; it uses injected fakeAccess and does not stat or spawn the generated artifact.',
  },
  {
    name: 'salesforce',
    rationale:
      'Intentional persisted-config migration strings in src/main/services/__tests__/credential-loss-prod-readiness.test.ts and src/main/services/__tests__/bundledMcpManager.test.ts; the tests rewrite legacy config paths and do not stat or spawn the generated artifact.',
  },
  {
    name: 'slack',
    rationale:
      'Intentional mocked cloud-registration config string in src/main/services/__tests__/bundledMcpCloudRegistration.test.ts for an OSS-migrated connector; the test does not stat or spawn the generated artifact.',
  },
  {
    name: 'microsoft-mail',
    rationale:
      'Intentional legacy-shape payload-builder mock in src/main/services/__tests__/bundledMcpCloudRegistration.test.ts (buildMicrosoft365MailPayload) for an OSS-migrated connector; the obsolete resources/mcp/microsoft-* source trees were deleted (production runs @mindstone/mcp-server-microsoft-* via catalog npx). The test asserts catalogId-based registration behavior and does not stat or spawn the generated artifact.',
  },
];

function toPosix(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function gitLines(args: readonly string[], cwd: string): string[] {
  return gitCapture([...args], { cwd, maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((line) => line.length > 0)
    .map(toPosix);
}

function submodulePaths(repoRoot: string): string[] {
  const gitmodules = path.join(repoRoot, '.gitmodules');
  if (!existsSync(gitmodules)) return [];

  const out = gitCapture(['config', '--file', '.gitmodules', '--get-regexp', String.raw`\.path$`], {
    cwd: repoRoot,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(' ').slice(1).join(' '))
    .map(toPosix);
}

export function collectTestFiles(repoRoot = DEFAULT_REPO_ROOT): string[] {
  const files = new Set<string>();

  for (const file of gitLines(['ls-files', '--recurse-submodules', '-z'], repoRoot)) {
    if (TEST_FILE_RE.test(file)) files.add(file);
  }

  for (const file of gitLines(['ls-files', '--others', '--exclude-standard', '-z'], repoRoot)) {
    if (TEST_FILE_RE.test(file)) files.add(file);
  }

  for (const submodulePath of submodulePaths(repoRoot)) {
    const submoduleRoot = path.join(repoRoot, submodulePath);
    if (!existsSync(path.join(submoduleRoot, '.git'))) continue;

    for (const file of gitLines(['ls-files', '--others', '--exclude-standard', '-z'], submoduleRoot)) {
      if (TEST_FILE_RE.test(file)) files.add(`${submodulePath}/${file}`);
    }
  }

  return [...files].sort((a, b) => a.localeCompare(b));
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function lineTextAt(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const nextLine = source.indexOf('\n', index);
  const lineEnd = nextLine === -1 ? source.length : nextLine;
  return source.slice(lineStart, lineEnd).trim();
}

function collectReferencesForPattern(
  source: string,
  file: string,
  pattern: RegExp,
  seen: Set<string>,
): McpGeneratedReference[] {
  const references: McpGeneratedReference[] = [];

  for (const match of source.matchAll(pattern)) {
    const connector = match[1]?.toLowerCase();
    if (!connector) continue;

    const index = match.index ?? 0;
    const dedupeKey = `${file}:${index}:${connector}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    references.push({
      connector,
      file,
      line: lineNumberAt(source, index),
      text: lineTextAt(source, index),
    });
  }

  return references;
}

export function collectMcpGeneratedReferences(
  repoRoot = DEFAULT_REPO_ROOT,
  testFiles = collectTestFiles(repoRoot),
  // Optional mutable sink so callers (checkOrphanedMcpFixtureRefs) can observe
  // how many files vanished mid-scan without changing this function's return.
  counters?: { vanished: number },
): McpGeneratedReference[] {
  const references: McpGeneratedReference[] = [];

  for (const file of testFiles) {
    const absPath = path.join(repoRoot, file);
    // ENOENT-tolerant read (scripts/lib/safeScanRead.ts): a file deleted
    // between `git ls-files` enumeration and read (concurrent deletion /
    // TOCTOU) returns null and is skipped + counted; a present-but-unreadable
    // file rethrows (fail-closed).
    const source = readFileToleratingVanished(absPath);
    if (source === null) {
      if (counters) counters.vanished += 1;
      continue;
    }
    const seen = new Set<string>();
    references.push(
      ...collectReferencesForPattern(source, file, MCP_GENERATED_PATH_REF_RE, seen),
      ...collectReferencesForPattern(source, file, MCP_GENERATED_PATH_JOIN_REF_RE, seen),
    );
  }

  return references.sort((a, b) => (
    a.connector.localeCompare(b.connector) ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  ));
}

/**
 * Directory entries that are purely build/tooling output, never connector
 * source. A `resources/mcp/<name>/` containing ONLY these (common local cruft
 * left over from before a connector was migrated to the OSS submodule) is NOT
 * a genuine source directory — the source moved out, only build artifacts
 * remain. The script's durable signal is "source directory present", and build
 * output is not source.
 */
const BUILD_ARTIFACT_ENTRIES: ReadonlySet<string> = new Set([
  'build',
  'dist',
  'node_modules',
  '.turbo',
  'coverage',
  '.DS_Store',
]);

type ConnectorDirState = 'absent' | 'build-cruft' | 'genuine-source';

/**
 * Classifies `resources/mcp/<name>/`:
 *   - `absent`         — directory does not exist (the clean-CI state).
 *   - `build-cruft`    — exists but every entry is build/tooling output (or it's
 *                        empty): a stale LOCAL artifact, absent on fresh CI.
 *   - `genuine-source` — exists with real content (src/, package.json, etc.).
 *
 * Fail-safe: if the directory can't be read, treat it as `genuine-source` (the
 * conservative side — never silently downgrade something we couldn't inspect
 * into "absent", which would manufacture a spurious orphan).
 */
function classifyConnectorDir(repoRoot: string, connector: string): ConnectorDirState {
  const dir = path.join(repoRoot, 'resources', 'mcp', connector);
  if (!existsSync(dir)) {
    return 'absent';
  }
  // Stat + readdir inside one fail-safe: a stat/readdir race or error must NOT
  // throw, and must classify conservatively as genuine-source (never manufacture
  // a spurious orphan from something we couldn't inspect).
  try {
    if (!statSync(dir).isDirectory()) {
      return 'absent';
    }
    const entries = readdirSync(dir);
    const hasRealContent = entries.some((entry) => !BUILD_ARTIFACT_ENTRIES.has(entry));
    return hasRealContent ? 'genuine-source' : 'build-cruft';
  } catch {
    return 'genuine-source';
  }
}

function sourceDirExists(repoRoot: string, connector: string): boolean {
  // A build-cruft directory is treated like an absent one: the connector's real
  // source is gone, so its generated artifact won't exist on a clean checkout.
  return classifyConnectorDir(repoRoot, connector) === 'genuine-source';
}

function groupReferencesByConnector(
  references: readonly McpGeneratedReference[],
): Map<string, McpGeneratedReference[]> {
  const grouped = new Map<string, McpGeneratedReference[]>();
  for (const ref of references) {
    const existing = grouped.get(ref.connector) ?? [];
    existing.push(ref);
    grouped.set(ref.connector, existing);
  }
  return grouped;
}

export function checkOrphanedMcpFixtureRefs(
  repoRoot = DEFAULT_REPO_ROOT,
  opts: {
    readonly allowlist?: readonly OrphanMcpFixtureRefAllowlistEntry[];
    readonly testFiles?: readonly string[];
  } = {},
): OrphanMcpFixtureRefCheckResult {
  const allowlist = opts.allowlist ?? ORPHAN_MCP_FIXTURE_REF_ALLOWLIST;
  const testFiles = [...(opts.testFiles ?? collectTestFiles(repoRoot))];
  const scanCounters = { vanished: 0 };
  const references = collectMcpGeneratedReferences(repoRoot, testFiles, scanCounters);
  const referencesByConnector = groupReferencesByConnector(references);
  const referencedConnectors = [...referencesByConnector.keys()].sort((a, b) => a.localeCompare(b));
  const allowlistedNames = new Set(allowlist.map((entry) => entry.name));
  const invalidAllowlistEntries = allowlist
    .filter((entry) => entry.rationale.trim().length === 0)
    .map((entry) => entry.name);

  const sourceAbsentReferencedConnectors = referencedConnectors
    .filter((connector) => !sourceDirExists(repoRoot, connector))
    .sort((a, b) => a.localeCompare(b));

  const orphanedReferences = sourceAbsentReferencedConnectors
    .filter((connector) => !allowlistedNames.has(connector))
    .map((connector) => ({
      connector,
      references: referencesByConnector.get(connector) ?? [],
    }));

  const staleAllowlistEntries: StaleOrphanMcpFixtureRefAllowlistEntry[] = [];
  for (const entry of allowlist) {
    if (sourceDirExists(repoRoot, entry.name)) {
      staleAllowlistEntries.push({ name: entry.name, reason: 'source-restored' });
    } else if (!referencesByConnector.has(entry.name)) {
      staleAllowlistEntries.push({ name: entry.name, reason: 'not-referenced' });
    }
  }

  // Advisory (non-failing): connectors of interest whose dir is local build
  // cruft. These used to masquerade as 'source-restored' and produce a
  // misleading "remove the allowlist entry" failure; now the actionable fix
  // (rm the stale dir) is surfaced without blocking the local run — on a clean
  // CI checkout the dir is absent and this list is empty.
  const staleLocalBuildArtifacts = [
    ...new Set([...allowlistedNames, ...referencedConnectors]),
  ]
    .filter((connector) => classifyConnectorDir(repoRoot, connector) === 'build-cruft')
    .sort((a, b) => a.localeCompare(b));

  return {
    ok:
      orphanedReferences.length === 0 &&
      staleAllowlistEntries.length === 0 &&
      invalidAllowlistEntries.length === 0,
    scannedTestFiles: testFiles.length,
    vanishedDuringScan: scanCounters.vanished,
    referencedConnectors,
    sourceAbsentReferencedConnectors,
    orphanedReferences,
    staleAllowlistEntries,
    invalidAllowlistEntries,
    staleLocalBuildArtifacts,
  };
}

function formatFailure(result: OrphanMcpFixtureRefCheckResult): string {
  const lines: string[] = [];

  for (const name of result.invalidAllowlistEntries) {
    lines.push(
      `- allowlist entry "${name}" has an empty rationale; add a specific reason or remove the exemption.`,
    );
  }

  for (const finding of result.orphanedReferences) {
    lines.push(`- orphaned generated MCP fixture reference for "${finding.connector}":`);
    for (const ref of finding.references) {
      lines.push(`  ${ref.file}:${ref.line}  ${ref.text}`);
    }
    lines.push(
      `  resources/mcp/${finding.connector}/ does not exist. If this is only a mock/persisted-config string and not a filesystem stat/spawn, add { name: '${finding.connector}', rationale: '<why safe>' } to ORPHAN_MCP_FIXTURE_REF_ALLOWLIST in scripts/check-orphaned-mcp-fixture-refs.ts; otherwise remove or update the test reference.`,
    );
  }

  for (const entry of result.staleAllowlistEntries) {
    const reason =
      entry.reason === 'source-restored'
        ? `resources/mcp/${entry.name}/ exists again`
        : 'no test file references mcp-generated for this connector';
    lines.push(
      `- stale allowlist entry "${entry.name}" (${reason}); remove it from ORPHAN_MCP_FIXTURE_REF_ALLOWLIST.`,
    );
  }

  return lines.join('\n');
}

function formatBuildCruftAdvisory(connectors: readonly string[]): string {
  const list = connectors.join(', ');
  return (
    `[check-orphaned-mcp-fixture-refs] NOTE: stale local build artifacts at ` +
    `resources/mcp/{${list}}/ — these hold only build output (no source), are ` +
    `absent on a clean CI checkout, and predate the OSS migration. Remove them ` +
    `(e.g. \`rm -rf resources/mcp/{${list}}\`) rather than editing the allowlist.\n`
  );
}

export function runCli(repoRoot = DEFAULT_REPO_ROOT): number {
  const result = checkOrphanedMcpFixtureRefs(repoRoot);
  const absent = result.sourceAbsentReferencedConnectors.length > 0
    ? result.sourceAbsentReferencedConnectors.join(', ')
    : 'none';

  // Advisory first (non-failing) so it's visible on both PASS and FAIL.
  if (result.staleLocalBuildArtifacts.length > 0) {
    process.stderr.write(formatBuildCruftAdvisory(result.staleLocalBuildArtifacts));
  }

  // Observability for concurrent-deletion skips (never silent). Informational
  // only — does NOT affect the exit code.
  if (result.vanishedDuringScan > 0) {
    process.stderr.write(
      `[check-orphaned-mcp-fixture-refs] NOTE: ${result.vanishedDuringScan} file(s) vanished ` +
        `mid-scan (concurrent deletion); skipped.\n`,
    );
  }

  if (result.ok) {
    process.stdout.write(
      `[check-orphaned-mcp-fixture-refs] PASS: scanned ${result.scannedTestFiles} test file(s); ` +
        `generated-artifact connectors referenced: ${result.referencedConnectors.length}; ` +
        `source-absent referenced connectors: ${absent}.\n`,
    );
    return 0;
  }

  process.stderr.write(
    `[check-orphaned-mcp-fixture-refs] FAIL: scanned ${result.scannedTestFiles} test file(s).\n` +
      `${formatFailure(result)}\n`,
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
