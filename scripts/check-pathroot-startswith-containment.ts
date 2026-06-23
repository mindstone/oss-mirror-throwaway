#!/usr/bin/env npx tsx
/**
 * CI Validation: filesystem containment must not be hand-rolled with `startsWith`.
 *
 * Origin: 260531_bug_4_use_shared_lexical_containment. A cloud prompt reader did
 * `if (!resolved.startsWith(coreDirectory)) throw 'traversal'`. A bare prefix
 * check accepts sibling-prefix escapes: `coreDirectory='/data/workspace'`,
 * `resolved='/data/workspace-other/secret.md'` → `startsWith` is TRUE, so the
 * traversal guard passes. The canonical predicates `isWithinRoot` /
 * `assertWithinRoot` (src/core/utils/pathSafety.ts) compare path SEGMENTS
 * (appending `path.sep`) and handle the `=== root` case, closing the bypass.
 *
 * NARROW BY DESIGN. A prior FP-spike (recorded in the 260531_bug_4 postmortem)
 * found a broad `startsWith`-containment lint FP-heavy: dozens of legitimate
 * `startsWith('..')` / device-prefix / non-path prefix classifications. So this
 * gate flags ONLY the path-containment SHAPE:
 *
 *   <receiver>.startsWith(<arg>)
 *
 * where ALL of:
 *   • <receiver> looks like a RESOLVED absolute path — an identifier produced by
 *     `path.resolve(...)`/`path.join(...)` in the same function, or named
 *     `resolved` / `*Path` / `abs*` / `normalised*`; AND
 *   • <arg> looks like a ROOT/BASE directory — an identifier named `root` /
 *     `base` / `*Dir` / `*Directory` / `coreDirectory` / `workspaceRoot` (NOT a
 *     string/template literal — literal-prefix checks like the Windows `\\?\`
 *     device prefixes are out of scope); AND
 *   • the call is the genuinely VULNERABLE bare form — it does NOT already
 *     mitigate the sibling-prefix escape. We treat it as safe (and skip it) ONLY
 *     when the argument appends a separator (`startsWith(root + path.sep)` /
 *     `startsWith(root + '/')`) — the segment boundary that makes the prefix
 *     check correct. A bare `startsWith(root)` paired only with a `=== root`
 *     equality check is NOT exempt: it remains vulnerable to sibling prefixes
 *     (`/root-other` passes startsWith and is not `=== root`) — the exact
 *     260531_bug_4 shape (cross-family review BLOCKER, 260613). The prior FP-spike
 *     flagged correct-but-hand-rolled forms as noise; restricting the exemption to
 *     the separator form is why the gate stays low-FP without blessing the bug.
 *
 * Approved helper implementations (pathSafety.ts) are exempt — they ARE the
 * canonical segment-aware containment. Steer everyone else to them.
 *
 * Escape hatch: a `PATH_CONTAINMENT_OK: <reason>` comment on/above the line.
 *
 * Run: npx tsx scripts/check-pathroot-startswith-containment.ts
 * @see src/core/utils/pathSafety.ts (isWithinRoot / assertWithinRoot)
 * @see docs/postmortems/260531_bug_4_use_shared_lexical_containment_20d3d2c_p3_postmortem.md
 * @see docs/plans/260613_recs-safety-toolscope-guards/PLAN.md
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/** Roots whose filesystem code we scan for hand-rolled containment. */
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'src'),
  path.join(REPO_ROOT, 'cloud-service', 'src'),
  path.join(REPO_ROOT, 'resources', 'mcp'),
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__tests__']);

/**
 * Files exempt because they ARE the canonical containment implementation (or a
 * sanctioned low-level path util whose `startsWith` calls are literal-prefix
 * classification, not root containment). Keep this tight.
 */
export const CONTAINMENT_EXEMPT_FILES: ReadonlySet<string> = new Set<string>([
  'src/core/utils/pathSafety.ts',
]);

/**
 * Pre-existing hand-rolled containment sites, recorded so this gate enforces
 * "no NEW hand-rolled startsWith() containment" without a same-PR rewrite of
 * contended cloud-sync / renderer / shared-core files. Keyed by
 * `relativePath::receiver::arg` (line-agnostic so unrelated edits don't reshuffle).
 *
 * Mixed contents:
 *   • FALSE-POSITIVE-by-construction: `coreResolvedBase` is defined as
 *     `coreResolved + path.sep` at its declaration (cloudWorkspaceSync.ts:789/1597),
 *     so the `startsWith(coreResolvedBase)` calls are already segment-safe; the AST
 *     can't follow that data-flow.
 *   • GENUINE bare checks worth draining later: `systemUtils.ts resolveLibraryPath`
 *     fallback, `cloud-service/.../mcp.ts` token-dir check, renderer App.tsx display
 *     routing. These are tracked for a follow-up that owns those surfaces.
 *
 * To DRAIN: route the call through `isWithinRoot`/`assertWithinRoot` (or append the
 * separator / add a `=== root` guard, or a `PATH_CONTAINMENT_OK:` marker for genuine
 * non-containment), then delete the entry. Never ADD for new code.
 *
 * @see docs/postmortems/260531_bug_4_use_shared_lexical_containment_20d3d2c_p3_postmortem.md
 */
