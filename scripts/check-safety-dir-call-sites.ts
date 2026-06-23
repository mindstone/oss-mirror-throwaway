#!/usr/bin/env npx tsx
/**
 * CI Validation: safety primitives must be wired into the production graph.
 *
 * Every non-test module under `src/core/services/safety/` must be imported by at
 * least one OTHER non-test source file. A safety primitive with zero production
 * call sites is a guard that gives reviewers and operators false comfort while
 * doing nothing — the exact failure mode of
 * `260506_bash_protected_path_guard_unwired_in_pipeline`: a 255-line, fully-tested
 * `bashProtectedPathGuard.ts` shipped with ZERO callers and sat inert for ~28h
 * while a live credential-exfiltration exploit ran.
 *
 * This gate makes "added a safety file, forgot to wire it" fail at CI, not in
 * production. It is intentionally narrow (only the safety dir) and structural
 * (import-graph reachability), not behavioural.
 *
 * Allowlist: pure type/aggregator modules that legitimately have no runtime
 * callers of their own (barrels, type-only files) are exempted explicitly.
 *
 * Run: npx tsx scripts/check-safety-dir-call-sites.ts
 * @see docs/postmortems/260506_bash_protected_path_guard_unwired_in_pipeline_postmortem.md
 * @see docs/plans/260613_recs-safety-toolscope-guards/PLAN.md
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SAFETY_DIR = path.join(REPO_ROOT, 'src', 'core', 'services', 'safety');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__tests__']);

/**
 * Modules under the safety dir that legitimately need no production importer of
 * their own (type-only declarations, barrel re-export files). Keep this tight:
 * adding a runtime module here defeats the gate. Paths are repo-relative, POSIX.
 */
export const SAFETY_CALLSITE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // Barrels: re-export modules; their members are reached through the barrel.
  'src/core/services/safety/connectorApprovalGates/index.ts',
  'src/core/services/safety/outboundBroadcastGates/index.ts',
  // Type-only modules: no runtime surface to call.
  'src/core/services/safety/types.ts',
  'src/core/services/safety/connectorApprovalGates/types.ts',
  'src/core/services/safety/outboundBroadcastGates/types.ts',
]);

export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

function isTestFile(filePath: string): boolean {
  const posix = toPosix(filePath);
  return posix.includes('/__tests__/') || /\.(test|spec)\.[cm]?tsx?$/.test(posix);
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, acc);
    } else if (SOURCE_EXTENSIONS.has(path.extname(full)) && !isTestFile(full)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Extract the set of module specifiers imported/re-exported by a source file
 * (static import, `export ... from`, dynamic `import(...)`, and `require(...)`).
 */
export function extractModuleSpecifiers(sourceText: string, fileName = 'fixture.ts'): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return specifiers;
}

/**
 * Resolve a module specifier (alias or relative) to a repo-relative POSIX path
 * of a safety-dir module, or null if it does not target the safety dir.
 *
 * Handles the `@core/services/safety/...` alias (mapped to `src/core/...`) and
 * relative specifiers from a file inside `src/`. Tries `.ts`, `.tsx`, and
 * `/index.ts` resolution. We do not need full tsconfig path resolution — the
 * only target we care about is the safety directory.
 */
export function resolveToSafetyModule(
  specifier: string,
  importerAbsPath: string,
): string | null {
  let candidateAbs: string | null = null;

  if (specifier.startsWith('@core/')) {
    candidateAbs = path.join(SRC_ROOT, 'core', specifier.slice('@core/'.length));
  } else if (specifier.startsWith('.')) {
    candidateAbs = path.resolve(path.dirname(importerAbsPath), specifier);
  } else {
    return null; // bare package or other alias — not a safety-dir target
  }

  const tries = [
    candidateAbs,
    `${candidateAbs}.ts`,
    `${candidateAbs}.tsx`,
    path.join(candidateAbs, 'index.ts'),
    path.join(candidateAbs, 'index.tsx'),
  ];
  for (const t of tries) {
    const rel = toPosix(path.relative(REPO_ROOT, t));
    if (!rel.startsWith('src/core/services/safety/')) continue;
    try {
      if (statSync(t).isFile()) return rel;
    } catch {
      // not a file at this candidate; keep trying
    }
  }
  return null;
}

export interface OrphanResult {
  orphans: string[];
  scannedSafetyFiles: number;
  importerFiles: number;
}

export function findOrphanSafetyModules(): OrphanResult {
  const safetyFiles = walk(SAFETY_DIR).map((f) => toPosix(path.relative(REPO_ROOT, f)));
  // Every non-test source file in src/ is a potential importer.
  const allSrcFiles = walk(SRC_ROOT);

  const importedSafetyModules = new Set<string>();
  for (const importerAbs of allSrcFiles) {
    let text: string;
    try {
      text = readFileSync(importerAbs, 'utf8');
    } catch {
      continue;
    }
    const importerRel = toPosix(path.relative(REPO_ROOT, importerAbs));
    for (const spec of extractModuleSpecifiers(text, importerAbs)) {
      const resolved = resolveToSafetyModule(spec, importerAbs);
      if (!resolved) continue;
      // A file importing itself does not count as an external call site.
      if (resolved === importerRel) continue;
      importedSafetyModules.add(resolved);
    }
  }

  const orphans = safetyFiles
    .filter((f) => !SAFETY_CALLSITE_ALLOWLIST.has(f))
    .filter((f) => !importedSafetyModules.has(f))
    .sort();

  return {
    orphans,
    scannedSafetyFiles: safetyFiles.length,
    importerFiles: allSrcFiles.length,
  };
}

export function main(): void {
  const { orphans, scannedSafetyFiles, importerFiles } = findOrphanSafetyModules();
  if (orphans.length === 0) {
    console.log(
      `✓ check-safety-dir-call-sites: all ${scannedSafetyFiles} safety module(s) are wired ` +
        `(scanned ${importerFiles} production source files).`,
    );
    return;
  }
  console.error('✗ check-safety-dir-call-sites: safety module(s) with ZERO production call sites:');
  for (const o of orphans) console.error(`  - ${o}`);
  console.error('');
  console.error('A safety primitive that nothing imports is an unwired guard (see');
  console.error('260506_bash_protected_path_guard_unwired_in_pipeline: a tested guard sat');
  console.error('inert for ~28h while a live exploit ran). Wire the module into the privileged');
  console.error('path it protects, or — if it is genuinely a pure type/barrel module — add it');
  console.error('to SAFETY_CALLSITE_ALLOWLIST in scripts/check-safety-dir-call-sites.ts with a');
  console.error('reviewer-visible justification.');
  process.exit(1);
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
