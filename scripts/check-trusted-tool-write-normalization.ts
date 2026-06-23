#!/usr/bin/env npx tsx
/**
 * CI Validation: every trustedTools write must build toolId via canonical normalization.
 *
 * Origin: 260330_always_allow_staged_mcp_bug. The renderer stored a compound
 * `"${packageId}/${toolId}"` as a trustedTools entry's `toolId`, but the backend
 * compares against the BARE tool id (`getEffectiveToolIdentifier()` returns the
 * bare form), so "Always allow" silently never matched and users were re-prompted
 * forever. The fix introduced `bareToolId()` / the branded `BareToolId` type
 * (`src/shared/types/bareToolId.ts`) as the canonical write-path normalization.
 *
 * Today both production write paths normalize:
 *   - src/renderer/App.tsx (trustTool callback): `toolId: bareToolId(toolId)`
 *   - src/main/ipc/settingsHandlers.ts (trust handler): `toolId: bareToolId(args.toolId)`
 * and settings normalization re-canonicalizes on read. This gate locks that in:
 * any NEW object literal written into a `trustedTools:` array must build its
 * `toolId` from `bareToolId(...)` / `normalizeTrustedTools(...)`, not a raw string
 * or compound expression — so a future write site cannot reintroduce the drift.
 *
 * Detection: an object literal that is an element of a `trustedTools: [...]`
 * array-property assignment, whose `toolId` property initializer is NOT a call to
 * `bareToolId(...)` (and the array itself is not wrapped in `normalizeTrustedTools(...)`).
 *
 * Run: npx tsx scripts/check-trusted-tool-write-normalization.ts
 * @see src/shared/utils/trustedToolNormalization.ts (bareToolId / normalizeTrustedTools)
 * @see docs/postmortems/260330_always_allow_staged_mcp_bug_postmortem.md
 * @see docs/plans/260613_recs-safety-toolscope-guards/PLAN.md
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SCAN_ROOTS = [path.join(REPO_ROOT, 'src')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__tests__']);

const NORMALIZER_OK_RE = /TRUSTED_TOOL_WRITE_OK:/;

export interface TrustedToolWriteViolation {
  relativePath: string;
  line: number;
  detail: string;
}

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
    if (st.isDirectory()) walk(full, acc);
    else if (SOURCE_EXTENSIONS.has(path.extname(full)) && !isTestFile(full)) acc.push(full);
  }
  return acc;
}

/** Is this expression a call to bareToolId(...) (the canonical toolId normalizer)? */
function isBareToolIdCall(expr: ts.Expression): boolean {
  return (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'bareToolId'
  );
}

/**
 * Collect identifiers assigned the result of `bareToolId(...)` anywhere in the
 * file (e.g. `const canonical = bareToolId(toolId)`), so a write that does
 * `toolId: canonical` is recognized as normalized. File-scoped is sufficient:
 * these write callbacks are small and the const sits next to the write.
 */
function collectBareToolIdIdentifiers(sf: ts.SourceFile): Set<string> {
  const ids = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      isBareToolIdCall(n.initializer)
    ) {
      ids.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return ids;
}

/** Is the toolId initializer normalized — a direct bareToolId() call or a const that was? */
function toolIdIsNormalized(init: ts.Expression, normalizedIds: Set<string>): boolean {
  if (isBareToolIdCall(init)) return true;
  if (ts.isIdentifier(init) && normalizedIds.has(init.text)) return true;
  return false;
}

/** Is this array expression wrapped/produced by normalizeTrustedTools(...)? */
function isNormalizeWrapped(expr: ts.Expression): boolean {
  return (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'normalizeTrustedTools'
  );
}

/**
 * Inspect a `trustedTools:` property assignment. The value may be:
 *   - normalizeTrustedTools(...)         → OK wholesale
 *   - an array literal of object entries → each entry's toolId must be bareToolId(...)
 *   - a spread of an existing array      → carried-forward entries are already canonical
 *   - some other identifier/expression   → not a literal write; out of scope
 */
function inspectTrustedToolsValue(
  value: ts.Expression,
  sf: ts.SourceFile,
  relativePath: string,
  sourceText: string,
  normalizedIds: Set<string>,
  out: TrustedToolWriteViolation[],
): void {
  if (isNormalizeWrapped(value)) return;

  if (ts.isArrayLiteralExpression(value)) {
    for (const el of value.elements) {
      if (ts.isSpreadElement(el)) continue; // existing entries, already canonical
      if (!ts.isObjectLiteralExpression(el)) continue;
      const toolIdProp = el.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) &&
          ((ts.isIdentifier(p.name) && p.name.text === 'toolId') ||
            (ts.isStringLiteralLike(p.name) && p.name.text === 'toolId')),
      );
      if (!toolIdProp) continue; // no toolId in this literal; not a trusted-tool write entry
      if (toolIdIsNormalized(toolIdProp.initializer, normalizedIds)) continue; // ✓ normalized
      // Marker escape hatch on the entry.
      const slice = sourceText.slice(el.getFullStart(), el.getEnd());
      if (NORMALIZER_OK_RE.test(slice)) continue;
      const { line } = sf.getLineAndCharacterOfPosition(toolIdProp.getStart(sf));
      out.push({
        relativePath,
        line: line + 1,
        detail: 'trustedTools entry toolId not built via bareToolId(...)',
      });
    }
  }
}

export function scanSourceForTrustedWrites(
  sourceText: string,
  relativePath: string,
): TrustedToolWriteViolation[] {
  const sf = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const out: TrustedToolWriteViolation[] = [];
  const normalizedIds = collectBareToolIdIdentifiers(sf);

  const visit = (n: ts.Node): void => {
    // `trustedTools: <value>` as a property assignment (object spread update or
    // direct store assignment both surface as a property assignment here).
    if (
      ts.isPropertyAssignment(n) &&
      ((ts.isIdentifier(n.name) && n.name.text === 'trustedTools') ||
        (ts.isStringLiteralLike(n.name) && n.name.text === 'trustedTools'))
    ) {
      inspectTrustedToolsValue(n.initializer, sf, relativePath, sourceText, normalizedIds, out);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function findUnnormalizedTrustedWrites(): TrustedToolWriteViolation[] {
  const files = SCAN_ROOTS.flatMap((root) => walk(root));
  const out: TrustedToolWriteViolation[] = [];
  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    out.push(...scanSourceForTrustedWrites(text, toPosix(path.relative(REPO_ROOT, abs))));
  }
  return out;
}

export function main(): void {
  const violations = findUnnormalizedTrustedWrites();
  if (violations.length === 0) {
    console.log(
      '✓ check-trusted-tool-write-normalization: every trustedTools write builds toolId via bareToolId().',
    );
    return;
  }
  console.error(
    '✗ check-trusted-tool-write-normalization: trustedTools write(s) with an un-normalized toolId:',
  );
  for (const v of violations) {
    console.error(`  - ${v.relativePath}:${v.line}  ${v.detail}`);
  }
  console.error('');
  console.error('A trustedTools entry must store the BARE tool id, never a compound');
  console.error('"packageId/toolId" or raw string (260330: compound ids made "Always allow"');
  console.error('silently never match). Normalize on write:');
  console.error('  import { bareToolId } from "@shared/utils/trustedToolNormalization";');
  console.error('  trustedTools: [...existing, { toolId: bareToolId(toolId), ... }]');
  console.error('or wrap the whole array in normalizeTrustedTools(...).');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
