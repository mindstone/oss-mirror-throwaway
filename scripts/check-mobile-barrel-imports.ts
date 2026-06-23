#!/usr/bin/env npx tsx
/**
 * CI Validation: Mobile barrel value-import boundary (recs-drain #38)
 *
 * Rejects *value* imports from broad `@shared/**` barrel modules (the
 * `export *` index/barrel files) inside `mobile/**`, while ALLOWING type-only
 * imports (`import type { X }`, `import { type X }`) — which erase at compile
 * and pull no runtime dependency.
 *
 * Why: `tsc` resolves `@shared/*` via tsconfig paths and sees the whole
 * monorepo, but Metro/Jest resolve against `mobile/`'s own
 * `node_modules`/`package.json`. A broad barrel value-import drags in whatever
 * the barrel transitively `import`s at runtime; e.g. `@shared/ipc/schemas`
 * (`src/shared/ipc/schemas/index.ts`) `export *`s `automations` which imports
 * `luxon`, a dep NOT declared in `mobile/package.json`. That breaks Metro/Jest
 * module resolution — invisible to `tsc` and to narrow component tests. The fix
 * is always available: import the specific leaf module
 * (`@shared/ipc/schemas/<leaf>`) instead of the barrel.
 *
 * CRITICAL — AST, not regex. Unlike the sibling regex scanner
 * `scripts/check-cross-surface-imports.ts`, this gate MUST use the TypeScript
 * parser because type-only imports can span multiple lines, e.g.:
 *     import type {
 *       UserQuestion,
 *       UserQuestionAnswer,
 *     } from '@shared/types';
 * A line-based scanner matching `} from '@shared/types'` would false-positive
 * that legitimate type-only import. We walk ImportDeclaration nodes and inspect
 * the ImportClause's `isTypeOnly` flag (mirrors scripts/check-mobile-test-runner.ts).
 * We also walk ExportDeclaration nodes: value re-exports
 * (`export { X } from '@shared/types'`, `export * from '@shared/ipc/schemas'`)
 * are runtime pulls and flag; type-only re-exports (`export type { X } ...`,
 * `export type * ...`) erase and are allowed.
 *
 * Allowlist semantics: exact `(file, specifier)` pairs (empty at ship — zero
 * violations today). `--expected-count` ratchets the allowlist length.
 *
 * Run: npx tsx scripts/check-mobile-barrel-imports.ts
 * Wired into: npm run validate:fast (validate:mobile-barrel-imports)
 *
 * @see scripts/check-cross-surface-imports.ts (sibling allowlist/ratchet shape)
 * @see scripts/check-mobile-test-runner.ts (sibling AST-walk shape)
 * @see docs/plans/260612_recs-static-gates/PLAN.md (Stage 1, item #38)
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MOBILE_ROOT = path.join(REPO_ROOT, 'mobile');

// Scan the WHOLE mobile/ tree (minus SKIP_DIRS), honouring the rec's
// `mobile/**` guarantee — not just src + app. This matches the sibling
// scripts/check-mobile-test-runner.ts, which walks MOBILE_ROOT. Covers
// mobile/modules/**, root JS configs, mocks, etc.
const SCAN_ROOTS = [MOBILE_ROOT];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

/**
 * The broad `@shared/**` barrels: the `export *` index/barrel modules under
 * `src/shared/` that mobile can reach via the `@shared/*` -> `../src/shared/*`
 * tsconfig path. Match the EXACT barrel specifier only — leaf paths like
 * `@shared/ipc/schemas/feedback` or `@shared/types/userQuestion` are SAFE
 * (they pull only their own deps) and must NOT flag.
 *
 * MAINTENANCE: if a new `export *` index/barrel module lands under
 * `src/shared/` that mobile can import, add its `@shared/...` specifier here.
 * Discover them with: grep -rl "export \*" src/shared --include=index.ts
 * (plus src/shared/types.ts, which is itself an `export *` barrel).
 */
export const BROAD_BARREL_SPECIFIERS: ReadonlyArray<string> = [
  '@shared/ipc/schemas', // src/shared/ipc/schemas/index.ts (export *; pulls luxon via automations)
  '@shared/ipc/channels', // src/shared/ipc/channels/index.ts (export *)
  '@shared/types', // src/shared/types.ts (export *)
];

