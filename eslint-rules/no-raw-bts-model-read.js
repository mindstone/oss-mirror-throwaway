const TARGET_PROPERTIES = new Set([
  'behindTheScenesModel',
  'behindTheScenesOverrides',
]);

function unwrapChainExpression(node) {
  if (node?.type === 'ChainExpression') {
    return node.expression;
  }
  return node;
}

function getMemberPropertyName(node) {
  const expression = unwrapChainExpression(node);
  if (!expression || expression.type !== 'MemberExpression') return null;

  if (!expression.computed && expression.property.type === 'Identifier') {
    return expression.property.name;
  }

  if (expression.computed && expression.property.type === 'Literal' && typeof expression.property.value === 'string') {
    return expression.property.value;
  }

  if (
    expression.computed &&
    expression.property.type === 'TemplateLiteral' &&
    expression.property.expressions.length === 0
  ) {
    return expression.property.quasis[0]?.value?.cooked ?? null;
  }

  return null;
}

function getPropertyKeyName(node) {
  if (!node || node.type !== 'Property') return null;
  if (node.key.type === 'Identifier') return node.key.name;
  if (node.key.type === 'Literal' && typeof node.key.value === 'string') return node.key.value;
  return null;
}

function outerChainNode(node) {
  if (node?.parent?.type === 'ChainExpression') {
    return node.parent;
  }
  return node;
}

function isWriteOnlyMemberReference(node) {
  const root = outerChainNode(node);
  const parent = root?.parent;
  if (!parent) return false;

  if (parent.type === 'AssignmentExpression' && parent.left === root) {
    return parent.operator === '=';
  }

  if (parent.type === 'UnaryExpression' && parent.operator === 'delete' && parent.argument === root) {
    return true;
  }

  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent raw BTS settings-field reads outside the S4.5 allowlist.',
    },
    schema: [],
    messages: {
      noRawRead: "Direct reads of behindTheScenesModel/behindTheScenesOverrides are forbidden outside the S4.5 allowlist. Decode through modelChoiceCodec helpers (stripStoredModelPrefix or resolveBtsModel). For rare exceptions, use // eslint-disable-next-line bts-flow-shape/no-raw-bts-model-read -- <justification>.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const propertyName = getMemberPropertyName(node);
        if (!propertyName || !TARGET_PROPERTIES.has(propertyName)) return;
        if (isWriteOnlyMemberReference(node)) return;
        context.report({ node, messageId: 'noRawRead' });
      },
      Property(node) {
        if (node.parent?.type !== 'ObjectPattern') return;
        const keyName = getPropertyKeyName(node);
        if (!keyName || !TARGET_PROPERTIES.has(keyName)) return;
        context.report({ node, messageId: 'noRawRead' });
      },
    };
  },
};
