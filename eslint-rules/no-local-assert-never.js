'use strict';

const CANONICAL_ASSERT_NEVER = 'src/shared/utils/assertNever.ts';
const ALLOW_COMMENT = /rebel-assert-never-allow:\s*\S/;

function normalizeFilename(filename) {
  return String(filename ?? '').replaceAll('\\', '/');
}

function isCanonicalAssertNeverFile(filename) {
  return normalizeFilename(filename).endsWith(CANONICAL_ASSERT_NEVER);
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid local assertNever declarations outside src/shared/utils/assertNever.ts.',
    },
    schema: [],
    messages: {
      noLocalAssertNever:
        'Local assertNever declarations are forbidden. Import { assertNever } from @shared/utils/assertNever instead, or add // rebel-assert-never-allow: <reason> for a genuinely specialised variant.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const filename = context.filename ?? context.getFilename?.() ?? '';
    if (isCanonicalAssertNeverFile(filename)) {
      return {};
    }

    function hasAllowComment(node) {
      const startLine = node.loc?.start?.line;
      if (typeof startLine !== 'number') return false;
      return sourceCode
        .getAllComments()
        .some((comment) => (
          comment.loc?.end?.line === startLine - 1 &&
          ALLOW_COMMENT.test(comment.value)
        ));
    }

    function reportIfNeeded(node) {
      if (hasAllowComment(node)) return;
      context.report({ node, messageId: 'noLocalAssertNever' });
    }

    return {
      FunctionDeclaration(node) {
        if (node.id?.name === 'assertNever') {
          reportIfNeeded(node);
        }
      },
      VariableDeclarator(node) {
        if (node.id?.type === 'Identifier' && node.id.name === 'assertNever') {
          reportIfNeeded(node);
        }
      },
    };
  },
};

module.exports = rule;