// Map of key → expected count, so a NEW hand-rolled containment added to an
// already-baselined file (same receiver+arg) is not silently absorbed
// (cross-family review BLOCKER, 260613).
export const CONTAINMENT_BASELINE: ReadonlyMap<string, number> = new Map<string, number>([
  ['src/core/utils/systemUtils.ts::relativeAttempt::root', 1],
  // cloudWorkspaceSync's coreResolvedBase is `coreResolved + path.sep` at its
  // declaration, so these calls are by-construction segment-safe; the AST can't
  // follow that data-flow, hence baselined rather than flagged. (The 6th is the
  // pending-cloud-update convergence sweep's guard — same coreResolvedBase idiom;
  // REBEL-696 Stage 5.)
  ['src/main/services/cloud/cloudWorkspaceSync.ts::localPath::coreResolvedBase', 6],
  ['src/renderer/App.tsx::filePath::coreDir', 2],
  ['src/renderer/App.tsx::folderPath::coreDir', 1],
  ['cloud-service/src/routes/mcp.ts::tokenPath::tokenDir', 1],
]);

const RESOLVED_RECEIVER_NAME_RE = /^(resolved|normalised\w*|normalized\w*|abs\w*|\w*path)$/i;
const ROOT_ARG_NAME_RE = /^(root|base|\w*dir|\w*directory|coredirectory|workspaceroot|\w*root|\w*base)$/i;
const PATH_PRODUCER_RE = /^(resolve|join|normalize|normalise)$/;
const CONTAINMENT_OK_RE = /PATH_CONTAINMENT_OK:/;

export interface ContainmentViolation {
  relativePath: string;
  line: number;
  receiver: string;
  arg: string;
}

export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

export function containmentBaselineKey(v: ContainmentViolation): string {
  return `${v.relativePath}::${v.receiver}::${v.arg}`;
}

