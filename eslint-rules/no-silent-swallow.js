'use strict';

const HELPER_NAME = 'ignoreBestEffortCleanup';
const CANONICAL_HELPER_FILE = 'src/shared/utils/intentionalSwallow.ts';

function normalizeFilename(filename) {
  return String(filename ?? '').replaceAll('\\', '/');
}

function isCanonicalHelperFile(filename) {
  return normalizeFilename(filename).endsWith(CANONICAL_HELPER_FILE);
}

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return null;
}

function isHelperCallee(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === HELPER_NAME;
  if (node.type === 'MemberExpression') {
    return propertyName(node.property) === HELPER_NAME;
  }
  if (node.type === 'ChainExpression') {
    return isHelperCallee(node.expression);
  }
  return false;
}

function findCatchClause(node) {
  let cursor = node.parent;
  while (cursor) {
    if (cursor.type === 'CatchClause') return cursor;
    cursor = cursor.parent;
  }
  return null;
}

function findTryStatementForFinalizer(node) {
  let child = node;
  let cursor = node.parent;
  while (cursor) {
    if (cursor.type === 'TryStatement' && cursor.finalizer === child) {
      return cursor;
    }
    child = cursor;
    cursor = cursor.parent;
  }
  return null;
}

function catchBindingName(catchNode) {
  return catchNode?.param?.type === 'Identifier' ? catchNode.param.name : null;
}

function getObjectProperty(objectExpression, propertyNameToFind) {
  if (!objectExpression || objectExpression.type !== 'ObjectExpression') return null;
  return objectExpression.properties.find((property) => (
    property.type === 'Property'
    && propertyName(property.key) === propertyNameToFind
  )) ?? null;
}

function hasNonEmptyStringLiteralProperty(objectExpression, propertyNameToFind) {
  const property = getObjectProperty(objectExpression, propertyNameToFind);
  const value = property?.value;
  return Boolean(
    value
    && value.type === 'Literal'
    && typeof value.value === 'string'
    && value.value.trim().length > 0,
  );
}

function findPromiseCatchCallback(node) {
  let cursor = node.parent;
  let lastSeen = node;
  while (cursor) {
    if (
      (cursor.type === 'ArrowFunctionExpression' || cursor.type === 'FunctionExpression')
      && cursor.parent?.type === 'CallExpression'
      && cursor.parent.arguments[0] === cursor
      && cursor.parent.callee?.type === 'MemberExpression'
      && propertyName(cursor.parent.callee.property) === 'catch'
    ) {
      return cursor;
    }
    if (
      cursor.type === 'FunctionDeclaration'
      || cursor.type === 'FunctionExpression'
      || cursor.type === 'ArrowFunctionExpression'
    ) {
      // Helper call is nested inside a non-catch function — stop walking up.
      return null;
    }
    lastSeen = cursor;
    cursor = cursor.parent;
  }
  void lastSeen;
  return null;
}

function validateHelperInvocation(node) {
  const catchNode = findCatchClause(node);
  const finalizerTryNode = catchNode ? null : findTryStatementForFinalizer(node);
  const promiseCatchCallback = catchNode || finalizerTryNode ? null : findPromiseCatchCallback(node);

  let binding = null;
  if (catchNode) {
    binding = catchBindingName(catchNode);
  } else if (finalizerTryNode) {
    binding = catchBindingName(finalizerTryNode.handler);
  } else if (promiseCatchCallback) {
    const param = promiseCatchCallback.params[0];
    binding = param?.type === 'Identifier' ? param.name : null;
  }

  if (!catchNode && !finalizerTryNode && !promiseCatchCallback) {
    return false;
  }

  const [errorArg, contextArg] = node.arguments;
  if (!binding || errorArg?.type !== 'Identifier' || errorArg.name !== binding) {
    return false;
  }

  if (contextArg?.type !== 'ObjectExpression') {
    return false;
  }

  return hasNonEmptyStringLiteralProperty(contextArg, 'reason')
    && hasNonEmptyStringLiteralProperty(contextArg, 'operation');
}

