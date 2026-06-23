/**
 * WS0 stage 6 guard: forbid LOCAL re-declaration of the BTS storage prefixes
 * `profile:` / `model:` outside the canonical home
 * (`src/shared/utils/btsModelValueNormalization.ts`).
 *
 * Why: WS0 consolidated storage-prefix handling onto the shared
 * PROFILE_PREFIX / MODEL_PREFIX constants (and the `decodePrefixed` /
 * `stripStoredModelPrefix` helpers). It removed TWO local re-declarations of
 * `const PROFILE_PREFIX = 'profile:'` that had drifted out of the codec.
 * A re-introduced local copy is the seed of the divergence bug class WS0
 * eliminated (one site updates the prefix or its trim/slice semantics, the
 * clones don't). Import the constant from `@shared/utils/modelChoiceCodec`
 * (re-exported from the canonical home) instead.
 *
 * Scope is DELIBERATELY NARROW — it fires ONLY on a `const`/`let`/`var`
 * declarator whose name is exactly `PROFILE_PREFIX` / `MODEL_PREFIX` AND whose
 * initializer is exactly the storage literal `'profile:'` / `'model:'`. That
 * value constraint is load-bearing: it leaves alone unrelated identifiers that
 * reuse the name with a DIFFERENT value — e.g. the sub-agent label
 * `const MODEL_PREFIX = 'model-'` (hyphen, a UI label prefix, not the storage
 * wrapper) in modelAgentLabels.ts. Near-zero false positives by construction.
 */

// The two storage prefixes and the exact values that distinguish them from
// unrelated same-named constants (e.g. the `'model-'` sub-agent label prefix).
const STORAGE_PREFIX_BINDINGS = new Map([
  ['PROFILE_PREFIX', 'profile:'],
  ['MODEL_PREFIX', 'model:'],
]);

// The ONLY file allowed to declare these constants — the canonical home that
// every other consumer imports from (directly or via the modelChoiceCodec
// re-export). Suffix-matched so it works regardless of absolute CWD / worktree.
const CANONICAL_HOME = 'src/shared/utils/btsModelValueNormalization.ts';

function normalizePath(filename) {
  return (filename ?? '').replace(/\\/g, '/');
}

function isCanonicalHome(filename) {
  return normalizePath(filename).endsWith(CANONICAL_HOME);
}

function isStorageLiteral(name, init) {
  if (!init || init.type !== 'Literal' || typeof init.value !== 'string') return false;
  return STORAGE_PREFIX_BINDINGS.get(name) === init.value;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid local re-declaration of the BTS storage prefixes (profile:/model:) outside the canonical home.',
    },
    schema: [],
    messages: {
      noLocalRedeclare:
        "Do not re-declare the storage prefix `{{name}} = '{{value}}'` locally — this re-seeds the WS0 divergence bug class. Import { {{name}} } from '@shared/utils/modelChoiceCodec' (canonical home: src/shared/utils/btsModelValueNormalization.ts).",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (isCanonicalHome(filename)) {
      return {};
    }
    return {
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier') return;
        const name = node.id.name;
        if (!STORAGE_PREFIX_BINDINGS.has(name)) return;
        if (!isStorageLiteral(name, node.init)) return;
        context.report({
          node,
          messageId: 'noLocalRedeclare',
          data: { name, value: STORAGE_PREFIX_BINDINGS.get(name) },
        });
      },
    };
  },
};
