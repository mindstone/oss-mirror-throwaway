'use strict';

const CANONICAL_DERIVED_LIVENESS_FILE = 'src/core/services/conversationState/turnLiveness.ts';
const BASE_FORBIDDEN_TYPE = 'DerivedLiveness';

function normalizeFilename(filename) {
  return String(filename ?? '').replaceAll('\\', '/');
}

function isCanonicalFile(filename) {
  return normalizeFilename(filename).endsWith(CANONICAL_DERIVED_LIVENESS_FILE);
}

function typeNameContainsForbidden(typeName, forbiddenTypeNames) {
  if (!typeName) return false;
  if (typeName.type === 'Identifier') {
    return forbiddenTypeNames.has(typeName.name);
  }
  if (typeName.type === 'TSQualifiedName') {
    return (
      typeNameContainsForbidden(typeName.left, forbiddenTypeNames)
      || forbiddenTypeNames.has(typeName.right.name)
    );
  }
  return false;
}

function typeContainsForbidden(typeNode, forbiddenTypeNames) {
  if (!typeNode) return false;
  switch (typeNode.type) {
    case 'TSTypeReference':
      return (
        typeNameContainsForbidden(typeNode.typeName, forbiddenTypeNames)
        || (typeNode.typeParameters?.params ?? []).some((param) =>
          typeContainsForbidden(param, forbiddenTypeNames))
      );
    case 'TSExpressionWithTypeArguments':
      return (
        typeNameContainsForbidden(typeNode.expression, forbiddenTypeNames)
        || (typeNode.typeParameters?.params ?? []).some((param) =>
          typeContainsForbidden(param, forbiddenTypeNames))
      );
    case 'TSUnionType':
    case 'TSIntersectionType':
      return typeNode.types.some((item) => typeContainsForbidden(item, forbiddenTypeNames));
    case 'TSParenthesizedType':
      return typeContainsForbidden(typeNode.typeAnnotation, forbiddenTypeNames);
    case 'TSArrayType':
      return typeContainsForbidden(typeNode.elementType, forbiddenTypeNames);
    case 'TSTupleType':
      return typeNode.elementTypes.some((item) => typeContainsForbidden(item, forbiddenTypeNames));
    case 'TSIndexedAccessType':
      return (
        typeContainsForbidden(typeNode.objectType, forbiddenTypeNames)
        || typeContainsForbidden(typeNode.indexType, forbiddenTypeNames)
      );
    case 'TSConditionalType':
      return (
        typeContainsForbidden(typeNode.checkType, forbiddenTypeNames)
        || typeContainsForbidden(typeNode.extendsType, forbiddenTypeNames)
        || typeContainsForbidden(typeNode.trueType, forbiddenTypeNames)
        || typeContainsForbidden(typeNode.falseType, forbiddenTypeNames)
      );
    case 'TSInferType':
      return typeContainsForbidden(typeNode.typeParameter?.constraint, forbiddenTypeNames);
    case 'TSTypeOperator':
    case 'TSRestType':
    case 'TSOptionalType':
      return typeContainsForbidden(typeNode.typeAnnotation, forbiddenTypeNames);
    case 'TSMappedType':
      return (
        typeContainsForbidden(typeNode.typeParameter?.constraint, forbiddenTypeNames)
        || typeContainsForbidden(typeNode.typeAnnotation, forbiddenTypeNames)
        || typeContainsForbidden(typeNode.nameType, forbiddenTypeNames)
      );
    case 'TSFunctionType':
    case 'TSConstructorType':
      return (
        typeNode.params.some((param) => typeContainsForbidden(param.typeAnnotation?.typeAnnotation, forbiddenTypeNames))
        || typeContainsForbidden(typeNode.returnType?.typeAnnotation, forbiddenTypeNames)
      );
    case 'TSTypeLiteral':
      return typeNode.members.some((member) => {
        if (member.type === 'TSPropertySignature') {
          return typeContainsForbidden(member.typeAnnotation?.typeAnnotation, forbiddenTypeNames);
        }
        if (member.type === 'TSMethodSignature') {
          return typeContainsForbidden(member.returnType?.typeAnnotation, forbiddenTypeNames);
        }
        if (member.type === 'TSIndexSignature') {
          return typeContainsForbidden(member.typeAnnotation?.typeAnnotation, forbiddenTypeNames);
        }
        return false;
      });
    default:
      return false;
  }
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid `as DerivedLiveness` casts outside turnLiveness.ts (including local aliases).',
    },
    schema: [],
    messages: {
      noDerivedLivenessCast:
        'Casting to DerivedLiveness (directly or via alias) is forbidden outside src/core/services/conversationState/turnLiveness.ts. Use deriveTurnLiveness() to obtain a branded value.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? '';
    if (isCanonicalFile(filename)) {
      return {};
    }

    const forbiddenTypeNames = new Set([BASE_FORBIDDEN_TYPE]);
    const pendingCasts = [];
    const typeAliasNodes = new Map();
    const interfaceExtendsNodes = new Map();

    return {
      ImportSpecifier(node) {
        if (node.imported?.type !== 'Identifier') return;
        if (!forbiddenTypeNames.has(node.imported.name)) return;
        if (node.local?.type === 'Identifier') {
          forbiddenTypeNames.add(node.local.name);
        }
      },
      TSTypeAliasDeclaration(node) {
        if (node.id?.type !== 'Identifier') return;
        typeAliasNodes.set(node.id.name, node.typeAnnotation);
      },
      TSInterfaceDeclaration(node) {
        if (node.id?.type !== 'Identifier') return;
        interfaceExtendsNodes.set(
          node.id.name,
          (node.extends ?? []).map((item) => item.expression),
        );
      },
      TSAsExpression(node) {
        pendingCasts.push({ node, typeNode: node.typeAnnotation });
      },
      TSTypeAssertion(node) {
        pendingCasts.push({ node, typeNode: node.typeAnnotation });
      },
      'Program:exit'() {
        let changed = true;
        while (changed) {
          changed = false;

          for (const [aliasName, aliasTypeNode] of typeAliasNodes.entries()) {
            if (forbiddenTypeNames.has(aliasName)) continue;
            if (typeContainsForbidden(aliasTypeNode, forbiddenTypeNames)) {
              forbiddenTypeNames.add(aliasName);
              changed = true;
            }
          }

          for (const [interfaceName, interfaceExtends] of interfaceExtendsNodes.entries()) {
            if (forbiddenTypeNames.has(interfaceName)) continue;
            if (interfaceExtends.some((typeName) =>
              typeNameContainsForbidden(typeName, forbiddenTypeNames))) {
              forbiddenTypeNames.add(interfaceName);
              changed = true;
            }
          }
        }

        for (const cast of pendingCasts) {
          if (typeContainsForbidden(cast.typeNode, forbiddenTypeNames)) {
            context.report({
              node: cast.node,
              messageId: 'noDerivedLivenessCast',
            });
          }
        }
      },
    };
  },
};

module.exports = rule;
module.exports.CANONICAL_DERIVED_LIVENESS_FILE = CANONICAL_DERIVED_LIVENESS_FILE;