export interface MobileBarrelAllowlistEntry {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

/**
 * Empty at ship — zero violations today (all mobile `@shared/*` imports are
 * leaf paths or `import type`). Each future entry must be an exact
 * `(file, specifier)` pair encoding a justified exception, and bump
 * `--expected-count` in lockstep.
 */
export const ALLOWLIST: ReadonlyArray<MobileBarrelAllowlistEntry> = [];

export interface MobileBarrelViolation {
  file: string;
  line: number;
  specifier: string;
  /** 'static' | 'dynamic-import' | 'require' | 'side-effect' | 'import-equals' | 're-export' | 're-export-star' */
  kind: string;
  text: string;
}

function normalisePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isBroadBarrel(specifier: string): boolean {
  return BROAD_BARREL_SPECIFIERS.includes(specifier);
}

/**
 * Decide whether an `import { ... }` declaration is a VALUE import that should
 * flag. Returns true only if it is NOT whole-statement type-only AND there is
 * at least one real value binding.
 *
 * - `import type { A } from 'x'`            -> clause.isTypeOnly === true  -> ALLOW
 * - `import { type A, type B } from 'x'`    -> every binding type-only     -> ALLOW
 * - `import { type A, B } from 'x'`         -> one real value binding (B)  -> FLAG
 * - `import Default from 'x'`               -> value default               -> FLAG
 * - `import * as ns from 'x'`               -> value namespace             -> FLAG
 * - `import 'x'` (no clause)                -> side-effect runtime pull     -> FLAG
 */
function isValueImportClause(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;

  // Bare side-effect import: `import '@shared/...'` — no clause, runtime pull.
  if (!clause) return true;

  // Whole-statement `import type { ... }` / `import type X` — erases entirely.
  if (clause.isTypeOnly) return false;

  // Default import binding (`import X from ...`) is always a value binding.
  if (clause.name) return true;

  const bindings = clause.namedBindings;
  if (!bindings) {
    // No name and no named bindings but not type-only — treat as runtime pull.
    return true;
  }

  // Namespace import (`import * as ns from ...`) is a value binding.
  if (ts.isNamespaceImport(bindings)) return true;

  // Named bindings: flag only if at least one is NOT individually type-only.
  if (ts.isNamedImports(bindings)) {
    return bindings.elements.some((element) => !element.isTypeOnly);
  }

  return true;
}

/**
 * Decide whether an `export ... from '@shared/...'` re-export is a VALUE
 * re-export that should flag. Re-exports from a barrel are runtime pulls just
 * like imports — `export { X } from '@shared/types'` and
 * `export * from '@shared/ipc/schemas'` drag the barrel's runtime deps into
 * the bundle. Type-only re-exports erase at compile and are allowed.
 *
 * - `export type { A } from 'x'`            -> node.isTypeOnly === true     -> ALLOW
 * - `export type * from 'x'`                -> node.isTypeOnly === true     -> ALLOW
 * - `export { type A, type B } from 'x'`    -> every element type-only      -> ALLOW
 * - `export { type A, B } from 'x'`         -> one real value element (B)   -> FLAG (re-export)
 * - `export { A } from 'x'`                 -> value re-export              -> FLAG (re-export)
 * - `export * from 'x'`                     -> value star re-export         -> FLAG (re-export-star)
 *
 * Mirrors the shape of `isValueImportClause`.
 */
function valueReExportKind(node: ts.ExportDeclaration): string | null {
  // Whole-statement `export type { ... }` / `export type * from ...` — erases.
  if (node.isTypeOnly) return null;

  const clause = node.exportClause;

  // Bare `export * from '<barrel>'` (no exportClause, not type-only) — value
  // star re-export pulling the whole barrel at runtime.
  if (!clause) return 're-export-star';

  // `export * as ns from '<barrel>'` (NamespaceExport) — value re-export.
  if (ts.isNamespaceExport(clause)) return 're-export';

  // Named re-exports: flag only if at least one element is NOT type-only.
  if (ts.isNamedExports(clause)) {
    return clause.elements.some((element) => !element.isTypeOnly) ? 're-export' : null;
  }

  return 're-export';
}

/**
 * Pure detection over a single source file's text. Parses via the TypeScript
 * AST and returns value imports of a broad `@shared` barrel. Exported for tests.
 */
export function findMobileBarrelViolations(
  source: string,
  filePath: string,
): MobileBarrelViolation[] {
  const violations: MobileBarrelViolation[] = [];
  const normalisedFile = normalisePath(filePath);

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(filePath),
  );

