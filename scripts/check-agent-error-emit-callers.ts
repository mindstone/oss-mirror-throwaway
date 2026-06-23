#!/usr/bin/env npx tsx
/**
 * Agent error-event literal-construction guard (260529 error-emit-funnel, Stage 3).
 *
 * The single funnel `dispatchAgentErrorEvent` (`src/core/services/agentEventDispatcher.ts`)
 * is the ONLY place that may construct and emit an `AgentEvent` of `type:'error'`.
 * A compile-time type-wall already narrows the generic `dispatchAgentEvent` to
 * `Exclude<AgentEvent, { type: 'error' }>`, so an error event cannot be *emitted*
 * any other way. But the type-wall cannot express the *literal-construction* layer:
 * a future caller can still hand-build a `const event: AgentEvent = { type:'error', … }`
 * (or `… as AgentEvent`) and route it somewhere the type-wall doesn't cover — exactly
 * what the two recovery `.catch` sites did before Stage 1 closed them
 * (`forwardOriginalEvent` was typed against the full union), and what
 * `automationScheduler.ts`'s funnel-fed input literals could become if a future edit
 * rerouted them around the funnel.
 *
 * This check is the durable literal-construction enforcement (now the *primary* such
 * enforcement, since the funnel-arbiter was cut — PLAN.md Amendment 1). It FAILS if a
 * `{ type: 'error', … }` object literal is constructed in an *AgentEvent type context*
 * anywhere outside the allowlist (the funnel module + `/__tests__/` globally).
 *
 * ── Why an AST check, not a ripgrep on `type: 'error'` ─────────────────────────────
 * `{ type: 'error' }` is a hugely overloaded shape in this repo: WS control frames
 * (`cloud-service/src/routes/agent.ts`, `appBridge/.../wsServer.ts`), the local model
 * proxy server, worker IPC envelopes (`atlasWorker`/`embeddingWorker`/…), the auto-update
 * service, a renderer diagnostics segment, and the `MemoryUpdateTerminalEvent` synthesis
 * are ALL non-AgentEvent `{type:'error'}` literals (research Map 2). A text allowlist
 * would be hopelessly noisy or toothless. So we scope by *type*: an AgentEvent error
 * literal is one whose construction is annotated/asserted as `AgentEvent` — the canonical
 * way to hand-build one and the exact shape a bypass would take (`const event: AgentEvent
 * = { type: 'error', … }`, the funnel's own form at agentEventDispatcher.ts:1225). The
 * non-AgentEvent shapes above are typed as their own schemas (or untyped closure args),
 * so they are not matched. This mirrors how `check-meeting-emit-callers.ts` scopes to a
 * specific emit-call shape rather than any function named `emit*`.
 *
 * Allowlist:
 *   - `src/core/services/agentEventDispatcher.ts` — the funnel (legitimately builds it).
 *   - `/__tests__/` globally — ≥15 test files legitimately build `{type:'error'}`
 *     AgentEvent literals as fixtures (PLAN.md Completeness; not force-migrated).
 *
 * Run: npx tsx scripts/check-agent-error-emit-callers.ts
 * @see docs/plans/260529_error-emit-funnel/PLAN.md Stage 3
 * @see scripts/check-meeting-emit-callers.ts (the house precedent this copies)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SCAN_ROOTS = ['src', 'cloud-service/src', 'packages'] as const;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

/**
 * Paths allowed to construct an AgentEvent `{type:'error'}` literal. Snippet match
 * (POSIX-normalised relative path `includes`), identical mechanism to
 * check-meeting-emit-callers.ts.
 */
const ALLOWED_PATH_SNIPPETS = [
  'src/core/services/agentEventDispatcher.ts',
  '/__tests__/',
];

function normalisePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function isAllowedPath(relativePath: string): boolean {
  const normalised = normalisePath(relativePath);
  return ALLOWED_PATH_SNIPPETS.some((allowed) => normalised.includes(allowed));
}

interface Violation {
  relativePath: string;
  line: number;
  text: string;
}

/**
 * Does this object literal have a `type: 'error'` property? (Property name `type`,
 * string-literal initializer `'error'`.) Matches both `type: 'error'` and
 * `type: 'error' as const`.
 */
function isErrorTypeObjectLiteral(node: ts.ObjectLiteralExpression): boolean {
  return node.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false;
    const name =
      ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)
        ? prop.name.text
        : null;
    if (name !== 'type') return false;
    let init: ts.Expression = prop.initializer;
    // Unwrap `'error' as const` / `'error' as Foo`.
    while (ts.isAsExpression(init)) init = init.expression;
    return ts.isStringLiteralLike(init) && init.text === 'error';
  });
}

