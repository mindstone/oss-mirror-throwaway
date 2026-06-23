#!/usr/bin/env npx tsx
/**
 * CI Validation: safety-eval / model-client retry loops must NOT retry a
 * non-transient model error.
 *
 * Origin: 260622_safety-degradation-guards (postmortem follow-up). A safety-eval
 * retry loop that re-issues the SAME request on a NON-transient model error
 * (billing / auth / model_unavailable / quota-exhausted) does not recover — it
 * burns more quota against an error that will not heal between attempts, slows
 * the fail-closed decision, and (worst case) amplifies a provider outage. The
 * three live loops already short-circuit non-transient errors by gating their
 * retry on a transience signal (`ModelError.isTransient` / `=== 'rate_limit'`).
 * This guard is pure anti-regression: it fails CI if a NEW retry loop in one of
 * the safety/model-client files retries with NO transience signal anywhere in
 * the loop or its catch.
 *
 * DELIBERATELY NARROW — false-positives kept at zero by an explicit `SCAN_FILES`
 * allow-list. A new model-retry file is NOT scanned until it is consciously
 * added here, and the rule biases toward NOT flagging: if ANY transience signal
 * is present in the loop/catch, the loop is treated as compliant. The allow-list
 * caps the blast radius, so missing an exotic reintroduction is preferred over
 * false-paging CI on the ~9 unrelated (file I/O, polling, backoff) retry loops
 * elsewhere in the tree.
 *
 * What it flags: within a SCAN_FILES file, a `for`/`while` loop whose body calls
 * a model method (callLlm / create / streamCreate / createMessage — the methods
 * the live loops dispatch; plus the `runWithRetry` `run()` callback) AND whose
 * catch retries (continue / fall-through to loop end / await-sleep then
 * continue) WITHOUT any transience signal. A transience signal = ANY of:
 *   - a reference to `.isTransient`
 *   - a reference to `TRANSIENT_KINDS`
 *   - an `instanceof ModelError`-gated `break` / `throw` / `return`
 *   - a `=== 'rate_limit'` comparison
 *
 * Escape hatch (NO eslint-disable — that would trip the escape-hatches ratchet):
 * a `RETRY_TRANSIENCE_OK: <justification>` comment on or near the loop.
 *
 * Run: npx tsx scripts/check-safety-eval-retry-transience.ts
 * @see docs/plans/260622_safety-degradation-guards/PLAN.md
 * @see scripts/check-failopen-scope-readers.ts (sibling guard / template)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Explicit allow-list of files whose retry loops we scan. Keeping this an
 * explicit list (not a directory walk) is the FP-control mechanism: a new
 * model-retry file must be consciously added here, so the gate never trips on
 * an unrelated retry loop (file I/O, polling, generic backoff) elsewhere.
 *
 * These four are the safety-eval retry loop + the two model-client `runWithRetry`
 * loops + the BTS safety-eval service (one-shot temperature retry today, no loop
 * — listed so a future loop added there is covered by construction).
 */
export const SCAN_FILES: readonly string[] = [
  'src/core/safetyPromptLogic.ts',
  'src/core/rebelCore/clients/anthropicClient.ts',
  'src/core/rebelCore/clients/openaiClient.ts',
  'src/core/services/safety/btsSafetyEvalService.ts',
];

/**
 * Model-dispatch method names the live loops call. `run` covers the
 * `runWithRetry(run, …)` callback shape (the model-client loops invoke
 * `await run()`, where `run` closes over `beta.messages.create` / the OpenAI
 * create call).
 */
const MODEL_METHOD_NAMES = new Set(['callLlm', 'create', 'streamCreate', 'createMessage', 'run']);

/** Reviewer escape-hatch marker (must carry a justification after the colon). */
const RETRY_TRANSIENCE_MARKER_RE = /\bRETRY_TRANSIENCE_OK:/;

export interface RetryTransienceViolation {
  relativePath: string;
  functionName: string;
  line: number;
  detail: string;
}

export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/** Best-effort enclosing-function name for a node (for reporting + `run` scoping). */
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

/** The simple called-name of a call expression (`a.b.callLlm(…)` → `callLlm`). */
function calledName(call: ts.CallExpression): string | null {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return null;
}

/**
 * Does this loop's body (NOT descending into nested function definitions, whose
 * calls belong to a different scope) call a model-dispatch method?
 */
