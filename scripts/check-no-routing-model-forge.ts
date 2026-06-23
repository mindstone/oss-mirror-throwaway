#!/usr/bin/env npx tsx
/**
 * CI guard: `unsafeAssertRoutingModelId` must not be used in production code.
 *
 * It forges a `RoutingModelId` from a raw string, bypassing the codec decode
 * boundary. Stage 1 of the model/provider hardening program
 * (docs/plans/260530_model-provider-hardening) made `RoutingModelId` originate
 * ONLY at decode chokepoints; the last-mile forge (formerly
 * `requireRoutingModelId`) was removed across the turn pipeline. This guard
 * stops it returning: production code must obtain a `RoutingModelId` via the
 * codec decode functions (`decodeRoutingModelId` / `decodeRoleChoice` /
 * `stripStoredModelPrefix`) at a chokepoint — not by asserting a raw string.
 *
 * This is the "forge can't return" half of the construction guarantee (the
 * ESLint `no-model-brand-casts` rule blocks `as RoutingModelId` casts; this
 * blocks the named escape-hatch import).
 *
 * Allowed callers:
 *   - `src/shared/utils/btsModelValueNormalization.ts` — defines the helper
 *     (extracted from modelChoiceCodec to break a circular dependency; the
 *     codec re-exports it). See branch 260527_bts-tier-aware-default-resolver.
 *   - `src/shared/utils/modelChoiceCodec.ts` — re-exports the helper.
 *   - test files (`*.test.ts(x)`, `**​/__tests__/**`) — construct branded fixtures.
 *
 * See docs/plans/260530_model-provider-hardening Decision Log (Stage 1) and the
 * adversarial review subagent_reports/260531_010000_*.
 */
import { execSync } from 'node:child_process';

const HELPER = 'unsafeAssertRoutingModelId';

// `|| true` so rg's exit-1 (no matches) doesn't throw; we inspect stdout.
const out = execSync(
  `rg -n --no-heading "${HELPER}" src evals --type ts ` +
    `-g '!**/*.test.ts' -g '!**/*.test.tsx' -g '!**/__tests__/**' ` +
    `-g '!**/modelChoiceCodec.ts' -g '!**/btsModelValueNormalization.ts' || true`,
  { encoding: 'utf8' },
).trim();

if (out) {
  console.error(
    `❌ ${HELPER} used in production code (it forges a RoutingModelId from a raw string, ` +
      `bypassing the decode boundary):\n${out}\n\n` +
      `Obtain a RoutingModelId via the codec decode functions ` +
      `(decodeRoutingModelId / decodeRoleChoice / stripStoredModelPrefix) at a decode ` +
      `chokepoint instead. The unsafe helper is for codec internals + tests/eval-harness only.\n` +
      `See docs/plans/260530_model-provider-hardening (Stage 1, model-id lifecycle).`,
  );
  process.exit(1);
}

console.log(
  `✓ no production forge of RoutingModelId (${HELPER} confined to the codec + tests)`,
);
