'use strict';

const TARGET_METHOD_NAMES = new Set([
  'captureException',
  'captureMessage',
  'captureMainException',
  'captureMainMessage',
  'captureMainMessageWithLogs',
  'reportError',
]);

function unwrapExpression(node) {
  let current = node;
  while (current) {
    if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'ParenthesizedExpression'
    ) {
      current = current.expression;
      continue;
    }
    if (current.type === 'ChainExpression') {
      current = current.expression;
      continue;
    }
    break;
  }
  return current;
}

function isTargetCallee(callee) {
  const unwrapped = unwrapExpression(callee);
  if (!unwrapped) return null;

  if (unwrapped.type === 'Identifier') {
    if (unwrapped.name === 'captureKnownCondition') return null;
    return TARGET_METHOD_NAMES.has(unwrapped.name) ? unwrapped.name : null;
  }

  if (unwrapped.type !== 'MemberExpression') return null;

  if (!unwrapped.computed && unwrapped.property.type === 'Identifier') {
    if (unwrapped.property.name === 'captureKnownCondition') return null;
    return TARGET_METHOD_NAMES.has(unwrapped.property.name) ? unwrapped.property.name : null;
  }

  if (unwrapped.computed && unwrapped.property.type === 'Literal' && typeof unwrapped.property.value === 'string') {
    if (unwrapped.property.value === 'captureKnownCondition') return null;
    return TARGET_METHOD_NAMES.has(unwrapped.property.value) ? unwrapped.property.value : null;
  }

  return null;
}

function isStaticStringExpression(node) {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) return false;

  if (unwrapped.type === 'Literal') {
    return typeof unwrapped.value === 'string';
  }

  if (unwrapped.type === 'TemplateLiteral') {
    return unwrapped.expressions.length === 0;
  }

  if (unwrapped.type === 'BinaryExpression' && unwrapped.operator === '+') {
    return isStaticStringExpression(unwrapped.left) && isStaticStringExpression(unwrapped.right);
  }

  return false;
}

function isDynamicStringExpression(node) {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) return false;

  if (unwrapped.type === 'TemplateLiteral') {
    return unwrapped.expressions.length > 0;
  }

  if (unwrapped.type === 'BinaryExpression' && unwrapped.operator === '+') {
    return !isStaticStringExpression(unwrapped);
  }

  return false;
}

function getStaticProperty(objectExpression, propertyName) {
  for (const property of objectExpression.properties ?? []) {
    if (property.type !== 'Property' || property.computed) continue;
    if (property.key.type === 'Identifier' && property.key.name === propertyName) return property;
    if (property.key.type === 'Literal' && property.key.value === propertyName) return property;
  }
  return null;
}

function hasFingerprintAndConditionTag(contextArg) {
  const contextObject = unwrapExpression(contextArg);
  if (!contextObject || contextObject.type !== 'ObjectExpression') return false;

  const fingerprint = getStaticProperty(contextObject, 'fingerprint');
  if (!fingerprint) return false;

  const tagsProperty = getStaticProperty(contextObject, 'tags');
  if (!tagsProperty) return false;
  const tagsValue = unwrapExpression(tagsProperty.value);
  if (!tagsValue || tagsValue.type !== 'ObjectExpression') return false;

  return getStaticProperty(tagsValue, 'condition') !== null;
}

function hasDynamicMessageTarget(methodName, firstArg) {
  const arg = unwrapExpression(firstArg);
  if (!arg) return false;

  if (methodName === 'captureMessage' || methodName === 'captureMainMessage' || methodName === 'captureMainMessageWithLogs') {
    return isDynamicStringExpression(arg);
  }

  if (arg.type === 'NewExpression') {
    const callee = unwrapExpression(arg.callee);
    if (callee?.type === 'Identifier' && callee.name === 'Error' && arg.arguments?.[0]) {
      return isDynamicStringExpression(arg.arguments[0]);
    }
  }

  return isDynamicStringExpression(arg);
}

function getContextArg(methodName, args) {
  if (methodName === 'captureMainMessageWithLogs') {
    return args[2];
  }
  return args[1];
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid dynamic/interpolated Sentry capture messages that fragment fingerprints.',
    },
    schema: [],
    messages: {
      noDynamicCaptureMessage:
        "Do not use dynamic/interpolated capture messages for Sentry calls. Use a static message plus tags/extra, or captureKnownCondition(). If you must keep a dynamic message, include explicit context fingerprint and tags.condition.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const methodName = isTargetCallee(node.callee);
        if (!methodName) return;

        const [firstArg] = node.arguments;
        if (!firstArg) return;
        if (!hasDynamicMessageTarget(methodName, firstArg)) return;

        const contextArg = getContextArg(methodName, node.arguments);
        if (contextArg && hasFingerprintAndConditionTag(contextArg)) return;

        context.report({
          node: firstArg,
          messageId: 'noDynamicCaptureMessage',
        });
      },
    };
  },
};

module.exports = rule;