  function record(specifier: ts.StringLiteralLike, kind: string): void {
    if (!isBroadBarrel(specifier.text)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile));
    const lineNum = line + 1;
    const text = source.split('\n')[line]?.trim() ?? specifier.text;
    violations.push({
      file: normalisedFile,
      line: lineNum,
      specifier: specifier.text,
      kind,
      text,
    });
  }

  function visit(node: ts.Node): void {
    // Static `import ... from '@shared/...'` (incl. side-effect / multi-line).
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (isValueImportClause(node)) {
        const kind = node.importClause ? 'static' : 'side-effect';
        record(node.moduleSpecifier, kind);
      }
    } else if (
      // `export { X } from '@shared/...'` / `export * from '@shared/...'` —
      // value re-exports are runtime pulls just like value imports.
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const kind = valueReExportKind(node);
      if (kind) record(node.moduleSpecifier, kind);
    } else if (
      // `import x = require('@shared/...')`
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      // import-equals is always a value import (cannot be type-only).
      record(node.moduleReference.expression, 'import-equals');
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      // Dynamic `import('@shared/...')`
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && arg && ts.isStringLiteralLike(arg)) {
        record(arg, 'dynamic-import');
      } else if (
        // `require('@shared/...')`
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length === 1 &&
        arg &&
        ts.isStringLiteralLike(arg)
      ) {
        record(arg, 'require');
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

// ---------------------------------------------------------------------------
// File collection + CLI runner
// ---------------------------------------------------------------------------

function collectFiles(rootDir: string): string[] {
  const results: string[] = [];
  if (!existsSync(rootDir)) return results;

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const stats = statSync(fullPath, { throwIfNoEntry: false });
        if (!stats || !stats.isDirectory()) continue;
        walk(fullPath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return results;
}

function parseExpectedCount(args: readonly string[]): number | null {
  const inline = args.find((arg) => arg.startsWith('--expected-count='));
  const splitIndex = args.indexOf('--expected-count');
  const raw = inline
    ? inline.slice('--expected-count='.length)
    : splitIndex >= 0
      ? args[splitIndex + 1]
      : undefined;

  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --expected-count value: ${raw}`);
  }
  return parsed;
}

/**
 * Detect direct invocation so this module can be imported by tests without
 * running the scan. Mirrors scripts/check-cross-surface-imports.ts.
 */
function isDirectInvocation(): boolean {
  if (process.env.VITEST) return false;
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] !== undefined && process.argv[1].endsWith('check-mobile-barrel-imports.ts');
  }
}

function main(): void {
  let expectedCount: number | null = null;
  try {
    expectedCount = parseExpectedCount(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (expectedCount !== null && expectedCount !== ALLOWLIST.length) {
    console.error(
      `✗ Allowlist count mismatch: expected ${expectedCount}, actual ${ALLOWLIST.length}.\n` +
        'Update ALLOWLIST and --expected-count together.',
    );
    process.exitCode = 1;
    return;
  }

  const allowSet = new Set<string>(ALLOWLIST.map((entry) => `${entry.file} ${entry.specifier}`));

  console.log('Checking mobile barrel value-import discipline...\n');
  console.log(`Barrels: ${BROAD_BARREL_SPECIFIERS.join(', ')}`);
  console.log(`Allowlist: ${ALLOWLIST.length} entries\n`);

  const allViolations: MobileBarrelViolation[] = [];
  let scannedCount = 0;

  for (const root of SCAN_ROOTS) {
    const files = collectFiles(root);
    scannedCount += files.length;
    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      const relativePath = normalisePath(path.relative(REPO_ROOT, file));
      for (const violation of findMobileBarrelViolations(source, relativePath)) {
        const key = `${violation.file} ${violation.specifier}`;
        if (!allowSet.has(key)) allViolations.push(violation);
      }
    }
  }

  if (allViolations.length > 0) {
    console.error(`✗ Found ${allViolations.length} mobile barrel value-import violation(s):\n`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line} [${v.kind}] ${v.specifier}`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      'mobile/** must not VALUE-import a broad @shared barrel — these `export *`\n' +
        'modules transitively pull runtime deps (e.g. luxon via @shared/ipc/schemas)\n' +
        'that mobile/package.json does not declare, breaking Metro/Jest resolution.\n' +
        'Import the specific LEAF module instead, e.g.:\n' +
        "  import { ConversationFeedbackSchema } from '@shared/ipc/schemas/feedback';\n" +
        "  import { isApprovalClarificationBatch } from '@shared/types/userQuestion';\n" +
        'Type-only imports (`import type { X } from \'@shared/...\'`) are allowed — they\n' +
        'erase at compile and pull no runtime dependency.\n\n' +
        'See: scripts/check-mobile-barrel-imports.ts, docs/plans/260612_recs-static-gates/PLAN.md (Stage 1).',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `✓ ${scannedCount} files scanned under mobile/** — ` +
      `${ALLOWLIST.length} allowlisted imports preserved, no broad-barrel value imports.`,
  );
}

if (isDirectInvocation()) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to check mobile barrel imports: ${message}`);
    process.exitCode = 1;
  }
}
