#!/usr/bin/env npx tsx
/**
 * CI guard (producer granularity): every route arm in `providerRouting.ts` that
 * mints a DISPATCHABLE codex-proxy decision (a `makeDecision({ provider: 'codex',
 * credentialSource: 'codex-subscription', … })` — i.e. a non-passthrough Anthropic
 * transport for a model the Codex proxy must serve on the wire) MUST gate model
 * eligibility through the shared `isCodexServableModel` predicate. A new or edited
 * codex route arm that reaches a dispatchable codex-proxy decision for an
 * unvalidated model fails CI here.
 *
 * Why (postmortem 260622_memory_bts_codex_arm_dialect_blind_admission, rec #3):
 * REBEL-5N8 (the `provider_route_model_dialect_divergence` family) recurred because
 * the 260608 by-construction kill was scoped to the SUB-AGENT dispatch door only
 * (check-agent-tool-body-model-source.ts), not to the route-decision PRODUCERS. The
 * Stage-3 client-seam backstop (`nonPassthroughAnthropicSlashBodyError` in
 * clientFactory.ts) now catches the *slash* (wire-shape) variant from every door —
 * but a NEW route arm minting a dispatchable codex-proxy decision for a *bare
 * non-OpenAI* model (`gemini-2.5-flash`, classifies `bare-non-claude`, no slash) has
 * no wire-shape symptom, so the seam backstop cannot see it: it would dispatch
 * SILENTLY to the wrong proxy. This guard closes that producer-granularity gap — it
 * is the exact granularity the 260608 recurrence missed. Mirrors
 * scripts/check-direct-anthropic-route-chokepoint.ts (the analogous "every
 * direct-Anthropic arm resolves through resolveDirectAnthropicModel" check) and the
 * AST approach of scripts/check-agent-tool-body-model-source.ts.
 *
 * Mechanism: AST scan over `providerRouting.ts`. Enumerate every dispatchable
 * codex-proxy `makeDecision` call site (object literal with BOTH `provider: 'codex'`
 * and `credentialSource: 'codex-subscription'`) and assert each is DOMINATED by an
 * `isCodexServableModel(...)` gate — i.e. its enclosing route-arm function references
 * the predicate. Both producers are self-contained: the active arm and its guard live
 * in `routeDecision`; the profile arm and its guard live in `profileDecision`. The
 * dispatchable openrouter/anthropic producers do not carry `provider: 'codex'` (no
 * false positive); `coerceToRouteTable` re-mints via object spread (not a fresh
 * `makeDecision({ provider: 'codex', … })` literal, so it is not a producer); native
 * Claude (claude-*) is diverted to Anthropic upstream of the guard. Deleting the
 * `isCodexServableModel` gate from either arm removes the predicate reference from
 * that enclosing function → this guard fails (proven red→green).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';

const REPO_ROOT = process.cwd();
const ROUTE_PRODUCER = path.join('src', 'core', 'rebelCore', 'providerRouting.ts');

/** The shared servable-dialect predicate every dispatchable codex arm must gate on. */
const SERVABLE_PREDICATE = 'isCodexServableModel';

/**
 * The two codex route-decision producers (active-provider arm in `routeDecision`,
 * subscription-profile arm in `profileDecision`) each mint a dispatchable codex-proxy
 * decision and MUST each be gated. A drop below this is either a removed producer or a
 * removed gate — both warrant a look (update this count + the postmortem family if you
 * intentionally add/remove a dispatchable codex arm).
 */
const MIN_DISPATCHABLE_CODEX_PRODUCERS = 2;

export type CodexServableChokepointViolation = {
  readonly kind: 'missing_target_file' | 'no_producers_found' | 'ungated_producer';
  readonly message: string;
};

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function fail(message: string): never {
  console.error(`\n✗ check-codex-servable-route-chokepoint: ${message}\n`);
  process.exit(1);
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function findPropertyAssignment(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.PropertyAssignment | null {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameText(property.name) === propertyName) return property;
  }
  return null;
}

/** A string-literal property whose value equals `expected` (string or no-substitution template). */
function isStringLiteralProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
  expected: string,
): boolean {
  const property = findPropertyAssignment(objectLiteral, propertyName);
  if (!property) return false;
  const init = property.initializer;
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text === expected;
  return false;
}

/**
 * Is this call a dispatchable codex-proxy producer — `makeDecision({ provider:
 * 'codex', credentialSource: 'codex-subscription', … })`? The codex `makeDecision`
 * sites that emit a terminal (`codexUnsupportedModelDecision`, `noCredentialsDecision`)
 * are separate functions, never `makeDecision` itself, and never carry
 * `credentialSource: 'codex-subscription'` — so this matches ONLY the dispatchable
 * codex-proxy mint.
 */
