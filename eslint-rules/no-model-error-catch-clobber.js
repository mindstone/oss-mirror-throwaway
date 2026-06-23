'use strict';

const PRESERVATION_HELPERS = new Set([
  'reclassifyOrRethrow',
  'getErrorKind',
  'isRoutedError',
]);

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return null;
}

function calleeName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') return propertyName(node.property);
  if (node.type === 'ChainExpression') return calleeName(node.expression);
  return null;
}

function isModelErrorConstructor(node) {
  return Boolean(
    node
    && node.type === 'NewExpression'
    && calleeName(node.callee) === 'ModelError'
    && node.arguments[0]?.type === 'Literal'
    && typeof node.arguments[0].value === 'string',
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
      || current.type === 'TSInstantiationExpression'
    )
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionNode(node) {
  return Boolean(
    node
    && (
      node.type === 'FunctionDeclaration'
      || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression'
    )
  );
}

function traverse(node, visitor, options = {}) {
  if (!node || typeof node.type !== 'string') return;
  visitor(node);

  if (isFunctionNode(node)) return;
  if (options.rootCatch && node.type === 'CatchClause' && node !== options.rootCatch) return;

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

function expressionContainsIdentifier(node, names) {
  let found = false;
  traverse(unwrapExpression(node), (child) => {
    if (found) return;
    if (child.type === 'Identifier' && names.has(child.name)) {
      found = true;
    }
  });
  return found;
}

function containsCatchAgentKindAccess(node, catchName) {
  let found = false;
  traverse(unwrapExpression(node), (child) => {
    if (found) return;
    if (
      child.type === 'MemberExpression'
      && propertyName(child.property) === '__agentErrorKind'
      && unwrapExpression(child.object)?.type === 'Identifier'
      && unwrapExpression(child.object).name === catchName
    ) {
      found = true;
    }
  });
  return found;
}

function isPreservationCall(node, catchName) {
  if (!node || node.type !== 'CallExpression') return false;
  const name = calleeName(node.callee);
  if (!PRESERVATION_HELPERS.has(name)) return false;

  const firstArg = node.arguments[0];
  if (!firstArg) return false;
  return expressionContainsIdentifier(firstArg, new Set([catchName]));
}

function statementContainsPreservation(statement, catchName, catchNode) {
  let found = false;
  traverse(statement, (node) => {
    if (found) return;
    if (isPreservationCall(node, catchName)) {
      found = true;
      return;
    }
    if (
      (node.type === 'IfStatement' || node.type === 'ConditionalExpression')
      && containsCatchAgentKindAccess(node.test, catchName)
    ) {
      found = true;
    }
  }, { rootCatch: catchNode });
  return found;
}

function declaredNamesFromPattern(pattern) {
  if (pattern?.type === 'Identifier') return [pattern.name];

  const names = [];
  traverse(pattern, (node) => {
    if (node.type === 'Identifier' && node.parent?.type !== 'TSTypeReference') {
      names.push(node.name);
    }
  });
  return names;
}

function firstAssignedName(left) {
  const unwrapped = unwrapExpression(left);
  return unwrapped?.type === 'Identifier' ? unwrapped.name : null;
}

function modelErrorUsesDerivedValue(node, derivedNames) {
  if (!isModelErrorConstructor(node)) return false;
  return node.arguments.slice(1).some((argument) => expressionContainsIdentifier(argument, derivedNames));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent catch blocks from clobbering existing ModelError classifications.',
    },
    schema: [],
    messages: {
      noModelErrorCatchClobber:
        'Do not re-wrap a caught error as a fixed-kind ModelError without preserving its existing classification. Use reclassifyOrRethrow(caught, fallbackKind, ...) instead.',
    },
  },
  create(context) {
    function report(node) {
      context.report({ node, messageId: 'noModelErrorCatchClobber' });
    }

    function analyzeCatch(catchNode) {
      const catchName = catchNode.param?.type === 'Identifier' ? catchNode.param.name : null;
      if (!catchName) return;

      const derivedNames = new Set([catchName]);
      const thrownModelErrorByName = new Map();
      let preservedClassification = false;

      function reportThrowClobbers(statement) {
        traverse(statement, (node) => {
          if (node.type !== 'ThrowStatement') return;

          const thrown = unwrapExpression(node.argument);
          if (!thrown) return;

          if (modelErrorUsesDerivedValue(thrown, derivedNames)) {
            if (!preservedClassification) {
              report(thrown);
            }
            return;
          }

          if (thrown.type === 'Identifier') {
            const modelErrorNode = thrownModelErrorByName.get(thrown.name);
            if (modelErrorNode && !preservedClassification) {
              report(modelErrorNode);
            }
          }
        }, { rootCatch: catchNode });
      }

      for (const statement of catchNode.body.body) {
        if (statementContainsPreservation(statement, catchName, catchNode)) {
          preservedClassification = true;
        }

        if (statement.type === 'VariableDeclaration') {
          for (const declaration of statement.declarations) {
            const init = unwrapExpression(declaration.init);
            const declaredNames = declaredNamesFromPattern(declaration.id);

            if (expressionContainsIdentifier(init, derivedNames)) {
              for (const name of declaredNames) {
                derivedNames.add(name);
              }
            }

            if (
              declaredNames.length > 0
              && modelErrorUsesDerivedValue(init, derivedNames)
            ) {
              for (const name of declaredNames) {
                thrownModelErrorByName.set(name, init);
              }
            }
          }
          reportThrowClobbers(statement);
          continue;
        }

        if (statement.type === 'ExpressionStatement') {
          const expression = unwrapExpression(statement.expression);
          if (expression?.type === 'AssignmentExpression') {
            const assignedName = firstAssignedName(expression.left);
            const right = unwrapExpression(expression.right);
            if (assignedName && expressionContainsIdentifier(right, derivedNames)) {
              derivedNames.add(assignedName);
            }
            if (assignedName && modelErrorUsesDerivedValue(right, derivedNames)) {
              thrownModelErrorByName.set(assignedName, right);
            }
          }
          reportThrowClobbers(statement);
          continue;
        }

        reportThrowClobbers(statement);
      }
    }

    return {
      CatchClause: analyzeCatch,
    };
  },
};
