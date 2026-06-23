'use strict';

/**
 * no-default-model-literal
 *
 * AST guard for the OpenRouter Sonnet bypass remediation:
 *   docs/plans/260514_openrouter_sonnet_bypass_remediation.md (Stage 6)
 *
 * The April 2026 "Sonnet bypass" incident shipped because provider-blind
 * fallbacks of the form `?? DEFAULT_MODEL` and `?? 'claude-sonnet-4-6'`
 * silently substituted Anthropic Sonnet on non-Anthropic auths (OpenRouter,
 * Codex), inflating spend per-token (OR gpt-5.5 = 1.82x Sonnet/token, Codex
 * gpt-5.5 = 1.72x Sonnet/token) while holding rate flat. Stages 1-4 migrated
 * every production site to the provider-aware helper
 *   `getDefaultModelForProvider(settings, role)`
 * in `src/shared/utils/getDefaultModelForProvider.ts`.
 *
 * This rule prevents a future agent from re-introducing the bypass pattern.
 *
 * Scope (via eslint.config.mjs):
 *   - src/main/services/**
 *   - src/shared/utils/**
 *
 * Allowlist (rule-level, exported as `NO_DEFAULT_MODEL_LITERAL_ALLOWLIST`):
 *
 *   1. src/shared/data/openRouterModels.ts
 *      BYOK Anthropic alias-resolution catalog. Sonnet is the correct catalog
 *      default for an Anthropic-alias resolution miss in the BYOK model
 *      catalog -- this is a catalog lookup, not a provider-routing decision.
 *      See plan-doc L113 STRIKE row and L361 II-H1 strikethrough rationale.
 *
 *   2. src/main/services/promptCacheWarmupService.ts
 *      Preflight Anthropic prompt-cache warmup. The warmup path is gated on
 *      `routePlan.provider === 'anthropic'` higher up the stack -- bypass is
 *      preconditioned on Anthropic. Defensive allowlist entry: if a future
 *      agent ever re-introduces a literal here, Stage 4 telemetry breadcrumb
 *      fires when the precondition is bypassed.
 *
 *   3. src/main/services/useCaseGeneratorService.ts
 *      Use-case planning / scaffolding path. Anthropic-pinned for prompt
 *      stability (the generator was tuned on Claude prompts). Defensive
 *      allowlist entry with the same Stage 4 telemetry breadcrumb behaviour.
 *
 * Each allowlist entry MUST carry both:
 *   - a documented `precondition` string explaining why the literal is OK
 *   - a `planLink` field pointing at the remediation plan
 *
 * The regression test
 *   eslint-rules/__tests__/no-default-model-literal.test.js
 * asserts the allowlist contains exactly these three entries; any drift
 * (removal, fourth entry without precondition/planLink, or empty fields)
 * fails the test.
 *
 * Patterns flagged:
 *   - LogicalExpression `?? 'claude-sonnet-4-6'` or `?? DEFAULT_MODEL`
 *   - LogicalExpression `|| 'claude-sonnet-4-6'` or `|| DEFAULT_MODEL`
 *   - ReturnStatement returning `'claude-sonnet-4-6'` or `DEFAULT_MODEL`
 *   - ConditionalExpression consequent/alternate being either of the above
 *
 * Patterns NOT flagged (intentional):
 *   - Declaration sites (`export const DEFAULT_MODEL = 'claude-sonnet-4-6'`)
 *     -- the rule never matches a `VariableDeclarator` RHS.
 *   - Property values (`{ model: DEFAULT_MODEL }`, `{ model: 'claude-sonnet-4-6' }`)
 *     -- these are usually provider-already-resolved contexts (e.g. switching
 *     TO the Anthropic provider). Property values are matched ONLY in
 *     return/fallback/conditional positions.
 *   - Pure imports (`import { DEFAULT_MODEL } from '...'`)
 *     -- the import itself is fine; usage in a fallback position is what
 *     matters. Imports often coexist with legitimate Anthropic-only paths
 *     (e.g. councilService.ts gates a fallback inside
 *     `if (settings.activeProvider === 'anthropic')`).
 *
 * Override (rare; for legitimate Anthropic-pinned fallbacks outside the
 * three allowlisted files):
 *
 *   // eslint-disable-next-line no-default-model-literal -- <reason>
 *
 * The reason MUST cite the provider gate that makes the literal safe, e.g.:
 *
 *   // eslint-disable-next-line no-default-model-literal -- gated on
 *   //   activeProvider === 'anthropic' five lines above; see plan-doc L113.
 */

const path = require('node:path');

const FORBIDDEN_LITERAL = 'claude-sonnet-4-6';
const FORBIDDEN_IDENTIFIER = 'DEFAULT_MODEL';

