'use strict';

/**
 * no-unused-result — flags a call whose result is discarded when that result is
 * a discriminated "Result"-shaped union (one with a literal `false` arm on an
 * `ok`/`success` discriminant, e.g. `{ ok: true; ... } | { ok: false; error }`).
 *
 * This is the result-object analog of `@typescript-eslint/no-floating-promises`:
 * that rule stops a discarded Promise; this stops a discarded *synchronous*
 * (or already-awaited) result whose failure arm would otherwise be silently
 * dropped — the one silent-failure shape not already covered by no-empty /
 * rebel-silent-swallow / no-floating-promises (see
 * docs/plans/260607_code-health-guard-checks/PLAN.md, Stage 2).
 *
 * Deliberately conservative to avoid false positives:
 *   - Requires a UNION return type with a member carrying a literal `false`
 *     `ok`/`success` property. A plain `{ ok: boolean }`, `{ status: ... }`, or
 *     any non-union object does NOT match.
 *   - Only fires at statement position (the value is genuinely discarded).
 *   - Opt out with `void expr` (its type is `void`, so it never matches) — same
 *     ergonomics as no-floating-promises.
 *
 * Type-aware: requires parser services (only meaningful in a config block with
 * `parserOptions.project`).
 */
const { ESLintUtils } = require('@typescript-eslint/utils');
const ts = require('typescript');

const createRule = ESLintUtils.RuleCreator(
  () => 'https://github.com/mindstone/rebel-app/blob/dev/eslint-rules/no-unused-result.js',
);

const DISCRIMINANTS = ['ok', 'success'];

function isFalseLiteralType(type) {
  return (
    (type.flags & ts.TypeFlags.BooleanLiteral) !== 0
    && type.intrinsicName === 'false'
  );
}

/**
 * A union member is a result failure-arm if it has an `ok`/`success` property
 * whose type is EXACTLY the literal `false` — the discriminant of a real
 * discriminated-union failure arm (`{ ok: false; error }`).
 *
 * Crucially this must NOT match a plain `ok: boolean` property: TypeScript
 * represents `boolean` internally as the union `true | false`, so a naive
 * "any false arm" check would false-positive on every type with a boolean
 * `ok`/`success` field (e.g. the DOM `Response.ok`). Requiring a non-union
 * literal-`false` type excludes `boolean` while still matching `ok: false`.
 */
function memberHasFalseDiscriminant(member, checker) {
  for (const name of DISCRIMINANTS) {
    // getTypeOfPropertyOfType is declaration-independent, so it works for
    // synthesized / mapped / declarationless properties too (vs reading
    // symbol.declarations[0], which can miss those).
    const propType = checker.getTypeOfPropertyOfType(member, name);
    if (!propType) continue;
    // Reject `boolean` (= `true | false`): require the exact literal `false`.
    if (!propType.isUnion() && isFalseLiteralType(propType)) return true;
  }
  return false;
}

function isResultLikeUnion(type, checker) {
  // getAwaitedType resolves Promise<R> → R, PromiseLike/thenables, and nested
  // unions like `Promise<R> | undefined` → `R | undefined`, so an awaited or
  // bare Promise-returning result union is recognised. Falls back to the type
  // itself for synchronous results. (Discriminants other than ok/success, and
  // single-arm non-union result types, are intentionally out of scope for this
  // low-FP first version — see Stage 2 scope notes.)
  const resolved = (typeof checker.getAwaitedType === 'function'
    ? checker.getAwaitedType(type)
    : undefined) ?? type;
  if (!resolved.isUnion()) return false;
  return resolved.types.some((member) => memberHasFalseDiscriminant(member, checker));
}

module.exports = createRule({
  name: 'no-unused-result',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow discarding a discriminated Result-shaped union value; handle the failure arm or opt out with `void`.',
    },
    schema: [],
    messages: {
      unusedResult:
        'Result of this call is discarded but its type has a failure arm ({ ok|success: false }). Handle the result (check the discriminant) or explicitly ignore it with `void`.',
    },
  },
  defaultOptions: [],
  create(context) {
    // This rule is type-aware. When ESLint is pointed at a file that the
    // configured TS program doesn't cover (e.g. `__lint_fixtures__/**` force-linted
    // via `--no-ignore`, which `tsconfig.node.json` doesn't include), `program` is
    // null. Calling the strict `getParserServices(context)` there THROWS at
    // create()-time, which crashes ESLint for that file (empty stdout) and takes
    // down every other rule's analysis of it. Pass `allowWithoutFullTypeInformation`
    // and no-op when there's no program, so the rule degrades gracefully instead of
    // killing the lint run.
    const services = ESLintUtils.getParserServices(context, true);
    if (!services.program) {
      return {};
    }
    const checker = services.program.getTypeChecker();

    return {
      ExpressionStatement(node) {
        const expr = node.expression;
        // Only bare calls at statement position. `await fn()` is an
        // AwaitExpression wrapping the call; `void fn()` is a UnaryExpression
        // whose type is `void` (so it's the opt-out and never matches below).
        let callNode = expr;
        if (expr.type === 'AwaitExpression') callNode = expr.argument;
        if (callNode.type !== 'CallExpression' && callNode.type !== 'OptionalCallExpression') {
          return;
        }
        const tsNode = services.esTreeNodeToTSNodeMap.get(callNode);
        if (!tsNode) return;
        const type = checker.getTypeAtLocation(tsNode);
        if (isResultLikeUnion(type, checker)) {
          context.report({ node: callNode, messageId: 'unusedResult' });
        }
      },
    };
  },
});