function isDispatchableCodexProducer(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'makeDecision') return false;
  const config = node.arguments[0];
  if (!config || !ts.isObjectLiteralExpression(config)) return false;
  return (
    isStringLiteralProperty(config, 'provider', 'codex') &&
    isStringLiteralProperty(config, 'credentialSource', 'codex-subscription')
  );
}

/** The nearest enclosing function-like declaration (the route-arm body that must hold the gate). */
function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/** True iff `isCodexServableModel(...)` is CALLED anywhere within `scope`. */
function callsServablePredicate(scope: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === SERVABLE_PREDICATE
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return found;
}

function describeLocation(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const fn = enclosingFunction(node);
  const fnName =
    fn && ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text : '<anonymous route arm>';
  return `${fnName} (line ${line + 1})`;
}

export function checkCodexServableRouteChokepoint(source: string): CodexServableChokepointViolation[] {
  const violations: CodexServableChokepointViolation[] = [];
  const displayPath = toPosix(ROUTE_PRODUCER);

  const sourceFile = ts.createSourceFile(
    'providerRouting.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const producers: ts.CallExpression[] = [];
  function collect(node: ts.Node): void {
    if (isDispatchableCodexProducer(node)) producers.push(node);
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  if (producers.length === 0) {
    violations.push({
      kind: 'no_producers_found',
      message:
        `${displayPath} has no AST-recognizable dispatchable codex-proxy producer ` +
        `(makeDecision({ provider: 'codex', credentialSource: 'codex-subscription', … })) — ` +
        `update this guard if the codex route arm shape moved.`,
    });
    return violations;
  }

  if (producers.length < MIN_DISPATCHABLE_CODEX_PRODUCERS) {
    violations.push({
      kind: 'no_producers_found',
      message:
        `${displayPath} has ${producers.length} dispatchable codex-proxy producer(s), ` +
        `expected >= ${MIN_DISPATCHABLE_CODEX_PRODUCERS} (active-provider arm in routeDecision + ` +
        `subscription-profile arm in profileDecision). A producer appears to have been removed — ` +
        `update MIN_DISPATCHABLE_CODEX_PRODUCERS + the postmortem family if intentional.`,
    });
  }

  for (const producer of producers) {
    const fn = enclosingFunction(producer);
    if (!fn) {
      violations.push({
        kind: 'ungated_producer',
        message:
          `${displayPath}: dispatchable codex-proxy producer at ${describeLocation(sourceFile, producer)} ` +
          `is not inside a recognizable route-arm function — update this guard if the arm shape moved.`,
      });
      continue;
    }
    if (!callsServablePredicate(fn)) {
      violations.push({
        kind: 'ungated_producer',
        message:
          `${displayPath}: dispatchable codex-proxy producer at ${describeLocation(sourceFile, producer)} ` +
          `is not gated by ${SERVABLE_PREDICATE}(...). Every route arm that mints a dispatchable ` +
          `codex-proxy decision must gate model eligibility through the shared ${SERVABLE_PREDICATE} ` +
          `predicate (codex serves only bare OpenAI-compatible ids); a slash or bare-non-OpenAI model ` +
          `would otherwise dispatch onto a non-passthrough Anthropic client and throw at the wire ` +
          `(slash) or dispatch SILENTLY to the wrong proxy (bare non-OpenAI). ` +
          `See docs-private/postmortems/260622_memory_bts_codex_arm_dialect_blind_admission_postmortem.md (rec #3).`,
      });
    }
  }

  return violations;
}

export function main(): void {
  const abs = path.join(REPO_ROOT, ROUTE_PRODUCER);
  if (!fs.existsSync(abs)) {
    fail(`route producer not found at ${toPosix(ROUTE_PRODUCER)} — update this guard if the file moved.`);
  }

  const source = fs.readFileSync(abs, 'utf8');
  const violations = checkCodexServableRouteChokepoint(source);

  if (violations.length > 0) {
    fail(
      `${violations.length} codex-servable route-chokepoint violation(s):\n` +
      violations.map((violation) => `- ${violation.message}`).join('\n') +
      `\n\nEvery dispatchable codex-proxy route arm in providerRouting.ts must gate model ` +
      `eligibility through ${SERVABLE_PREDICATE} — the producer granularity the 260608 ` +
      `sub-agent-door kill missed, which let REBEL-5N8 recur.`,
    );
  }

  console.log(
    `✓ check-codex-servable-route-chokepoint: all dispatchable codex-proxy route arms gate on ${SERVABLE_PREDICATE}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