const PLAN_DOC = 'docs/plans/260514_openrouter_sonnet_bypass_remediation.md';

const NO_DEFAULT_MODEL_LITERAL_ALLOWLIST = Object.freeze([
  Object.freeze({
    file: 'src/shared/data/openRouterModels.ts',
    precondition:
      'BYOK Anthropic alias-resolution catalog -- Sonnet is the correct ' +
      'catalog default for an alias-resolution miss, not a provider-routing ' +
      'decision. See plan-doc L113 STRIKE row and L361 II-H1 strikethrough.',
    planLink: PLAN_DOC,
  }),
  Object.freeze({
    file: 'src/main/services/promptCacheWarmupService.ts',
    precondition:
      'Anthropic-only preflight prompt-cache warmup -- bypass is gated on ' +
      "routePlan.provider === 'anthropic' higher in the call graph. Stage 4 " +
      'telemetry breadcrumb fires if the precondition is ever bypassed.',
    planLink: PLAN_DOC,
  }),
  Object.freeze({
    file: 'src/main/services/useCaseGeneratorService.ts',
    precondition:
      'Anthropic-pinned planning/scaffolding path -- prompt-stability ' +
      'requires Claude. Stage 4 telemetry breadcrumb fires if the ' +
      'precondition is ever bypassed.',
    planLink: PLAN_DOC,
  }),
]);

function normalizeFilename(filename) {
  return String(filename ?? '').replaceAll('\\', '/');
}

function isAllowlistedFile(filename) {
  const normalised = normalizeFilename(filename);
  for (const entry of NO_DEFAULT_MODEL_LITERAL_ALLOWLIST) {
    if (normalised.endsWith(entry.file)) return true;
  }
  return false;
}

function isForbiddenLiteral(node) {
  return Boolean(
    node
    && node.type === 'Literal'
    && typeof node.value === 'string'
    && node.value === FORBIDDEN_LITERAL,
  );
}

function isForbiddenIdentifier(node) {
  return Boolean(
    node
    && node.type === 'Identifier'
    && node.name === FORBIDDEN_IDENTIFIER,
  );
}

function isForbiddenValue(node) {
  return isForbiddenLiteral(node) || isForbiddenIdentifier(node);
}

function reportMessage(forbiddenLabel, context) {
  return (
    `Provider-blind fallback to ${forbiddenLabel} re-introduces the ` +
    'OpenRouter Sonnet bypass class. Use ' +
    "`getDefaultModelForProvider(settings, role)` from " +
    '`@shared/utils/getDefaultModelForProvider` so the resolved default ' +
    'matches the active provider. See ' +
    `${PLAN_DOC}. ` +
    'For genuine Anthropic-only paths outside the three allowlisted files, ' +
    'use `// eslint-disable-next-line no-default-model-literal -- <reason>` ' +
    "and cite the provider gate (e.g. activeProvider === 'anthropic').`"
  );
}

function forbiddenLabel(node) {
  if (isForbiddenLiteral(node)) return `'${FORBIDDEN_LITERAL}'`;
  if (isForbiddenIdentifier(node)) return FORBIDDEN_IDENTIFIER;
  return 'value';
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid provider-blind fallbacks to DEFAULT_MODEL / \'claude-sonnet-4-6\' ' +
        'in main/services and shared/utils. Use getDefaultModelForProvider instead.',
    },
    schema: [],
    messages: {
      forbidden: '{{message}}',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? '';
    if (isAllowlistedFile(filename)) {
      return {};
    }

    function report(node) {
      context.report({
        node,
        messageId: 'forbidden',
        data: { message: reportMessage(forbiddenLabel(node), context) },
      });
    }

    return {
      LogicalExpression(node) {
        if (node.operator !== '??' && node.operator !== '||') return;
        if (isForbiddenValue(node.right)) {
          report(node.right);
        }
      },
      ReturnStatement(node) {
        if (node.argument && isForbiddenValue(node.argument)) {
          report(node.argument);
        }
      },
      ConditionalExpression(node) {
        if (isForbiddenValue(node.consequent)) {
          report(node.consequent);
        }
        if (isForbiddenValue(node.alternate)) {
          report(node.alternate);
        }
      },
    };
  },
};

module.exports = rule;
module.exports.NO_DEFAULT_MODEL_LITERAL_ALLOWLIST = NO_DEFAULT_MODEL_LITERAL_ALLOWLIST;
module.exports.FORBIDDEN_LITERAL = FORBIDDEN_LITERAL;
module.exports.FORBIDDEN_IDENTIFIER = FORBIDDEN_IDENTIFIER;
module.exports.PLAN_DOC = PLAN_DOC;
