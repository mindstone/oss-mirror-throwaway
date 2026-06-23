'use strict';

/**
 * no-raw-headless-check
 *
 * Forbids re-inlining the "is this the headless CLI?" check. The single source of
 * truth is `isHeadlessCli()` (src/core/utils/headlessCli.ts, re-exported from
 * src/main/utils/testIsolation.ts).
 *
 * WHY: the headless-CLI launch signal was previously re-implemented in ~8 places
 * (startup-dialog gate, single-instance lock, arch-mismatch check, auto-update,
 * Super-MCP launch-context, visibility scheduler, update reconciliation), several
 * carrying a now-retired `app.commandLine.hasSwitch('headless-cli')` "belt" that the
 * env+argv check already covered and that preserved an inconsistent half-state
 * (`--headless-cli=value` would suppress some gates yet never enter CLI mode). Once
 * consolidated, the only way the drift regrows is someone re-inlining a raw check.
 * This rule turns that into a failing lint — the by-construction kill, where a
 * one-time grep would not prevent future re-inlining.
 *
 * Flags (READS only — the SETTER `process.env.REBEL_HEADLESS_CLI = '1'` is an
 * assignment and is allowed):
 *  - any read of `process.env.REBEL_HEADLESS_CLI` (dot or `['REBEL_HEADLESS_CLI']` bracket)
 *  - `<...>.includes('--headless-cli')`
 *  - `<...>.commandLine.hasSwitch('headless-cli')`
 *
 * Does NOT flag unrelated flags (`REBEL_HEADLESS`, `--rebel-test`). SCOPE: src/**
 * via eslint.config.mjs, with the SSOT module + test files exempt.
 */
const HEADLESS_ENV = 'REBEL_HEADLESS_CLI';
const HEADLESS_FLAG = '--headless-cli';
const HEADLESS_SWITCH = 'headless-cli';

// Static property name of a MemberExpression — handles both dot access
// (`.REBEL_HEADLESS_CLI`) and computed string-literal access (`['REBEL_HEADLESS_CLI']`).
function staticPropName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return null;
}

// Matches `process.env.REBEL_HEADLESS_CLI` AND `process.env['REBEL_HEADLESS_CLI']`
// (and the `process['env']…` computed forms).
function isProcessEnvHeadless(node) {
  if (!node || node.type !== 'MemberExpression') return false;
  if (staticPropName(node) !== HEADLESS_ENV) return false;
  const obj = node.object;
  if (!obj || obj.type !== 'MemberExpression') return false;
  if (staticPropName(obj) !== 'env') return false;
  return obj.object.type === 'Identifier' && obj.object.name === 'process';
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid re-inlining the headless-CLI check; use isHeadlessCli() (src/core/utils/headlessCli.ts).',
    },
    schema: [],
    messages: {
      noRawHeadlessCheck:
        'Do not re-inline the headless-CLI check ({{what}}) — call isHeadlessCli() from @core/utils/headlessCli (re-exported by src/main/utils/testIsolation.ts). It is the single source of truth; inlining it reintroduces the drift the consolidation removed.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (!isProcessEnvHeadless(node)) return;
        // Allow the setter: `process.env.REBEL_HEADLESS_CLI = ...`
        const parent = node.parent;
        if (parent && parent.type === 'AssignmentExpression' && parent.left === node) return;
        context.report({
          node,
          messageId: 'noRawHeadlessCheck',
          data: { what: 'process.env.REBEL_HEADLESS_CLI' },
        });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier') return;
        const method = callee.property.name;
        const firstArg = node.arguments[0];
        const firstIsStr =
          firstArg && firstArg.type === 'Literal' && typeof firstArg.value === 'string';
        if (!firstIsStr) return;
        if (method === 'includes' && firstArg.value === HEADLESS_FLAG) {
          context.report({
            node,
            messageId: 'noRawHeadlessCheck',
            data: { what: "argv.includes('--headless-cli')" },
          });
          return;
        }
        if (method === 'hasSwitch' && firstArg.value === HEADLESS_SWITCH) {
          context.report({
            node,
            messageId: 'noRawHeadlessCheck',
            data: { what: "commandLine.hasSwitch('headless-cli')" },
          });
        }
      },
    };
  },
};

module.exports = rule;
