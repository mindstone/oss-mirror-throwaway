'use strict';

const DEFAULT_ALLOWLIST_SUFFIXES = [
  'src/main/ipc/libraryHandlers.ts',
  'src/core/services/space/spaceService.ts',
  'src/main/services/sharedDriveService.ts',
];

function normalizeFilename(filename) {
  return String(filename ?? '').replaceAll('\\', '/');
}

function isAllowlisted(filename, allowlistSuffixes) {
  const normalized = normalizeFilename(filename);
  return allowlistSuffixes.some((suffix) => normalized.endsWith(suffix));
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid unaudited writable scan calls and legacy scanSpaces() fallthrough usage.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowlistSuffixes: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      disallowedWritableScan:
        "scanSpacesWithSideEffects() is restricted to explicit writable-call allowlist files. Use scanSpacesReadOnly() for read-only scans, or add // eslint-disable-next-line rebel-space-scan/no-disallowed-scanspaces-side-effects -- writable-scan-allowlist: <reason> for audited exceptions.",
      disallowedLegacyScan:
        "scanSpaces() must pass explicit `{ skipAutoFix: true }` for read-only scans. Use scanSpacesWithSideEffects() from an allowlisted writable caller when side effects are required.",
    },
  },
  create(context) {
    const options = context.options?.[0] ?? {};
    const allowlistSuffixes = Array.isArray(options.allowlistSuffixes)
      ? options.allowlistSuffixes
      : DEFAULT_ALLOWLIST_SUFFIXES;
    const filename = context.filename ?? context.getFilename?.() ?? '';
    const writableAllowlisted = isAllowlisted(filename, allowlistSuffixes);
    const writableScanBindings = new Set();
    const legacyScanBindings = new Set();
    const namespaceBindings = new Set();

    function isSpaceServiceImportSource(sourceValue) {
      const normalized = normalizeFilename(sourceValue);
      return (
        normalized.endsWith('/spaceService') ||
        normalized.endsWith('/spaceService.ts')
      );
    }

    function unwrapExpression(node) {
      let current = node;
      while (
        current &&
        (
          current.type === 'TSAsExpression' ||
          current.type === 'TSTypeAssertion' ||
          current.type === 'TSNonNullExpression' ||
          current.type === 'ParenthesizedExpression'
        )
      ) {
        current = current.expression;
      }
      return current;
    }

    function hasExplicitReadOnlyLegacyOptions(args) {
      if (!Array.isArray(args) || args.length < 2) {
        return false;
      }
      const optionsArg = unwrapExpression(args[1]);
      if (!optionsArg || optionsArg.type !== 'ObjectExpression') {
        return false;
      }
      for (const property of optionsArg.properties) {
        if (property.type !== 'Property' || property.computed) {
          continue;
        }
        const key = property.key;
        const keyName =
          key.type === 'Identifier'
            ? key.name
            : key.type === 'Literal'
              ? String(key.value)
              : null;
        if (keyName !== 'skipAutoFix') {
          continue;
        }
        const value = unwrapExpression(property.value);
        return value?.type === 'Literal' && value.value === true;
      }
      return false;
    }

    function getSpaceServiceCalleeKind(callee) {
      if (callee.type === 'Identifier') {
        if (writableScanBindings.has(callee.name)) {
          return 'writable';
        }
        if (legacyScanBindings.has(callee.name)) {
          return 'legacy';
        }
        return null;
      }
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        callee.property.type === 'Identifier' &&
        namespaceBindings.has(callee.object.name)
      ) {
        if (callee.property.name === 'scanSpacesWithSideEffects') {
          return 'writable';
        }
        if (callee.property.name === 'scanSpaces') {
          return 'legacy';
        }
      }
      return null;
    }

    return {
      ImportDeclaration(node) {
        const source = node.source?.value;
        if (typeof source !== 'string' || !isSpaceServiceImportSource(source)) {
          return;
        }
        for (const specifier of node.specifiers ?? []) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            namespaceBindings.add(specifier.local.name);
            continue;
          }
          if (specifier.type !== 'ImportSpecifier') {
            continue;
          }
          const importedName =
            specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : String(specifier.imported.value);
          if (importedName === 'scanSpacesWithSideEffects') {
            writableScanBindings.add(specifier.local.name);
          } else if (importedName === 'scanSpaces') {
            legacyScanBindings.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const calleeKind = getSpaceServiceCalleeKind(node.callee);
        if (!calleeKind) {
          return;
        }
        if (calleeKind === 'writable') {
          if (!writableAllowlisted) {
            context.report({ node: node.callee, messageId: 'disallowedWritableScan' });
          }
          return;
        }
        if (!hasExplicitReadOnlyLegacyOptions(node.arguments)) {
          context.report({ node: node.callee, messageId: 'disallowedLegacyScan' });
        }
      },
    };
  },
};

module.exports = rule;
