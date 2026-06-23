'use strict';

const NATIVE_MEMBER_METHODS = new Set(['close', 'stop', 'remove']);
const NATIVE_IDENTIFIER_CALLS = new Set(['setAudioModeAsync', 'configureForIdle']);
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect']);
const DEFER_HELPER_NAME = 'deferNativeCleanup';

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return null;
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

function isFunction(node) {
  return Boolean(
    node
    && (
      node.type === 'FunctionDeclaration'
      || node.type === 'FunctionExpression'
      || node.type === 'ArrowFunctionExpression'
    ),
  );
}

function isEffectHookCallee(callee) {
  const unwrapped = unwrapExpression(callee);
  if (!unwrapped) return false;
  if (unwrapped.type === 'Identifier') {
    return EFFECT_HOOKS.has(unwrapped.name);
  }
  if (unwrapped.type === 'MemberExpression') {
    return EFFECT_HOOKS.has(propertyName(unwrapped.property));
  }
  return false;
}

function isDeferHelperCallee(callee) {
  const unwrapped = unwrapExpression(callee);
  if (!unwrapped) return false;
  if (unwrapped.type === 'Identifier') {
    return unwrapped.name === DEFER_HELPER_NAME;
  }
  if (unwrapped.type === 'MemberExpression') {
    return propertyName(unwrapped.property) === DEFER_HELPER_NAME;
  }
  return false;
}

function nearestFunction(node) {
  let cursor = node.parent;
  while (cursor) {
    if (isFunction(cursor)) return cursor;
    cursor = cursor.parent;
  }
  return null;
}

function functionParentSkippingBody(functionNode) {
  let cursor = functionNode.parent;
  while (cursor && cursor.type === 'BlockStatement') {
    cursor = cursor.parent;
  }
  return cursor;
}

function isEffectCallback(functionNode) {
  const parent = functionParentSkippingBody(functionNode);
  return Boolean(
    parent
    && parent.type === 'CallExpression'
    && parent.arguments[0] === functionNode
    && isEffectHookCallee(parent.callee),
  );
}

function isReturnedCleanupFunction(functionNode) {
  return Boolean(effectCallbackForCleanupFunction(functionNode));
}

function effectCallbackForCleanupFunction(functionNode) {
  const parent = functionParentSkippingBody(functionNode);
  if (!parent) return null;

  if (parent.type === 'ReturnStatement' && parent.argument === functionNode) {
    const effectCallback = nearestFunction(parent);
    return isEffectCallback(effectCallback) ? effectCallback : null;
  }

  if (isFunction(parent) && parent.body === functionNode) {
    return isEffectCallback(parent) ? parent : null;
  }

  return null;
}

function isInsideDeferNativeCleanupArgument(node) {
  let cursor = node.parent;
  let child = node;
  while (cursor) {
    if (
      cursor.type === 'CallExpression'
      && isDeferHelperCallee(cursor.callee)
      && cursor.arguments.includes(child)
    ) {
      return true;
    }
    child = cursor;
    cursor = cursor.parent;
  }
  return false;
}

function nativeCleanupCallName(node) {
  const callee = unwrapExpression(node.callee);
  if (!callee) return null;

  if (callee.type === 'Identifier' && NATIVE_IDENTIFIER_CALLS.has(callee.name)) {
    return `${callee.name}()`;
  }

  if (callee.type === 'MemberExpression') {
    const prop = propertyName(callee.property);
    if (prop && NATIVE_MEMBER_METHODS.has(prop)) {
      return `${prop}()`;
    }
  }

  return null;
}

function memberObjectIdentifier(node) {
  const callee = unwrapExpression(node.callee);
  if (!callee || callee.type !== 'MemberExpression') return null;
  const object = unwrapExpression(callee.object);
  return object?.type === 'Identifier' ? object.name : null;
}

function isListenerFactoryCall(node) {
  const init = unwrapExpression(node);
  if (!init || init.type !== 'CallExpression') return false;
  const callee = unwrapExpression(init.callee);
  return Boolean(
    callee
    && callee.type === 'MemberExpression'
    && ['addListener', 'addEventListener'].includes(propertyName(callee.property)),
  );
}

function declaresListenerSubscription(effectCallback, name) {
  if (!effectCallback || effectCallback.body?.type !== 'BlockStatement') return false;
  for (const statement of effectCallback.body.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (
        declaration.id.type === 'Identifier'
        && declaration.id.name === name
        && isListenerFactoryCall(declaration.init)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isEventSubscriptionRemove(node, cleanupFunction) {
  const callName = nativeCleanupCallName(node);
  if (callName !== 'remove()') return false;
  const objectName = memberObjectIdentifier(node);
  if (!objectName) return false;
  return declaresListenerSubscription(effectCallbackForCleanupFunction(cleanupFunction), objectName);
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require native teardown in React cleanup functions to route through deferNativeCleanup.',
    },
    schema: [],
    messages: {
      undeferred:
        '{{callName}} is native teardown inside a React cleanup. Route through `deferNativeCleanup(() => …)` to defer past React\'s synchronous unmount phase (prevents TurboModule native crash — 260313).',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callName = nativeCleanupCallName(node);
        if (!callName) return;
        if (isInsideDeferNativeCleanupArgument(node)) return;

        const enclosingFunction = nearestFunction(node);
        if (!enclosingFunction || !isReturnedCleanupFunction(enclosingFunction)) return;
        if (isEventSubscriptionRemove(node, enclosingFunction)) return;

        context.report({
          node,
          messageId: 'undeferred',
          data: { callName },
        });
      },
    };
  },
};

module.exports = rule;