function isConsoleCallStatement(statement) {
  const expression = statement.type === 'ExpressionStatement' ? statement.expression : null;
  return Boolean(
    expression
    && expression.type === 'CallExpression'
    && expression.callee?.type === 'MemberExpression'
    && expression.callee.object?.type === 'Identifier'
    && expression.callee.object.name === 'console',
  );
}

function isNoOpExpressionStatement(statement) {
  if (statement.type === 'EmptyStatement') return true;
  if (statement.type !== 'ExpressionStatement') return false;
  const expression = statement.expression;
  return [
    'Identifier',
    'Literal',
    'TemplateLiteral',
    'ThisExpression',
  ].includes(expression.type)
    || (
      expression.type === 'UnaryExpression'
      && expression.operator === 'void'
    );
}

function unwrapExpression(node) {
  let current = node;
  while (
    current
    && (
      current.type === 'ChainExpression'
      || current.type === 'TSAsExpression'
      || current.type === 'TSTypeAssertion'
      || current.type === 'TSNonNullExpression'
    )
  ) {
    current = current.expression;
  }
  return current;
}

function isSentinelReturn(node) {
  const argument = unwrapExpression(node.argument);
  if (!argument) return true;
  if (argument.type === 'Identifier' && argument.name === 'undefined') return true;
  return argument.type === 'Literal'
    && (argument.value === null || argument.value === false);
}

// An empty collection literal — `[]` (ArrayExpression, no elements) or `{}`
// (ObjectExpression, no properties). These are NOT `Literal` nodes, so they are
// invisible to `isSentinelReturn`'s Literal checks. We treat a catch fallback of
// an empty collection as a *silent fail-open swallow* — but only when the catch
// records no observability (see catchHasObservability). The discriminator is the
// ABSENCE OF OBSERVABILITY, not the literal: 91/129 such returns in core+main are
// observable (log/capture/throw) and would be false positives under a literal-only
// rule. Scope is `[]`/`{}` only (scalars `''`/`0` carry domain meaning and have no
// historical fail-open evidence — see docs/plans/260620_defect-defense-hardening/PLAN.md).
function isEmptyCollectionExpression(expr) {
  const unwrapped = unwrapExpression(expr);
  if (!unwrapped) return false;
  if (unwrapped.type === 'ArrayExpression') return unwrapped.elements.length === 0;
  if (unwrapped.type === 'ObjectExpression') return unwrapped.properties.length === 0;
  return false;
}

function isEmptyCollectionReturn(node) {
  return isEmptyCollectionExpression(node.argument);
}

// A structured project-logger call, e.g. `log.warn(...)`, `log.error(...)`,
// `logger.info(...)`. Member call on an identifier literally named `log` or
// `logger`. `console.*` is deliberately EXCLUDED (the rule treats console-only
// catches as swallows via noOpCatch; crediting console here would be incoherent).
function isStructuredLogCall(callExpression) {
  const callee = callExpression.callee;
  return Boolean(
    callee
    && callee.type === 'MemberExpression'
    && callee.object?.type === 'Identifier'
    && (callee.object.name === 'log' || callee.object.name === 'logger'),
  );
}

// An error-reporter capture call: any call whose callee property name matches
// /capture|report/i, e.g. `captureException(e)`, `reportError(e)`,
// `getErrorReporter().captureException(...)`, `Sentry.captureException(...)`.
function isErrorReporterCaptureCall(callExpression) {
  const callee = callExpression.callee;
  if (!callee) return false;
  if (callee.type === 'Identifier') {
    return /capture|report/i.test(callee.name);
  }
  if (callee.type === 'MemberExpression') {
    const name = propertyName(callee.property);
    return Boolean(name && /capture|report/i.test(name));
  }
  return false;
}

