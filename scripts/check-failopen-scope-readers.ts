#!/usr/bin/env npx tsx
/**
 * CI Validation: scope / credential / account readers must not silently fail OPEN.
 *
 * Origin: 260531_close_two_adjacent_silent_failure_paths. The OSS HubSpot
 * `getScopeTier()` swallowed errors in an empty catch and returned the literal
 * `'full'` — a corrupt or unreadable `accounts.json` silently EXPANDED the
 * available tool surface to the most-privileged tier. Sibling host `loadToken()`
 * caught every read/parse error
 * and returned `null`, making unreadable/corrupt credential files
 * indistinguishable from absent ones.
 *
 * This gate is deliberately NARROW to keep false-positives near zero (the broad
 * "any catch that returns empty" shape is FP-heavy — see the path-containment
 * FP-spike in 260531_bug_4). It only inspects:
 *   - functions whose NAME marks them as a scope/account/credential/token reader
 *     (getScopeTier, scopeTier, getAccounts, loadAccounts, loadToken, readToken,
 *      getCredentials, loadCredentials, …), AND
 *   - catch blocks inside those functions whose body RETURNS a permissive default:
 *       * an empty array literal              → empty account/scope list
 *       * `null` / `undefined`                → absent-as-success
 *       * a known permissive scope literal    → 'full' | 'admin' | 'all' | 'write'
 *
 * A flagged catch clears the gate if it demonstrably fails closed / discriminates:
 *   - it rethrows (`throw`), OR
 *   - it discriminates ENOENT before returning (an explicit "absent is empty,
 *     everything else is loud" branch), OR
 *   - it carries an explicit reviewer marker comment: `FAIL_CLOSED_OK:` /
 *     `SCOPE_FAIL_CLOSED_OK:` with a justification.
 *
 * Run: npx tsx scripts/check-failopen-scope-readers.ts
 * @see docs/postmortems/260531_close_two_adjacent_silent_failure_paths_58ae27c_postmortem.md
 * @see docs/plans/260613_recs-safety-toolscope-guards/PLAN.md
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/** Directories whose credential/scope readers we scan. */
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'src', 'main', 'services'),
  path.join(REPO_ROOT, 'src', 'core', 'services'),
  path.join(REPO_ROOT, 'cloud-service', 'src'),
  path.join(REPO_ROOT, 'resources', 'mcp'),
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__tests__']);

/** Function-name heuristics that mark a scope/credential/account/token reader. */
const READER_NAME_RE =
  /(scopetier|getscope|getaccounts?|loadaccounts?|readaccounts?|loadtoken|readtoken|gettoken|getcredentials?|loadcredentials?|readcredentials?)/i;

/** Permissive scope/tier string literals that must never be a fail-OPEN default. */
const PERMISSIVE_SCOPE_LITERALS = new Set(['full', 'admin', 'all', 'write', 'readwrite', 'rw']);

/** Reviewer escape-hatch markers (must carry a justification after the colon). */
const FAIL_CLOSED_MARKER_RE = /\b(?:SCOPE_)?FAIL_CLOSED_OK:/;

/**
 * Pre-existing fail-open readers, recorded so this gate enforces
 * "no NEW fail-open scope/credential reader" without forcing a same-PR rewrite of
 * credential-resolution / OSS-connector files owned by other workstreams.
 *
 * These are GENUINE instances of the same 260531 class (`catch { return null/[] }`
 * cannot distinguish an absent token/accounts file from a corrupt/unreadable one,
 * so corruption silently degrades to "no credential"/"no accounts" rather than a
 * loud failure). They are tracked as known debt — keyed by `relativePath::functionName`
 * (line-agnostic so edits elsewhere in the file don't reshuffle the baseline).
 *
 * To DRAIN an entry: make the reader fail closed (discriminate ENOENT, rethrow the
 * rest) — or, if the permissive default is genuinely correct, add a `FAIL_CLOSED_OK:`
 * marker in the catch — then delete it here. Never ADD to this set for new code; new
 * fail-open readers must fail the gate.
 *
 * @see docs/postmortems/260531_close_two_adjacent_silent_failure_paths_58ae27c_postmortem.md
 */
