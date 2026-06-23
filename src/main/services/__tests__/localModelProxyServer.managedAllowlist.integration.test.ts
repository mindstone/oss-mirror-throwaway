/**
 * Stage G7 — disallowed-model integration test (proxy 403 -> classifier ->
 * humanizer).
 *
 * Locks the full client-side chain for `MANAGED_MODEL_NOT_ALLOWED`:
 *
 *   1. `localModelProxyServer` emits a 403 body shaped exactly like
 *      `{ type: 'error', error: { type: 'invalid_request_error',
 *        code: 'MANAGED_MODEL_NOT_ALLOWED', requested, allowed } }`
 *      (covered structurally by `localModelProxyServer.managedAllowlist.test.ts`).
 *   2. `classifyHttpError(403, body)` -> `ModelError` with
 *      `kind = 'managed_model_not_allowed'` and
 *      `details.managedModelNotAllowed = { requested, allowed }`.
 *   3. `humanizeAgentError({ errorKind: 'managed_model_not_allowed',
 *      managedModelMeta })` -> requested-model-aware banner copy or
 *      generic-fallback copy when no metadata is present.
 *
 * The snapshot assertions are the canonical guard for renderer-facing
 * banner copy: a regression in `humanizeManagedModelNotAllowed` or any
 * lift step in between will flip these.
 *
 * See: docs/plans/260513a_subscription_consumer_audit_gaps.md Stage G7.
 */

import { describe, expect, it } from 'vitest';
import { classifyHttpError, type ModelError } from '@core/rebelCore/modelErrors';
import { humanizeAgentError, type AgentErrorKind } from '@rebel/shared';

const PROXY_403_REQUESTED = 'anthropic/claude-opus-4';
const PROXY_403_ALLOWED = [
  'anthropic/claude-sonnet-4',
  'openai/gpt-5',
  'openai/gpt-4o-mini',
];

function makeProxy403Body(
  overrides: Partial<{ requested: string; allowed: string[] | undefined }> = {},
): string {
  const requested = overrides.requested ?? PROXY_403_REQUESTED;
  const allowed = overrides.allowed ?? PROXY_403_ALLOWED;
  return JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'MANAGED_MODEL_NOT_ALLOWED',
      requested,
      ...(allowed !== undefined ? { allowed } : {}),
    },
  });
}

describe('Stage G7 - proxy 403 -> classifyHttpError', () => {
  it('classifies a fully-populated 403 body as managed_model_not_allowed with details lifted', () => {
    const body = makeProxy403Body();
    const modelError: ModelError = classifyHttpError(403, body, 'openrouter');

    expect(modelError.kind).toBe('managed_model_not_allowed');
    expect(modelError.status).toBe(403);
    expect(modelError.provider).toBe('openrouter');
    expect(modelError.details?.managedModelNotAllowed).toEqual({
      requested: PROXY_403_REQUESTED,
      allowed: PROXY_403_ALLOWED,
    });
  });

  it('preserves an empty allow-list as details.managedModelNotAllowed.allowed = []', () => {
    const body = makeProxy403Body({ allowed: [] });
    const modelError = classifyHttpError(403, body, 'openrouter');

    expect(modelError.kind).toBe('managed_model_not_allowed');
    expect(modelError.details?.managedModelNotAllowed).toEqual({
      requested: PROXY_403_REQUESTED,
      allowed: [],
    });
  });

  it('still classifies as managed_model_not_allowed when requested / allowed are absent (degraded payload)', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'MANAGED_MODEL_NOT_ALLOWED',
      },
    });
    const modelError = classifyHttpError(403, body, 'openrouter');

    expect(modelError.kind).toBe('managed_model_not_allowed');
    // When the proxy emits a degraded 403 body without requested/allowed,
    // classifyHttpError still attaches a managedModelNotAllowed entry, but
    // with no fields populated. The humanizer treats this as the generic
    // fallback branch (see Stage G7 humanizer snapshot below).
    expect(modelError.details?.managedModelNotAllowed).toEqual({});
  });

  it('does NOT classify a 403 without the MANAGED_MODEL_NOT_ALLOWED code as managed_model_not_allowed', () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'forbidden', message: 'access denied' },
    });
    const modelError = classifyHttpError(403, body, 'openrouter');

    expect(modelError.kind).not.toBe('managed_model_not_allowed');
    expect(modelError.details?.managedModelNotAllowed).toBeUndefined();
  });
});