// Tests whether an `if` test references an expected-error property — `err.code`,
// `errno`, `err.name`, or the literal string 'ENOENT' anywhere in the condition.
// A catch containing such a narrowing branch is treated as deliberately handling
// an expected error (e.g. "file absent is normal"), so its empty-collection
// returns are exempt. Kept intentionally coarse (whole-catch exemption) per PLAN.
function testReferencesExpectedError(testNode) {
  let found = false;
  traverse(testNode, (node) => {
    if (found) return;
    if (
      node.type === 'MemberExpression'
      && propertyName(node.property)
      && /^(code|errno|name)$/.test(propertyName(node.property))
    ) {
      found = true;
      return;
    }
    if (node.type === 'Identifier' && node.name === 'errno') {
      found = true;
      return;
    }
    if (node.type === 'Literal' && node.value === 'ENOENT') {
      found = true;
    }
  });
  return found;
}

// Does a catch/.catch body record ANY observability that exempts a fallback
// return? Any one of: a valid ignoreBestEffortCleanup helper call, a structured
// `log.*`/`logger.*` call, an error-reporter capture, a `throw` (rethrow), or an
// expected-error-narrowing `if`. `traverseOptions` carries the catch-local
// boundary (stopAtNestedCatch/rootCatch) for block-catch clauses; a `.catch()`
// callback body needs no such boundary (traversal stops at nested functions).
function bodyHasObservability(bodyNode, hasValidHelper, traverseOptions = {}) {
  if (hasValidHelper) return true;
  let observable = false;
  traverse(bodyNode, (node) => {
    if (observable) return;
    if (node.type === 'ThrowStatement') {
      observable = true;
      return;
    }
    if (node.type === 'CallExpression') {
      if (isStructuredLogCall(node) || isErrorReporterCaptureCall(node)) {
        observable = true;
        return;
      }
    }
    if (node.type === 'IfStatement' && testReferencesExpectedError(node.test)) {
      observable = true;
    }
  }, traverseOptions);
  return observable;
}

function catchHasObservability(catchNode, validHelperCalls) {
  return bodyHasObservability(catchNode.body, validHelperCalls.length > 0, {
    stopAtNestedCatch: true,
    rootCatch: catchNode,
  });
}

function traverse(node, visitor, options = {}) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node);

  if (
    node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
  ) {
    return;
  }

  // When analyzing facts for a specific catch block, do not descend into
  // nested CatchClause / TryStatement bodies — helper calls and sentinel
  // returns inside an inner catch belong to that catch, not the enclosing
  // one. Without this boundary an inner ignoreBestEffortCleanup() would
  // appear to absolve the OUTER catch of its observability obligation
  // (false negative flagged by reviewer-gpt5.5-high HIGH on Stage 2).
  if (options.stopAtNestedCatch) {
    if (node.type === 'CatchClause' && node !== options.rootCatch) return;
    if (node.type === 'TryStatement') {
      if (node.handler && node.handler !== options.rootCatch) return;
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'parent'
      || key === 'loc'
      || key === 'range'
      || key === 'tokens'
      || key === 'comments'
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') {
          traverse(child, visitor, options);
        }
      }
      continue;
    }
    if (value && typeof value.type === 'string') {
      traverse(value, visitor, options);
    }
  }
}