function loopBodyCallsModelMethod(loopBody: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n)
    ) {
      return; // nested scope — its calls are not this loop's dispatch
    }
    if (ts.isCallExpression(n)) {
      const name = calledName(n);
      if (name && MODEL_METHOD_NAMES.has(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(loopBody, visit);
  return found;
}

/**
 * Is there a transience signal anywhere in the loop region? We scan the loop's
 * full text (statement region) rather than only the catch block, so a signal in
 * the loop guard, a hoisted helper, or a sibling clause still counts. The bias
 * is intentional: ANY transience signal → compliant.
 *
 * Signals:
 *   - `.isTransient` property reference
 *   - `TRANSIENT_KINDS` reference
 *   - `=== 'rate_limit'` / `=== "rate_limit"` comparison
 *   - `instanceof ModelError` (the loops gate a break/throw/return on it)
 */
function loopHasTransienceSignal(loopText: string): boolean {
  if (/\.isTransient\b/.test(loopText)) return true;
  if (/\bTRANSIENT_KINDS\b/.test(loopText)) return true;
  if (/===\s*['"]rate_limit['"]/.test(loopText)) return true;
  if (/instanceof\s+ModelError\b/.test(loopText)) return true;
  return false;
}

/** Marker on/near the loop — scan the loop text plus a small leading window. */
function loopHasMarker(sourceText: string, loop: ts.IterationStatement): boolean {
  // Leading window: capture a `RETRY_TRANSIENCE_OK:` comment placed on the lines
  // immediately above the loop (a common reviewer-marker placement).
  const start = loop.getFullStart(); // includes leading trivia/comments
  const end = loop.getEnd();
  const slice = sourceText.slice(start, end);
  return RETRY_TRANSIENCE_MARKER_RE.test(slice);
}

export function scanSourceForRetryTransience(
  sourceText: string,
  relativePath: string,
): RetryTransienceViolation[] {
  const sf = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true);
  const violations: RetryTransienceViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isForOfStatement(node)) {
      const body = node.statement;
      if (loopBodyCallsModelMethod(body)) {
        const loopText = sourceText.slice(node.getStart(sf), node.getEnd());
        const compliant = loopHasTransienceSignal(loopText) || loopHasMarker(sourceText, node);
        if (!compliant) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({
            relativePath,
            functionName: enclosingFunctionName(node) ?? '<top-level>',
            line: line + 1,
            detail: 'retry loop dispatches a model method but has no transience signal',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

export function findRetryTransienceViolations(): RetryTransienceViolation[] {
  const violations: RetryTransienceViolation[] = [];
  for (const rel of SCAN_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // A SCAN_FILES entry that no longer exists is a maintenance signal, not a
      // silent pass — fail loud so the allow-list is kept honest.
      throw new Error(
        `check-safety-eval-retry-transience: SCAN_FILES entry not found: ${rel}. ` +
          `If the file moved/was renamed, update SCAN_FILES in the same commit.`,
      );
    }
    violations.push(...scanSourceForRetryTransience(text, toPosix(rel)));
  }
  return violations;
}

export function main(): void {
  const violations = findRetryTransienceViolations();

  if (violations.length === 0) {
    console.log(
      `✓ check-safety-eval-retry-transience: ${SCAN_FILES.length} file(s) scanned; ` +
        `no retry loop dispatches a model method without a transience signal.`,
    );
    return;
  }

  console.error(
    '✗ check-safety-eval-retry-transience: retry loop(s) that re-issue a model call WITHOUT a transience guard:',
  );
  for (const v of violations) {
    console.error(`  - ${v.relativePath}:${v.line}  ${v.functionName}()  →  ${v.detail}`);
  }
  console.error('');
  console.error('A retry loop that re-issues the SAME model request on a NON-transient error');
  console.error('(billing / auth / model_unavailable / quota-exhausted) does not recover — it');
  console.error('burns more quota against an error that will not heal between attempts and slows');
  console.error('the fail-closed safety decision. Gate the retry on a transience signal:');
  console.error("  • `if (err instanceof ModelError && !err.isTransient) break;` (skip remaining retries), OR");
  console.error('  • gate the retry on `modelError.isTransient` / `TRANSIENT_KINDS`, OR');
  console.error("  • short-circuit `=== 'rate_limit'`, OR");
  console.error('  • if retrying regardless is genuinely correct here, annotate the loop with');
  console.error('    `RETRY_TRANSIENCE_OK: <reason>` for reviewer sign-off (no eslint-disable).');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
