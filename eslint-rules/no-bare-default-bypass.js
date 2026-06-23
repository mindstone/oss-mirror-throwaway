'use strict';

// Stage 3 intentionally ships a cheap, non-type-aware backstop for bare
// default-branch bypasses. Stage 6's type-aware switch-exhaustiveness-check
// is the primary guard; this rule may later be retired or kept as redundant
// defence-in-depth depending on Stage 6 outcomes.

function unwrapExpression(node) {
  let current = node;
  while (
    current
    && (
      current.type === 'ChainExpression'
      || current.type === 'TSAsExpression'
      || current.type === 'TSTypeAssertion'
      || current.type === 'TSNonNullExpression'
      || current.type === 'ParenthesizedExpression'
    )
  ) {
    current = current.expression;
  }
  return current;
}

function isIdentifierCallee(node, name) {
  return node?.type === 'Identifier' && node.name === name;
}

function isInvariantFalseCall(node) {
  if (node?.type !== 'CallExpression') return false;
  if (!isIdentifierCallee(node.callee, 'invariant')) return false;
  const firstArg = unwrapExpression(node.arguments[0]);
  return firstArg?.type === 'Literal' && firstArg.value === false;
}

function isAssertNeverCall(node) {
  return node?.type === 'CallExpression' && isIdentifierCallee(node.callee, 'assertNever');
}

function isSanctionedExitCall(node) {
  return isAssertNeverCall(node) || isInvariantFalseCall(node);
}

function traverse(node, visitor) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node);

  if (
    node.type === 'FunctionDeclaration'
    || node.type === 'FunctionExpression'
    || node.type === 'ArrowFunctionExpression'
  ) {
    return;
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
          traverse(child, visitor);
        }
      }
      continue;
    }

    if (value && typeof value.type === 'string') {
      traverse(value, visitor);
    }
  }
}

function hasSanctionedExit(consequent) {
  let found = false;
  for (const statement of consequent) {
    traverse(statement, (node) => {
      if (!found && isSanctionedExitCall(node)) {
        found = true;
      }
    });
    if (found) return true;
  }
  return false;
}

function isReturnUndefined(node) {
  if (node?.type !== 'ReturnStatement' || !node.argument) return false;
  const argument = unwrapExpression(node.argument);
  if (!argument) return false;
  if (argument.type === 'Identifier' && argument.name === 'undefined') return true;
  return argument.type === 'Literal' && argument.value === undefined;
}

function isBareBypassStatement(statement) {
  if (statement.type === 'BreakStatement') return 'break';
  if (statement.type === 'ReturnStatement' && statement.argument === null) return 'return';
  if (isReturnUndefined(statement)) return 'return undefined';
  return null;
}

function getBypassKind(consequent) {
  if (consequent.length === 0) return 'empty default';
  if (consequent.length !== 1) return null;

  const [statement] = consequent;
  const bareKind = isBareBypassStatement(statement);
  if (bareKind) return bareKind;
  if (statement.type === 'BlockStatement') {
    if (statement.body.length === 0) return 'empty block';
    // Block-wrapped bypass: catch the trivial evasion `default: { break; }` /
    // `default: { return undefined; }` (single bypass statement wrapped in a
    // block) per reviewer-gpt5.3-codex HIGH + behavioral-safety MEDIUM
    // convergent finding. We deliberately don't walk multi-statement blocks
    // because real defaults often have observable side effects (logging,
    // user-visible toasts) before bailing — that is the "explicit observable
    // failure" pattern AGENTS.md endorses, not the silent bypass we want
    // to flag. hasSanctionedExit() runs first so block forms with
    // assertNever / invariant(false, ...) anywhere in the block still pass.
    if (statement.body.length === 1) {
      const innerKind = isBareBypassStatement(statement.body[0]);
      if (innerKind) return `block-wrapped ${innerKind}`;
    }
  }
  return null;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Warn on bare default-branch bypasses in switch statements without sanctioned exhaustiveness exits.',
    },
    schema: [],
    messages: {
      bareDefaultBypass:
        "Default branch uses {{kind}} without exhaustiveness intent. Use assertNever(value) or invariant(false, '...') in the default arm.",
    },
  },
  create(context) {
    return {
      'SwitchCase[test=null]'(node) {
        const consequent = node.consequent ?? [];
        if (hasSanctionedExit(consequent)) {
          return;
        }

        const bypassKind = getBypassKind(consequent);
        if (!bypassKind) {
          return;
        }

        context.report({
          node: consequent[0] ?? node,
          messageId: 'bareDefaultBypass',
          data: {
            kind: bypassKind,
          },
        });
      },
    };
  },
};

module.exports = rule;