// Map of key → expected count, so a NEW fail-open return ADDED to an
// already-baselined reader (same file+function) is not silently absorbed
// (cross-family review BLOCKER, 260613): the gate compares live count per key
// against the baseline count and fails if it grows.
export const FAIL_OPEN_READER_BASELINE: ReadonlyMap<string, number> = new Map<string, number>([
  ['src/main/services/githubAuthService.ts::readTokensFile', 1],
  ['src/main/services/googleWorkspaceAuthService.ts::loadToken', 1],
  ['src/main/services/microsoftAuthService.ts::loadToken', 1],
  ['src/main/services/microsoftGraphFetch.ts::readTokenFromDisk', 1],
  ['src/main/services/salesforceAuthService.ts::loadToken', 1],
  // Note: the former resources/mcp/microsoft-shared/src/tokenProvider.ts entries
  // (loadAccounts, loadToken) were dropped when the obsolete bundled Microsoft
  // connector source trees were deleted — production Microsoft connectors now run
  // from the @mindstone/mcp-server-microsoft-* npm packages (catalog + npx).
]);

export function baselineKey(v: FailOpenViolation): string {
  return `${v.relativePath}::${v.functionName}`;
}

export interface FailOpenViolation {
  relativePath: string;
  functionName: string;
  line: number;
  kind: 'empty-array' | 'null-or-undefined' | 'permissive-scope-literal';
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

/** Best-effort enclosing-function name for a node (for reader-name matching + reporting). */
function enclosingFunctionName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      (ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) &&
      cur.parent &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return cur.parent.name.text;
    }
    if (
      (ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) &&
      cur.parent &&
      ts.isPropertyAssignment(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return cur.parent.name.text;
    }
    cur = cur.parent;
  }
  return null;
}

/** Is there a `FAIL_CLOSED_OK:` reviewer marker anywhere in the catch block? */
function catchHasMarker(catchClause: ts.CatchClause, sourceText: string): boolean {
  const slice = sourceText.slice(catchClause.block.getFullStart(), catchClause.block.getEnd());
  return FAIL_CLOSED_MARKER_RE.test(slice);
}

/**
 * Is this return statement lexically inside an `if` (or ternary) whose condition
 * references `ENOENT`? Such a return is the legitimate "absent file → empty/null"
 * branch (the caller distinguishes absent from corrupt and fails loud on the rest).
 *
 * Robust against the false-clear cases a whole-block scan misses (cross-family
 * review BLOCKER, 260613): `if (rare) throw e; return null;` — the `return null`
 * is NOT inside an ENOENT branch, so it stays flagged; `log('ENOENT'); return null;`
 * — the bare `return null` is not the consequent of an ENOENT condition, so it
 * stays flagged.
 */
function returnIsEnoentGuarded(ret: ts.ReturnStatement, catchBlock: ts.Block): boolean {
  let cur: ts.Node | undefined = ret.parent;
  while (cur && cur !== catchBlock.parent) {
    if (ts.isIfStatement(cur) && /ENOENT/.test(cur.expression.getText())) {
      // The return must be in the THEN branch of an ENOENT-positive condition,
      // or the ELSE branch of an ENOENT-negative one. Cheap, safe approximation:
      // an enclosing if whose condition mentions ENOENT is the discrimination point.
      return true;
    }
    if (ts.isConditionalExpression(cur) && /ENOENT/.test(cur.condition.getText())) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

/** Classify a returned expression as a permissive default, or null if benign. */
function classifyPermissiveReturn(
  expr: ts.Expression | undefined,
): { kind: FailOpenViolation['kind']; detail: string } | null {
  if (!expr) return null;
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) {
    return { kind: 'empty-array', detail: 'return []' };
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: 'null-or-undefined', detail: 'return null' };
  }
  if (ts.isIdentifier(expr) && expr.text === 'undefined') {
    return { kind: 'null-or-undefined', detail: 'return undefined' };
  }
  if (ts.isStringLiteralLike(expr) && PERMISSIVE_SCOPE_LITERALS.has(expr.text.toLowerCase())) {
    return { kind: 'permissive-scope-literal', detail: `return '${expr.text}'` };
  }
  return null;
}