export function partitionContainment(violations: ContainmentViolation[]): {
  fresh: ContainmentViolation[];
  baselinedKeys: Set<string>;
  staleKeys: string[];
} {
  const byKey = new Map<string, ContainmentViolation[]>();
  for (const v of violations) {
    const key = containmentBaselineKey(v);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(v);
  }
  const fresh: ContainmentViolation[] = [];
  const baselinedKeys = new Set<string>();
  for (const [key, vs] of byKey) {
    const allowed = CONTAINMENT_BASELINE.get(key) ?? 0;
    if (allowed > 0) baselinedKeys.add(key);
    if (vs.length > allowed) fresh.push(...vs.slice(allowed));
  }
  const staleKeys = [...CONTAINMENT_BASELINE.keys()].filter(
    (k) => (byKey.get(k)?.length ?? 0) < (CONTAINMENT_BASELINE.get(k) ?? 0),
  );
  return { fresh, baselinedKeys, staleKeys };
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

/** Collect identifiers that are assigned the result of path.resolve/join/normalize in this file. */
function collectPathProducedIdentifiers(sf: ts.SourceFile): Set<string> {
  const produced = new Set<string>();
  const isPathProducerCall = (expr: ts.Expression): boolean =>
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === 'path' &&
    ts.isIdentifier(expr.expression.name) &&
    PATH_PRODUCER_RE.test(expr.expression.name.text);

  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (isPathProducerCall(n.initializer)) produced.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return produced;
}

export function scanSourceForContainment(
  sourceText: string,
  relativePath: string,
): ContainmentViolation[] {
  const sf = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const pathProduced = collectPathProducedIdentifiers(sf);
  const violations: ContainmentViolation[] = [];

  const receiverLooksResolved = (recv: ts.Expression): string | null => {
    if (ts.isIdentifier(recv)) {
      if (pathProduced.has(recv.text) || RESOLVED_RECEIVER_NAME_RE.test(recv.text)) return recv.text;
      return null;
    }
    return null;
  };

  // Returns the root identifier name, AND whether the arg already appends a
  // separator (`root + path.sep` / `root + '/'`), which makes it segment-safe.
  const argLooksRoot = (arg: ts.Expression): { name: string; sepAppended: boolean } | null => {
    // Literals (string/template) are explicitly OUT of scope (device-prefix etc).
    if (ts.isIdentifier(arg) && ROOT_ARG_NAME_RE.test(arg.text)) {
      return { name: arg.text, sepAppended: false };
    }
    // `root + path.sep` / `root + '/'` shape: the left identifier is the root,
    // and appending the separator is the segment-safe mitigation.
    if (
      ts.isBinaryExpression(arg) &&
      arg.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      ts.isIdentifier(arg.left) &&
      ROOT_ARG_NAME_RE.test(arg.left.text)
    ) {
      const right = arg.right;
      const appendsSep =
        // path.sep
        (ts.isPropertyAccessExpression(right) &&
          ts.isIdentifier(right.expression) &&
          right.expression.text === 'path' &&
          ts.isIdentifier(right.name) &&
          right.name.text === 'sep') ||
        // '/' or '\\'
        (ts.isStringLiteralLike(right) && (right.text === '/' || right.text === '\\'));
      return { name: arg.left.text, sepAppended: appendsSep };
    }
    return null;
  };

  const lineHasMarker = (pos: number): boolean => {
    const { line } = sf.getLineAndCharacterOfPosition(pos);
    const lineStart = sf.getLineStarts()[line];
    const nextLineStart = sf.getLineStarts()[line + 1] ?? sourceText.length;
    const prevLineStart = line > 0 ? sf.getLineStarts()[line - 1] : lineStart;
    const slice = sourceText.slice(prevLineStart, nextLineStart);
    return CONTAINMENT_OK_RE.test(slice);
  };

  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.name) &&
      n.expression.name.text === 'startsWith' &&
      n.arguments.length === 1
    ) {
      const recv = receiverLooksResolved(n.expression.expression);
      const argInfo = argLooksRoot(n.arguments[0]);
      if (
        recv &&
        argInfo &&
        // ONLY the separator-appended form is genuinely segment-safe. A bare
        // `startsWith(root)` paired with a `=== root` equality guard is STILL
        // vulnerable: `/root-other` passes startsWith and is not `=== root`
        // (cross-family review BLOCKER, 260613). So we do NOT exempt on the
        // equality guard — only on `root + path.sep` / `root + '/'`.
        !argInfo.sepAppended &&
        !lineHasMarker(n.getStart(sf))
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        violations.push({ relativePath, line: line + 1, receiver: recv, arg: argInfo.name });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return violations;
}

export function findHandRolledContainment(): ContainmentViolation[] {
  const files = SCAN_ROOTS.flatMap((root) => walk(root));
  const violations: ContainmentViolation[] = [];
  for (const abs of files) {
    const rel = toPosix(path.relative(REPO_ROOT, abs));
    if (CONTAINMENT_EXEMPT_FILES.has(rel)) continue;
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    violations.push(...scanSourceForContainment(text, rel));
  }
  return violations;
}

export function main(): void {
  const violations = findHandRolledContainment();
  const { fresh, baselinedKeys, staleKeys } = partitionContainment(violations);

  if (staleKeys.length > 0) {
    console.warn('⚠ check-pathroot-startswith-containment: baseline entries reduced/removed (prune them):');
    for (const k of staleKeys) console.warn(`  - ${k}`);
    console.warn('');
  }

  if (fresh.length === 0) {
    console.log(
      `✓ check-pathroot-startswith-containment: no NEW hand-rolled startsWith() containment ` +
        `(${baselinedKeys.size} pre-existing baselined; ${staleKeys.length} stale).`,
    );
    return;
  }
  console.error(
    '✗ check-pathroot-startswith-containment: NEW hand-rolled startsWith() path-containment guard(s):',
  );
  for (const v of fresh) {
    console.error(`  - ${v.relativePath}:${v.line}  ${v.receiver}.startsWith(${v.arg})`);
  }
  console.error('');
  console.error('A bare `resolved.startsWith(root)` accepts sibling-prefix escapes');
  console.error('(/data/workspace-other slips past a /data/workspace root) — the 260531_bug_4');
  console.error('cloud path-traversal. Use the segment-aware helpers instead:');
  console.error('  import { isWithinRoot, assertWithinRoot } from "@core/utils/pathSafety";');
  console.error('  if (!isWithinRoot(resolved, root)) throw ...   // or assertWithinRoot(resolved, root)');
  console.error('If this startsWith is genuinely NOT path containment, annotate with');
  console.error('`PATH_CONTAINMENT_OK: <reason>` on or above the line.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
