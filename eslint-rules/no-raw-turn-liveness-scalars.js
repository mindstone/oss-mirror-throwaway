'use strict';

const TARGET_KEYS = new Set(['isBusy', 'activeTurnId']);
const SAFE_SCALAR_SOURCES = new Set([
  'toPersistedBusyScalars',
  'deriveSummaryLivenessFromProjection',
  'stampDerivedLiveness',
]);

const SESSION_OBJECT_ANCHORS = new Set([
  'id',
  'title',
  'updatedAt',
  'resolvedAt',
]);

const SUMMARY_OBJECT_ANCHORS = new Set([
  'id',
  'title',
  'updatedAt',
  'preview',
  'messageCount',
  'usage',
]);

const ALLOWLIST_PATH_SEGMENTS = [
  '/__tests__/',
  '/src/shared/ipc/schemas/',
  '/src/shared/types/',
  '/packages/shared/src/types/',
  '/src/renderer/features/plugins/api/',
];

function normalizeFilename(filename) {
  return String(filename ?? '').replaceAll('\\', '/');
}

function isAllowlistedFile(filename) {
  const normalized = normalizeFilename(filename);
  return ALLOWLIST_PATH_SEGMENTS.some((segment) => normalized.includes(segment));
}

function getStaticPropertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function getObjectPropertyNames(objectExpression) {
  const names = new Set();
  for (const property of objectExpression.properties) {
    if (property.type !== 'Property') continue;
    const key = getStaticPropertyName(property.key);
    if (key) names.add(key);
  }
  return names;
}

function hasSessionLikeShape(propertyNames) {
  const hasSessionAnchor = [...SESSION_OBJECT_ANCHORS].some((anchor) => propertyNames.has(anchor));
  const hasSummaryAnchor = [...SUMMARY_OBJECT_ANCHORS].some((anchor) => propertyNames.has(anchor));
  return hasSessionAnchor || hasSummaryAnchor;
}

function isTargetProperty(property) {
  if (property.type !== 'Property') return false;
  return TARGET_KEYS.has(getStaticPropertyName(property.key));
}

function memberExpressionMatchesTarget(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  if (node.computed) {
    return node.property.type === 'Literal'
      && typeof node.property.value === 'string'
      && TARGET_KEYS.has(node.property.value);
  }
  return node.property.type === 'Identifier' && TARGET_KEYS.has(node.property.name);
}

function isIdentifier(node) {
  return node?.type === 'Identifier';
}

function isLiteral(node, value) {
  return node?.type === 'Literal' && node.value === value;
}

function getCalleeName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  return null;
}

function isSafeScalarRead(node, safeScalarBindings) {
  if (!node || node.type !== 'MemberExpression' || node.computed) return false;
  if (!isIdentifier(node.object) || !isIdentifier(node.property)) return false;
  return safeScalarBindings.has(node.object.name) && TARGET_KEYS.has(node.property.name);
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (
      current.type === 'TSAsExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression'
    )
  ) {
    current = current.expression;
  }
  return current;
}

function getForwardedMemberRead(node) {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) return null;
  if (unwrapped.type === 'LogicalExpression' && unwrapped.operator === '??') {
    return getForwardedMemberRead(unwrapped.left);
  }
  if (
    unwrapped.type === 'MemberExpression' &&
    !unwrapped.computed &&
    isIdentifier(unwrapped.object) &&
    isIdentifier(unwrapped.property)
  ) {
    return {
      objectName: unwrapped.object.name,
      propertyName: unwrapped.property.name,
    };
  }
  return null;
}

function isSessionShellShape(propertyNames) {
  return (
    propertyNames.has('id') &&
    propertyNames.has('title') &&
    propertyNames.has('createdAt') &&
    propertyNames.has('updatedAt') &&
    propertyNames.has('messages') &&
    propertyNames.has('eventsByTurn')
  );
}