describe('Stage G7 - humanizeAgentError(managed_model_not_allowed) snapshots', () => {
  it('produces requested-model-aware copy when managedModelMeta.requested is present', () => {
    const humanized = humanizeAgentError({
      kind: 'classified',
      errorKind: 'managed_model_not_allowed',
      rawMessage: makeProxy403Body(),
      managedModelMeta: {
        requested: PROXY_403_REQUESTED,
        allowed: PROXY_403_ALLOWED,
      },
    });

    expect(humanized).toMatchInlineSnapshot(
      `"The model 'anthropic/claude-opus-4' isn't included in your Mindstone plan. Switch to one of your plan defaults, or add a personal OpenRouter key in Settings to use it."`,
    );
  });

  it('falls back to generic copy when managedModelMeta is omitted entirely', () => {
    const humanized = humanizeAgentError({
      kind: 'classified',
      errorKind: 'managed_model_not_allowed',
      rawMessage: makeProxy403Body(),
    });

    expect(humanized).toMatchInlineSnapshot(
      `"That model isn't included in your Mindstone plan. Switch to one of your plan defaults, or add a personal OpenRouter key in Settings to use it."`,
    );
  });

  it('falls back to generic copy when managedModelMeta is present but requested is empty', () => {
    const humanized = humanizeAgentError({
      kind: 'classified',
      errorKind: 'managed_model_not_allowed',
      rawMessage: makeProxy403Body({ requested: '' }),
      managedModelMeta: { requested: '   ', allowed: PROXY_403_ALLOWED },
    });

    expect(humanized).toMatchInlineSnapshot(
      `"That model isn't included in your Mindstone plan. Switch to one of your plan defaults, or add a personal OpenRouter key in Settings to use it."`,
    );
  });

  it('uses requested-model copy even when allow-list is empty (UI still surfaces the personal-key escape hatch)', () => {
    const humanized = humanizeAgentError({
      kind: 'classified',
      errorKind: 'managed_model_not_allowed',
      rawMessage: makeProxy403Body({ allowed: [] }),
      managedModelMeta: { requested: PROXY_403_REQUESTED, allowed: [] },
    });

    expect(humanized).toContain(PROXY_403_REQUESTED);
    expect(humanized).toContain('Mindstone plan');
    expect(humanized).toContain('personal OpenRouter key');
  });
});

describe('Stage G7 - end-to-end chain: proxy 403 body -> classifier -> humanizer', () => {
  it('produces the requested-model banner copy when managedModelNotAllowed details are lifted into managedModelMeta', () => {
    const body = makeProxy403Body();
    const modelError = classifyHttpError(403, body, 'openrouter');

    // This mirrors the dispatcher lift in `agentEventDispatcher.ts` (see
    // L991-993): when `errorKind === 'managed_model_not_allowed'`, the
    // dispatcher promotes `ModelError.details.managedModelNotAllowed` into
    // the AgentEvent's `managedModelMeta` field, which is then fed into
    // `humanizeAgentError` at the renderer boundary.
    const managedModelMeta = modelError.details?.managedModelNotAllowed;
    expect(managedModelMeta).toBeDefined();

    const humanized = humanizeAgentError({
      kind: 'classified',
      errorKind: modelError.kind as AgentErrorKind,
      rawMessage: modelError.__rawMessage ?? '',
      provider: modelError.provider,
      managedModelMeta,
    });

    expect(humanized).toContain(PROXY_403_REQUESTED);
    expect(humanized).toContain('Mindstone plan');
    expect(humanized).toContain('personal OpenRouter key');
  });

  it('end-to-end with empty allow-list still produces the requested-model banner copy', () => {
    const body = makeProxy403Body({ allowed: [] });
    const modelError = classifyHttpError(403, body, 'openrouter');
    const managedModelMeta = modelError.details?.managedModelNotAllowed;

    expect(managedModelMeta).toEqual({
      requested: PROXY_403_REQUESTED,
      allowed: [],
    });

    const humanized = humanizeAgentError({
      kind: 'classified',
      errorKind: modelError.kind as AgentErrorKind,
      rawMessage: modelError.__rawMessage ?? '',
      provider: modelError.provider,
      managedModelMeta,
    });

    expect(humanized).toContain(PROXY_403_REQUESTED);
    expect(humanized).toContain('Mindstone plan');
  });

  it('end-to-end with a degraded 403 (no requested/allowed fields) falls back to generic copy', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'MANAGED_MODEL_NOT_ALLOWED',
      },
    });
    const modelError = classifyHttpError(403, body, 'openrouter');
    const managedModelMeta = modelError.details?.managedModelNotAllowed;
    // Degraded 403 still produces a managedModelNotAllowed entry (possibly
    // empty); the humanizer falls back to generic copy when `requested` is
    // not set on the meta.
    expect(managedModelMeta).toEqual({});

    const humanized = humanizeAgentError({
      kind: 'classified',
      errorKind: modelError.kind as AgentErrorKind,
      rawMessage: modelError.__rawMessage ?? '',
      provider: modelError.provider,
      managedModelMeta,
    });

    expect(humanized).toBe(
      "That model isn't included in your Mindstone plan. Switch to one of your plan defaults, or add a personal OpenRouter key in Settings to use it.",
    );
  });
});
