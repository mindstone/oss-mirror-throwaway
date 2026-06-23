/**
 * Runtime wire-shape assertion for models with special Anthropic wire limits.
 *
 * Sampling-forbidden models reject `temperature`/`top_p`/`top_k`. Always-on
 * thinking models additionally reject any `thinking` config other than exactly
 * `{ type: 'adaptive' }` (with optional `display: 'summarized'`) — including
 * `budget_tokens` alongside `type: 'adaptive'` — with a 400. The primary
 * defence is compile-time: the BTS options sanitizer mints the branded
 * `WireSafeBtsOptions` the transports require. This assertion is the runtime
 * backstop at the two request-body seams the brand can't see —
 * `anthropicClient` body builds and the BTS Anthropic-dialect transports —
 * so a FUTURE caller adding a sampling param to a body construction path
 * fails loudly instead of shipping a guaranteed 400.
 *
 * Behaviour (mirrors the `agentEventDispatcher` enforceErrorKindWireContract
 * precedent):
 *   - test/dev (`NODE_ENV === 'test' | 'development'`): THROW, so a violating
 *     edit fails in CI / at the dev's desk before merge.
 *   - prod: capture via the errorReporter boundary (never a direct Sentry
 *     import in core), STRIP the offending fields in place so the request
 *     still succeeds, and emit a structured log. The user's request must not
 *     be sacrificed to observability.
 */
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isAlwaysOnThinkingModel, isSamplingParamsForbiddenModel } from './modelLimits';

const log = createScopedLogger({ service: 'alwaysOnThinkingWireSafety' });

/** Sampling params sampling-forbidden models reject with a 400. */
const FORBIDDEN_SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k'] as const;

export class AlwaysOnThinkingWireSafetyError extends Error {
  constructor(model: string, seam: string, violations: string[]) {
    super(
      `Wire-safety violation for model "${model}" at ${seam}: ` +
        `request body carries [${violations.join(', ')}], which the model rejects with a 400. ` +
        'Route the options through sanitizeBtsOptionsForWireModel (BTS) or fix the body construction.',
    );
    this.name = 'AlwaysOnThinkingWireSafetyError';
  }
}

/**
 * Assert (and in prod, repair) that `body` is wire-safe for `model` when the
 * model rejects sampling params and/or has always-on thinking. No-op for every
 * other model.
 *
 * @param model - the wire model id this body will be sent as (any form —
 *   `anthropic/` prefix, `[1m]` suffix, dated suffix all normalize).
 * @param body - the request body about to be serialized. MUTATED in the prod
 *   arm: offending fields are deleted so the request still succeeds.
 * @param seam - stable label for the call site (logs/Sentry fingerprint).
 */
export function assertWireSafeForAlwaysOnThinking(
  model: string,
  body: Record<string, unknown>,
  seam: string,
): void {
  const samplingForbidden = isSamplingParamsForbiddenModel(model);
  const alwaysOn = isAlwaysOnThinkingModel(model);
  if (!samplingForbidden && !alwaysOn) return;

  const violations: string[] = [];
  if (samplingForbidden) {
    for (const param of FORBIDDEN_SAMPLING_PARAMS) {
      if (body[param] !== undefined) violations.push(param);
    }
  }
  // `thinking` must be absent or EXACTLY `{ type: 'adaptive' }` plus an
  // optional `display: 'summarized'`. Fable rejects `budget_tokens` with a
  // 400 even alongside `type: 'adaptive'` (verified live 2026-06-11), and any
  // other extra key is wire-unverified — reject both rather than only the
  // non-adaptive type (GPT F2, Fable 5 Phase-6 refinement).
  const thinking = body.thinking as Record<string, unknown> | null | undefined;
  let thinkingNonAdaptive = false;
  const offendingThinkingKeys: string[] = [];
  if (alwaysOn && thinking !== undefined) {
    if (thinking?.type !== 'adaptive') {
      thinkingNonAdaptive = true;
      violations.push('thinking(non-adaptive)');
    } else {
      for (const key of Object.keys(thinking)) {
        if (key === 'type') continue;
        if (key === 'display' && thinking.display === 'summarized') continue;
        offendingThinkingKeys.push(key);
        violations.push(`thinking.${key}`);
      }
    }
  }
  if (violations.length === 0) return;

  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === 'test' || nodeEnv === 'development') {
    throw new AlwaysOnThinkingWireSafetyError(model, seam, violations);
  }

  // Prod: capture + strip + structured log. Never block or fail the request —
  // stripping yields exactly the wire shape the sanitizer would have produced.
  if (samplingForbidden) {
    for (const param of FORBIDDEN_SAMPLING_PARAMS) {
      if (body[param] !== undefined) delete body[param];
    }
  }
  if (alwaysOn && thinkingNonAdaptive) {
    // Omitting `thinking` entirely is valid for always-on models (always-on is
    // the server-side default); safer than guessing an adaptive rewrite.
    delete body.thinking;
  } else if (alwaysOn && thinking && offendingThinkingKeys.length > 0) {
    // Adaptive base shape is valid — surgically drop only the unverified
    // extra keys (e.g. budget_tokens), preserving `type` + valid `display`.
    for (const key of offendingThinkingKeys) delete thinking[key];
  }
  try {
    getErrorReporter().captureException(
      new AlwaysOnThinkingWireSafetyError(model, seam, violations),
      {
        tags: { area: 'bts', invariant: 'always-on-thinking-wire-safe', seam },
        extra: { model, violations },
        fingerprint: ['always-on-thinking-wire-unsafe', seam],
      },
    );
  } catch (captureError) {
    ignoreBestEffortCleanup(captureError, {
      operation: 'alwaysOnThinkingWireSafety.captureViolation',
      reason: 'Observability must never break the request path; the strip already repaired the body.',
    });
  }
  log.warn(
    { model, seam, violations },
    'Model wire-safety violation: stripped unsupported params from request body (request proceeds)',
  );
}