function isAllowlistedObjectProperty(args) {
  const {
    filename,
    key,
    valueNode,
    propertyNames,
  } = args;

  const normalized = normalizeFilename(filename);
  const forwarded = getForwardedMemberRead(valueNode);

  if (isSessionShellShape(propertyNames)) {
    if (key === 'activeTurnId' && isLiteral(unwrapExpression(valueNode), null)) return true;
    if (key === 'isBusy' && isLiteral(unwrapExpression(valueNode), false)) return true;
  }

  if (normalized.includes('/src/core/services/cloudSessionMergeService.ts')) {
    return forwarded?.objectName === 'summary' && forwarded.propertyName === key;
  }

  if (normalized.includes('/cloud-client/src/stores/sessionStore.ts')) {
    return forwarded?.objectName === 'raw' && forwarded.propertyName === key;
  }

  if (normalized.includes('/src/main/services/automationScheduler.ts')) {
    if (forwarded?.objectName === 'conversation' && forwarded.propertyName === key) return true;
    const hasRunSessionSpread = args.objectNode.properties.some(
      (property) => property.type === 'SpreadElement'
        && property.argument.type === 'MemberExpression'
        && !property.argument.computed
        && isIdentifier(property.argument.object)
        && isIdentifier(property.argument.property)
        && property.argument.object.name === 'run'
        && property.argument.property.name === 'session',
    );
    if (hasRunSessionSpread) {
      if (key === 'activeTurnId' && isLiteral(unwrapExpression(valueNode), null)) return true;
      if (key === 'isBusy' && isLiteral(unwrapExpression(valueNode), false)) return true;
    }
  }

  if (normalized.includes('/src/main/services/inboundTriggers/inboundTriggerService.ts')) {
    if (forwarded?.objectName === 'convState' && forwarded.propertyName === key) return true;
    if (isSessionShellShape(propertyNames)) {
      if (key === 'activeTurnId' && unwrapExpression(valueNode)?.type === 'Identifier') return true;
      if (key === 'isBusy' && isLiteral(unwrapExpression(valueNode), true)) return true;
    }
  }

  if (normalized.includes('/src/renderer/features/agent-session/store/sessionStore.ts')) {
    const allowedSources = new Set(['state', 'mergedLiveness', 'summary']);
    return Boolean(forwarded && allowedSources.has(forwarded.objectName) && forwarded.propertyName === key);
  }

  return false;
}

function isAllowlistedAssignment(node, filename) {
  if (!node.left || node.left.type !== 'MemberExpression' || node.left.computed) return false;
  if (!isIdentifier(node.left.object) || !isIdentifier(node.left.property)) return false;
  const objectName = node.left.object.name;
  const key = node.left.property.name;
  const right = unwrapExpression(node.right);
  const normalized = normalizeFilename(filename);

  if (normalized.includes('/src/renderer/features/agent-session/store/sessionStore.ts')) {
    return objectName === 'summaryUpdate' && TARGET_KEYS.has(key);
  }

  if (normalized.includes('/src/main/services/inboundTriggers/inboundTriggerService.ts')) {
    if (objectName !== 'convState') return false;
    if (key === 'activeTurnId') return isLiteral(right, null);
    if (key === 'isBusy') return isLiteral(right, false);
  }

  if (normalized.includes('/src/main/services/automationScheduler.ts')) {
    if (objectName !== 'session') return false;
    if (key === 'activeTurnId') return isLiteral(right, null);
    if (key === 'isBusy') return isLiteral(right, false);
  }

  return false;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid raw persisted/session-cache writes to `isBusy`/`activeTurnId` outside projection-owned stamp paths.',
    },
    schema: [],
    messages: {
      noRawScalarWrite:
        'Raw `{{key}}` writes are forbidden for persisted/session-cache objects. Route through deriveTurnLiveness() + toPersistedBusyScalars() (or an allowlisted summary/stamp boundary).',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? '';
    if (isAllowlistedFile(filename)) {
      return {};
    }

    const safeScalarBindings = new Set();

    return {
      VariableDeclarator(node) {
        if (!isIdentifier(node.id) || !node.init || node.init.type !== 'CallExpression') return;
        const calleeName = getCalleeName(node.init.callee);
        if (!calleeName || !SAFE_SCALAR_SOURCES.has(calleeName)) return;
        safeScalarBindings.add(node.id.name);
      },

      ObjectExpression(node) {
        const propertyNames = getObjectPropertyNames(node);
        const hasTarget = [...propertyNames].some((name) => TARGET_KEYS.has(name));
        if (!hasTarget || !hasSessionLikeShape(propertyNames)) return;

        for (const property of node.properties) {
          if (!isTargetProperty(property)) continue;
          const key = getStaticPropertyName(property.key);
          if (!key) continue;
          if (isSafeScalarRead(property.value, safeScalarBindings)) continue;
          if (isAllowlistedObjectProperty({
            filename,
            key,
            valueNode: property.value,
            propertyNames,
            objectNode: node,
          })) continue;
          context.report({
            node: property,
            messageId: 'noRawScalarWrite',
            data: { key },
          });
        }
      },

      AssignmentExpression(node) {
        if (!memberExpressionMatchesTarget(node.left)) return;
        if (isSafeScalarRead(node.right, safeScalarBindings)) return;
        if (isAllowlistedAssignment(node, filename)) return;
        const key = node.left.computed
          ? String(node.left.property.value)
          : node.left.property.name;
        context.report({
          node,
          messageId: 'noRawScalarWrite',
          data: { key },
        });
      },
    };
  },
};

module.exports = rule;
module.exports.ALLOWLIST_PATH_SEGMENTS = ALLOWLIST_PATH_SEGMENTS;
