/**
 * Tests for the provider-failover telemetry payload builder
 * (docs/plans/260621_paid-fallback-indicator/).
 *
 * The builder must carry the REAL resolved destination + billing axis (known only
 * on the successful retry), the originating credential, the hop count, and a fixed
 * reason — and stay PII-safe (categorical only).
 */

import { describe, expect, it } from 'vitest';
import {
  buildProviderFailoverTelemetry,
  deriveProviderFailoverReason,
  PROVIDER_FAILOVER_EVENT,
} from '../providerFailoverTelemetry';

describe('buildProviderFailoverTelemetry', () => {
  it('carries the real destination, billing axis, origin, and hop count', () => {
    const payload = buildProviderFailoverTelemetry({
      attemptedCredentialSources: ['openrouter-oauth-token'],
      resolvedCredentialSource: 'anthropic-api-key',
      resolvedBillingSource: 'pay-per-use',
    });

    expect(payload).toEqual({
      from: 'openrouter-oauth-token',
      to: 'anthropic-api-key',
      billingSource: 'pay-per-use',
      reason: 'rate-limit-failover',
      hopCount: 1,
    });
  });

  it('reports the first attempted credential as `from` across multiple hops', () => {
    const payload = buildProviderFailoverTelemetry({
      attemptedCredentialSources: ['openrouter-oauth-token', 'anthropic-api-key'],
      resolvedCredentialSource: 'mindstone-managed-key',
      resolvedBillingSource: 'subscription',
    });

    expect(payload.from).toBe('openrouter-oauth-token');
    expect(payload.to).toBe('mindstone-managed-key');
    expect(payload.billingSource).toBe('subscription');
    expect(payload.hopCount).toBe(2);
  });

  it('preserves a null billing axis (no billing identity on the resolved route)', () => {
    const payload = buildProviderFailoverTelemetry({
      attemptedCredentialSources: ['anthropic-api-key'],
      resolvedCredentialSource: 'local-none',
      resolvedBillingSource: null,
    });

    expect(payload.billingSource).toBeNull();
  });

  it('falls back to `unknown` origin and hopCount 0 when attempted set is absent', () => {
    const payload = buildProviderFailoverTelemetry({
      attemptedCredentialSources: undefined,
      resolvedCredentialSource: 'openrouter-oauth-token',
      resolvedBillingSource: 'pool',
    });

    expect(payload.from).toBe('unknown');
    expect(payload.hopCount).toBe(0);
  });

  it('defaults reason to rate-limit-failover when not specified', () => {
    const payload = buildProviderFailoverTelemetry({
      attemptedCredentialSources: ['openrouter-oauth-token'],
      resolvedCredentialSource: 'anthropic-api-key',
      resolvedBillingSource: 'pay-per-use',
    });

    expect(payload.reason).toBe('rate-limit-failover');
  });

  it('carries the server-error-failover reason for Stage 3 server/transient switches', () => {
    const payload = buildProviderFailoverTelemetry({
      attemptedCredentialSources: ['openrouter-oauth-token'],
      resolvedCredentialSource: 'anthropic-api-key',
      resolvedBillingSource: 'pay-per-use',
      reason: 'server-error-failover',
    });

    expect(payload).toEqual({
      from: 'openrouter-oauth-token',
      to: 'anthropic-api-key',
      billingSource: 'pay-per-use',
      reason: 'server-error-failover',
      hopCount: 1,
    });
  });

  it('carries the mixed-rate-limit-and-server-error reason for mixed episodes', () => {
    const payload = buildProviderFailoverTelemetry({
      attemptedCredentialSources: ['openrouter-oauth-token', 'anthropic-api-key'],
      resolvedCredentialSource: 'codex-subscription',
      resolvedBillingSource: 'subscription',
      reason: 'mixed-rate-limit-and-server-error',
    });

    expect(payload.reason).toBe('mixed-rate-limit-and-server-error');
  });

  it('exports a stable event name', () => {
    expect(PROVIDER_FAILOVER_EVENT).toBe('Provider Failover Observed');
  });
});

describe('deriveProviderFailoverReason (FIX-3 — shared reason derivation)', () => {
  it('pure 429 episode → rate-limit-failover (byte-identical to pre-Stage-3)', () => {
    expect(deriveProviderFailoverReason({ rateLimitCount: 2, serverTransientCount: 0 }))
      .toBe('rate-limit-failover');
  });

  it('pure server/transient episode → server-error-failover', () => {
    expect(deriveProviderFailoverReason({ rateLimitCount: 0, serverTransientCount: 1 }))
      .toBe('server-error-failover');
  });

  it('mixed episode (both classes) → mixed-rate-limit-and-server-error', () => {
    expect(deriveProviderFailoverReason({ rateLimitCount: 1, serverTransientCount: 1 }))
      .toBe('mixed-rate-limit-and-server-error');
  });

  it('empty (neither) → rate-limit-failover default (guard upstream prevents emission)', () => {
    expect(deriveProviderFailoverReason({ rateLimitCount: 0, serverTransientCount: 0 }))
      .toBe('rate-limit-failover');
  });
});