export function scanSourceForFailOpen(
  sourceText: string,
  relativePath: string,
): FailOpenViolation[] {
  const sf = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const violations: FailOpenViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      const fnName = enclosingFunctionName(node);
      if (fnName && READER_NAME_RE.test(fnName) && !catchHasMarker(node, sourceText)) {
        // Flag each permissive return that is NOT gated by an ENOENT branch.
        const inspectReturns = (n: ts.Node): void => {
          if (ts.isReturnStatement(n)) {
            const cls = classifyPermissiveReturn(n.expression);
            if (cls && !returnIsEnoentGuarded(n, node.block)) {
              const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
              violations.push({
                relativePath,
                functionName: fnName,
                line: line + 1,
                kind: cls.kind,
                detail: cls.detail,
              });
            }
          }
          // Don't descend into nested functions (their returns are not this catch's).
          if (
            ts.isFunctionDeclaration(n) ||
            ts.isFunctionExpression(n) ||
            ts.isArrowFunction(n) ||
            ts.isMethodDeclaration(n)
          ) {
            return;
          }
          ts.forEachChild(n, inspectReturns);
        };
        inspectReturns(node.block);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

export function findFailOpenScopeReaders(): FailOpenViolation[] {
  const files = SCAN_ROOTS.flatMap((root) => walk(root));
  const violations: FailOpenViolation[] = [];
  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const rel = toPosix(path.relative(REPO_ROOT, abs));
    violations.push(...scanSourceForFailOpen(text, rel));
  }
  return violations;
}

/**
 * Partition violations against the count-based baseline. A key is over-baseline
 * when its live count exceeds the recorded count — those EXTRA occurrences are
 * `fresh` (a new fail-open return added to an already-baselined reader). Keys not
 * in the baseline are entirely fresh.
 */
export function partitionViolations(violations: FailOpenViolation[]): {
  fresh: FailOpenViolation[];
  baselinedKeys: Set<string>;
  staleKeys: string[];
} {
  const byKey = new Map<string, FailOpenViolation[]>();
  for (const v of violations) {
    const key = baselineKey(v);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(v);
  }
  const fresh: FailOpenViolation[] = [];
  const baselinedKeys = new Set<string>();
  for (const [key, vs] of byKey) {
    const allowed = FAIL_OPEN_READER_BASELINE.get(key) ?? 0;
    if (allowed > 0) baselinedKeys.add(key);
    // Anything beyond the baselined count is fresh (stable order: keep the tail).
    if (vs.length > allowed) fresh.push(...vs.slice(allowed));
  }
  const staleKeys = [...FAIL_OPEN_READER_BASELINE.keys()].filter(
    (k) => (byKey.get(k)?.length ?? 0) < (FAIL_OPEN_READER_BASELINE.get(k) ?? 0),
  );
  return { fresh, baselinedKeys, staleKeys };
}

export function main(): void {
  const violations = findFailOpenScopeReaders();
  const { fresh, baselinedKeys, staleKeys } = partitionViolations(violations);

  // Stale-baseline hygiene: warn (don't fail) if a baselined reader was fixed/removed
  // or its count dropped, so the baseline can be pruned. Never silently keep dead entries.
  if (staleKeys.length > 0) {
    console.warn('⚠ check-failopen-scope-readers: baseline entries reduced/removed (prune them):');
    for (const k of staleKeys) console.warn(`  - ${k}`);
    console.warn('');
  }

  if (fresh.length === 0) {
    console.log(
      `✓ check-failopen-scope-readers: no NEW fail-open reader ` +
        `(${baselinedKeys.size} pre-existing baselined; ${staleKeys.length} stale).`,
    );
    return;
  }
  console.error('✗ check-failopen-scope-readers: NEW reader(s) that fail OPEN on a swallowed error:');
  for (const v of fresh) {
    console.error(`  - ${v.relativePath}:${v.line}  ${v.functionName}()  →  ${v.detail} (${v.kind})`);
  }
  console.error('');
  console.error('A scope/credential reader that catches an error and returns a permissive');
  console.error('default (empty list, null-as-success, or a privilege literal like "full")');
  console.error('silently EXPANDS the tool surface under uncertainty — exactly the');
  console.error('260531 HubSpot getScopeTier() fail-open. Fix by failing closed:');
  console.error('  • rethrow on unexpected errors, OR');
  console.error('  • discriminate ENOENT (absent → least-privilege/empty) and rethrow the rest, OR');
  console.error('  • if the permissive default is genuinely correct here, annotate the catch');
  console.error('    with `FAIL_CLOSED_OK: <reason>` for reviewer sign-off.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