function collectCatchFacts(catchNode) {
  const helperCalls = [];
  const sentinelReturns = [];
  const emptyCollectionReturns = [];

  traverse(catchNode.body, (node) => {
    if (node.type === 'CallExpression' && isHelperCallee(node.callee)) {
      helperCalls.push(node);
    }
    if (node.type === 'ReturnStatement') {
      if (isSentinelReturn(node)) {
        sentinelReturns.push(node);
      } else if (isEmptyCollectionReturn(node)) {
        // Empty-collection returns are tracked separately: unlike the
        // null/false/undefined sentinels (which the rule flags absent a helper),
        // these are flagged only when the WHOLE catch records no observability.
        emptyCollectionReturns.push(node);
      }
    }
  }, { stopAtNestedCatch: true, rootCatch: catchNode });

  const validHelperCalls = helperCalls.filter(validateHelperInvocation);
  return {
    helperCalls,
    validHelperCalls,
    sentinelReturns,
    emptyCollectionReturns,
  };
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      // The rule fires on catch / `.catch()` shapes that swallow an error
      // without recording it: empty catches, console-only / no-op catches, and
      // fallback sentinel returns. Sentinel returns cover BOTH the scalar
      // sentinels (`null`/`false`/`undefined`/bare return) AND empty collections
      // (`[]`/`{}`) — and BOTH use the SAME discriminator: a fallback return is
      // flagged ONLY when the catch records no observability, where observability
      // = the sanctioned ignoreBestEffortCleanup helper OR a structured
      // `log.*`/`logger.*` call OR an error-reporter capture OR a `throw`
      // (rethrow) OR an expected-error narrowing branch like
      // `if (err.code === 'ENOENT') ...`. `console.*` does NOT count as
      // observability. The empty-collection coverage targets the bug-#3
      // silent-collapse class. See docs/plans/260620_defect-defense-hardening/PLAN.md
      // (origin) + docs/plans/260620_defect-defense-followups/PLAN.md (scalar
      // harmonization 2026-06-20).
      //
      // History: the scalar-sentinel path was originally HELPER-ONLY (no
      // log/capture/throw/narrowing credit); it was harmonized with the
      // empty-collection path 2026-06-20 after a 53-site sample (100% of the
      // riskiest predicates) found 0 spurious credits among the ~342 src/** sites
      // it un-flagged. Regression-safe: stripping the observability from any of
      // those sites makes it a NEW warning in a changed file → caught by the
      // diff-scoped `eslint-new-warnings` gate.
      //
      // `.catch()` callback coverage: the EMPTY-COLLECTION detection traverses the
      // callback body (nested `return []`/`{}` inside an if/switch/loop are flagged),
      // in lockstep with the `CatchClause` path. The scalar-sentinel detection in a
      // block-bodied `.catch()` remains TOP-LEVEL ONLY (a deliberate limitation —
      // a nested `return null` in a `.catch()` block is not flagged): bringing it
      // into nested-traversal lockstep (the #4-PLAN follow-up) was measured to add
      // +25 mostly-false-positive sites, dominated by control-flow
      // `if (cancelled) return` cancellation guards. See the followups PLAN.md.
      description:
        'Flag catch/.catch fallback swallows that record no observability (empty catch, console/no-op catch, sentinel or empty-collection return without log/capture/throw/narrowing or the intentionalSwallow helper).',
    },
    schema: [],
    messages: {
      emptyCatch:
        'Empty catch blocks silently swallow errors. Handle the error, rethrow it, or call ignoreBestEffortCleanup(error, { operation, reason }) with non-empty string literals.',
      noOpCatch:
        'Catch block only logs or performs a no-op, which silently swallows the error. Handle the error, rethrow it, or call ignoreBestEffortCleanup(error, { operation, reason }).',
      sentinelReturn:
        'Catch returns a fallback (null/false/undefined/[]/{}) without recording the swallow. Make the failure observable — log it (log.warn/error), capture it (captureException/reportError), rethrow, narrow the expected error (e.g. if (err.code === \'ENOENT\')), or call ignoreBestEffortCleanup(error, { operation, reason }) — before returning the fallback. console.* does not count.',
      invalidHelper:
        'ignoreBestEffortCleanup must be inside a catch/finally block, receive the catch binding as its first argument, and include non-empty string-literal context.reason and context.operation values.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? '';
    if (isCanonicalHelperFile(filename)) {
      return {};
    }

    return {
      CallExpression(node) {
        if (!isHelperCallee(node.callee)) return;
        if (!validateHelperInvocation(node)) {
          context.report({ node, messageId: 'invalidHelper' });
        }
      },
      CatchClause(node) {
        const statements = node.body?.body ?? [];
        if (statements.length === 0) {
          context.report({ node: node.body, messageId: 'emptyCatch' });
          return;
        }

        const facts = collectCatchFacts(node);
        const hasValidHelper = facts.validHelperCalls.length > 0;

        // Multi-statement no-op: every statement is either a console call or
        // a no-op expression. A two-line `console.warn(...); console.warn(...);`
        // is just as silent as a one-line version. (Per reviewer-gpt5.5-high
        // HIGH finding on Stage 2.)
        if (
          !hasValidHelper
          && statements.length >= 1
          && statements.every((s) => isConsoleCallStatement(s) || isNoOpExpressionStatement(s))
        ) {
          context.report({ node: statements[0], messageId: 'noOpCatch' });
        }

        // Fallback returns — scalar sentinels (`null`/`false`/`undefined`/bare
        // return) AND empty collections (`[]`/`{}`) — are flagged ONLY when the
        // catch records NO observability (the sanctioned helper / a structured
        // `log.*`·`logger.*` call / an error-reporter capture / a `throw` /
        // expected-error narrowing). The discriminator is absence-of-observability,
        // not the literal returned (DA F1). The scalar and empty-collection paths
        // use the SAME discriminator: harmonized 2026-06-20 (the scalar path was
        // previously helper-only). The harmonization un-flagged 342 src/** sites
        // that were already observable; a 53-site sample weighted to 100% of the
        // riskiest predicates found 0 spurious credits, and the diff-scoped
        // `eslint-new-warnings` gate catches any later edit that strips the
        // observability. `console.*` does NOT count. See
        // docs/plans/260620_defect-defense-followups/PLAN.md.
        const fallbackReturns = [...facts.sentinelReturns, ...facts.emptyCollectionReturns];
        if (fallbackReturns.length > 0 && !catchHasObservability(node, facts.validHelperCalls)) {
          for (const returnNode of fallbackReturns) {
            context.report({ node: returnNode, messageId: 'sentinelReturn' });
          }
        }
      },
      // Detect `.catch(() => {})`, `.catch(() => null)`, `.catch(() => undefined)`,
      // `.catch(() => false)`, and other arrow callbacks whose body is empty,
      // a no-op expression, or a sentinel-shaped expression — none of these
      // record the swallow. (Per reviewer-gpt5.3-codex HIGH + behavioral-safety
      // HIGH findings on Stage 2.)
      'CallExpression[callee.type="MemberExpression"][callee.property.name="catch"]'(node) {
        const callback = node.arguments[0];
        if (!callback) return;
        if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') return;

        const param = callback.params[0];
        const bindingName = param?.type === 'Identifier' ? param.name : null;
        const body = callback.body;

        // Body is an expression (concise arrow): `() => null`, `(e) => undefined`, `() => false`, `() => {}`.
        if (body.type !== 'BlockStatement') {
          const expr = unwrapExpression(body);
          if (
            expr.type === 'Literal'
            && (expr.value === null || expr.value === false)
          ) {
            context.report({ node: callback, messageId: 'sentinelReturn' });
            return;
          }
          if (expr.type === 'Identifier' && expr.name === 'undefined') {
            context.report({ node: callback, messageId: 'sentinelReturn' });
            return;
          }
          // Empty-collection concise fallback: `.catch(() => [])` / `.catch(() => ({}))`.
          // A concise arrow has no room for observability, so this is always a
          // silent swallow (same as `.catch(() => null)`). Report as sentinelReturn
          // (more precise than the noOpCatch catch-all below).
          if (isEmptyCollectionExpression(expr)) {
            context.report({ node: callback, messageId: 'sentinelReturn' });
            return;
          }
          if (
            expr.type === 'CallExpression'
            && isHelperCallee(expr.callee)
            && bindingName
            && expr.arguments[0]?.type === 'Identifier'
            && expr.arguments[0].name === bindingName
            && hasNonEmptyStringLiteralProperty(expr.arguments[1], 'reason')
            && hasNonEmptyStringLiteralProperty(expr.arguments[1], 'operation')
          ) {
            return;
          }
          // Any other concise expression (e.g. `(e) => logger.debug(e)`) is
          // a logged-but-swallowed pattern — flag it.
          context.report({ node: callback, messageId: 'noOpCatch' });
          return;
        }

        // Body is a block: empty, console-only, no-op-only, or sentinel-returning
        // block expressions all qualify as silent swallows unless a sanctioned
        // helper call appears.
        const stmts = body.body;
        if (stmts.length === 0) {
          context.report({ node: callback, messageId: 'emptyCatch' });
          return;
        }

        const hasValidHelper = stmts.some((s) => {
          if (s.type !== 'ExpressionStatement') return false;
          const expr = s.expression;
          if (expr.type !== 'CallExpression' || !isHelperCallee(expr.callee)) return false;
          const errArg = expr.arguments[0];
          if (!bindingName || errArg?.type !== 'Identifier' || errArg.name !== bindingName) return false;
          const ctxArg = expr.arguments[1];
          return hasNonEmptyStringLiteralProperty(ctxArg, 'reason')
            && hasNonEmptyStringLiteralProperty(ctxArg, 'operation');
        });

        if (hasValidHelper) return;

        if (stmts.every((s) => isConsoleCallStatement(s) || isNoOpExpressionStatement(s))) {
          context.report({ node: callback, messageId: 'noOpCatch' });
          return;
        }

        // Fallback return inside a block-bodied `.catch()` — flag only when the
        // body records NO observability (a valid helper already returned above;
        // `console.*` does NOT count). Both detections share one observability
        // gate, harmonized with the `CatchClause` path 2026-06-20. The
        // observability scan carries the nested-catch/function boundary
        // (`stopAtNestedCatch`): an inner `try/catch`'s observability is about a
        // DIFFERENT error and must not absolve the outer `.catch()` swallow
        // (Phase-5 F1); with no `rootCatch`, every nested CatchClause/TryStatement
        // is skipped, matching the `CatchClause` path's boundary discipline.
        //
        //  - SCALAR sentinel (`null`/`false`/`undefined`/bare return): TOP-LEVEL
        //    only (`stmts.some`). Bringing it into nested-traversal lockstep with
        //    the empty-collection path is the deferred #4-PLAN follow-up: measured
        //    +25 `src/**` sites, dominated by control-flow `if (cancelled) return`
        //    cancellation guards (and error-surfacing the rule's predicates don't
        //    recognise — `emitLog`, `setState`, captured `console`), i.e. mostly
        //    false positives — so the scalar `.catch()` scan is kept top-level on
        //    purpose. See docs/plans/260620_defect-defense-followups/PLAN.md.
        //  - EMPTY collection (`[]`/`{}`): TRAVERSED (a NESTED `return []` inside
        //    an if/switch/loop is flagged), in lockstep with `collectCatchFacts`
        //    (Phase-7 F1) — empty-collection returns are fallback values, not the
        //    control-flow early-exits bare scalar returns tend to be.
        const observable = bodyHasObservability(body, false, { stopAtNestedCatch: true });
        const hasTopLevelScalarReturn = stmts.some((s) => (
          s.type === 'ReturnStatement' && isSentinelReturn(s)
        ));
        let hasEmptyCollectionReturn = false;
        traverse(body, (n) => {
          if (n.type === 'ReturnStatement' && isEmptyCollectionReturn(n)) {
            hasEmptyCollectionReturn = true;
          }
        }, { stopAtNestedCatch: true });
        if ((hasTopLevelScalarReturn || hasEmptyCollectionReturn) && !observable) {
          context.report({ node: callback, messageId: 'sentinelReturn' });
        }
      },
    };
  },
};

module.exports = rule;
