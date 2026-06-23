const BANNED_BRANDS = new Set([
  'StoredModelChoice',
  'RoutingModelId',
  'ProfileRef',
  'WireModelId',
  'ValidatedChatCompletionsBody',
]);

const BANNED_BRAND_CONTAINERS = new Set([
  'OpenAIRequest',
]);

const ALLOWED_BRAND_CAST_FILES = [
  'src/shared/utils/modelChoiceCodec.ts',
  'src/shared/utils/btsModelValueNormalization.ts',
  // Owns WireModelId minters, including the route-plan pass-through brand boundary.
  'src/shared/utils/wireModelId.ts',
  'src/core/services/chatCompletionsParamCapability.ts',
];

function normalizePath(filename) {
  return filename.replace(/\\/g, '/');
}

function isAllowedFile(filename) {
  const normalized = normalizePath(filename);
  return ALLOWED_BRAND_CAST_FILES.some((allowed) => normalized.endsWith(allowed));
}

function getTypeName(node) {
  if (!node) return null;
  if (node.type === 'TSTypeReference') {
    if (node.typeName.type === 'Identifier') return node.typeName.name;
    if (node.typeName.type === 'TSQualifiedName') return node.typeName.right.name;
  }
  if (node.type === 'TSImportType' && node.qualifier?.type === 'Identifier') {
    return node.qualifier.name;
  }
  return null;
}

function getTypeAnnotation(node) {
  return node?.typeAnnotation ?? null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent bypassing model-id lifecycle brands with direct casts.',
    },
    schema: [],
    messages: {
      noModelBrandCast:
        'Do not cast to {{brand}} outside the owning codec/minter/chokepoint file. Route raw values through the branded construction API instead.',
    },
  },
  create(context) {
    if (isAllowedFile(context.filename ?? context.getFilename())) {
      return {};
    }

    const localAliases = new Set();

    function bannedName(name) {
      if (!name) return null;
      if (BANNED_BRANDS.has(name) || BANNED_BRAND_CONTAINERS.has(name) || localAliases.has(name)) {
        return name;
      }
      return null;
    }

    function findBannedType(node) {
      if (!node) return null;

      const directName = bannedName(getTypeName(node));
      if (directName) return directName;

      switch (node.type) {
        case 'TSArrayType':
          return findBannedType(node.elementType);
        case 'TSUnionType':
        case 'TSIntersectionType':
          for (const type of node.types) {
            const brand = findBannedType(type);
            if (brand) return brand;
          }
          return null;
        case 'TSTypeLiteral':
          for (const member of node.members) {
            const brand = findBannedType(getTypeAnnotation(member.typeAnnotation));
            if (brand) return brand;
          }
          return null;
        case 'TSParenthesizedType':
          return findBannedType(node.typeAnnotation);
        case 'TSTypeOperator':
          return findBannedType(node.typeAnnotation);
        case 'TSIndexedAccessType':
          return findBannedType(node.objectType) ?? findBannedType(node.indexType);
        case 'TSMappedType':
          return findBannedType(node.typeAnnotation);
        case 'TSConditionalType':
          return findBannedType(node.checkType)
            ?? findBannedType(node.extendsType)
            ?? findBannedType(node.trueType)
            ?? findBannedType(node.falseType);
        default:
          return null;
      }
    }

    function findContextualNeverTarget(node) {
      if (node.typeAnnotation?.type !== 'TSNeverKeyword') return null;
      const parent = node.parent;
      if (parent?.type === 'VariableDeclarator') {
        return findBannedType(getTypeAnnotation(parent.id.typeAnnotation));
      }
      if (parent?.type === 'AssignmentExpression') {
        return findBannedType(getTypeAnnotation(parent.left.typeAnnotation));
      }
      return null;
    }

    function findContextualUnsafeTarget(node) {
      if (node.typeAnnotation?.type !== 'TSAnyKeyword' && node.typeAnnotation?.type !== 'TSUnknownKeyword') {
        return null;
      }
      const parent = node.parent;
      if (parent?.type === 'VariableDeclarator' && parent.init === node) {
        return findBannedType(getTypeAnnotation(parent.id.typeAnnotation));
      }
      if (parent?.type === 'AssignmentExpression' && parent.right === node) {
        return findBannedType(getTypeAnnotation(parent.left.typeAnnotation));
      }
      return null;
    }

    function check(node) {
      const brand = findBannedType(node.typeAnnotation)
        ?? findContextualNeverTarget(node)
        ?? findContextualUnsafeTarget(node);
      if (!brand) return;
      context.report({ node: node.typeAnnotation, messageId: 'noModelBrandCast', data: { brand } });
    }

    return {
      TSTypeAliasDeclaration(node) {
        if (findBannedType(node.typeAnnotation)) {
          localAliases.add(node.id.name);
        }
      },
      TSAsExpression: check,
      TSTypeAssertion: check,
    };
  },
};