/**
 * Is `typeNode` (syntactically) the `AgentEvent` type? Accepts a bare `AgentEvent`
 * reference. We deliberately do NOT match `Exclude<AgentEvent, …>` / `Extract<…>` /
 * arrays / unions — a `type:'error'` literal can never satisfy an `Exclude<…,{type:'error'}>`
 * target anyway, and the funnel/bypass shape is always a bare `AgentEvent` annotation.
 */
function isAgentEventTypeRef(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode) return false;
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return typeNode.typeName.text === 'AgentEvent';
  }
  return false;
}

/**
 * Is this object literal constructed in an *AgentEvent type context*? True when:
 *   (a) `const x: AgentEvent = { … }`           — variable annotation
 *   (b) `{ … } as AgentEvent`                   — `as` assertion
 *   (c) `<AgentEvent>{ … }`                     — prefix assertion
 *   (d) `{ … } satisfies AgentEvent`            — satisfies
 * The literal node passed is the *unwrapped* object literal; we inspect its parent
 * chain (through any wrapping `as const` etc.) for an AgentEvent type target.
 */
function isInAgentEventContext(objLiteral: ts.ObjectLiteralExpression): boolean {
  // Walk up through expression wrappers (`as const`, parens) to find the typed context.
  let node: ts.Node = objLiteral;
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isParenthesizedExpression(parent)) {
      node = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
      if (parent.expression !== node) return false;
      if (isAgentEventTypeRef(parent.type)) return true;
      // `as const` (or another non-AgentEvent assertion): keep walking outward,
      // the outer context may still be AgentEvent (e.g. `({…} as const) as AgentEvent`).
      node = parent;
      parent = parent.parent;
      continue;
    }
    if (ts.isTypeAssertionExpression(parent)) {
      if (parent.expression !== node) return false;
      return isAgentEventTypeRef(parent.type);
    }
    if (ts.isVariableDeclaration(parent)) {
      return parent.initializer === node && isAgentEventTypeRef(parent.type);
    }
    if (ts.isPropertyDeclaration(parent)) {
      return parent.initializer === node && isAgentEventTypeRef(parent.type);
    }
    break;
  }
  return false;
}

export function scanSource(relativePath: string, source: string, violations: Violation[]): void {
  const sf = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && isErrorTypeObjectLiteral(node)) {
      if (isInAgentEventContext(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        violations.push({
          relativePath,
          line: line + 1,
          text: node.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// BOUNDED-WALKER: Stays within REPO_ROOT scan roots, skips node_modules/dist/build/
// out/coverage, no symlink follow (lstat-style isDirectory guard).
function walkAndScan(rootDir: string, violations: Violation[]): void {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const stats = statSync(fullPath, { throwIfNoEntry: false });
      if (!stats || !stats.isDirectory()) continue;
      walkAndScan(fullPath, violations);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    if (entry.name.endsWith('.d.ts')) continue;

    const relativePath = normalisePath(path.relative(REPO_ROOT, fullPath));
    if (isAllowedPath(relativePath)) continue;

    const contents = readFileSync(fullPath, 'utf-8');
    // Cheap pre-filter: skip files without the literal substring at all.
    if (!contents.includes("type: 'error'") && !contents.includes('type: "error"')) {
      continue;
    }
    scanSource(relativePath, contents, violations);
  }
}

export function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const root of SCAN_ROOTS) {
    walkAndScan(path.join(REPO_ROOT, root), violations);
  }
  return violations;
}

export function main(): void {
  const violations = findViolations();

  if (violations.length > 0) {
    const formatted = violations
      .map((v) => `  ${v.relativePath}:${v.line}  ${v.text}`)
      .join('\n');
    process.stderr.write(
      'Forbidden AgentEvent `{ type: \'error\' }` literal construction outside the funnel:\n' +
        `${formatted}\n\n` +
        'An AgentEvent error event must be constructed ONLY by the funnel ' +
        '`dispatchAgentErrorEvent` (src/core/services/agentEventDispatcher.ts), which ' +
        'applies the mandatory classification (deriveErrorKind / isTransient / humanize / ' +
        'resolution). Route this error through `dispatchAgentErrorEvent(win, turnId, rawError, opts?)` ' +
        'instead of hand-building the literal. (Test files and the funnel itself are allowlisted.)\n' +
        'See docs/plans/260529_error-emit-funnel/PLAN.md Stage 3.\n',
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    'check-agent-error-emit-callers: no AgentEvent `{type:\'error\'}` literals constructed outside the funnel.\n',
  );
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to check agent error-emit callers: ${message}\n`);
    process.exitCode = 1;
  }
}
