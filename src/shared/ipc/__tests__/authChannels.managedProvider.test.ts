import { describe, it, expect } from 'vitest';
import { authChannels } from '../channels/auth';

/**
 * Stage H1 — lock the wire shape of the managed-provider info delivered via
 * `auth:get-config`. The renderer credit-meter UX relies on `resetsAt`,
 * `currency`, and `period` being optional-but-allowed; the analytics
 * dedup keys off `resetsAt`; the meter falls back to "data unavailable"
 * when the credit fields are zero or missing.
 *
 * If a future change ever makes any of these fields required or drops the
 * legacy minimal shape, this test trips so we re-evaluate the renderer
 * fallback path.
 */
describe('auth:get-config — managedProvider schema (Stage H1)', () => {
  const responseSchema = authChannels['auth:get-config'].response;

  const baseConfig = {
    hasVoiceProvider: false,
    hasVoiceApiKey: false,
    hasAnthropicApiKey: false,
    hasSharedDriveConfig: false,
    recommendedConnectors: [],
    hasSpaces: false,
    licenseTier: 'free' as const,
    disabledConnectorTools: {},
    hasManagedKey: true,
  };

  const baseManaged = {
    provider: 'openrouter',
    keyHash: 'k-1',
    allowedModels: ['anthropic/claude-sonnet'],
    creditLimitMonthly: 20000,
    creditUsedMonthly: 1500,
  };

  it('accepts the legacy managedProvider shape (no resetsAt/currency/period)', () => {
    const parsed = responseSchema.parse({
      ...baseConfig,
      managedProvider: baseManaged,
    });
    expect(parsed?.managedProvider?.resetsAt).toBeUndefined();
    expect(parsed?.managedProvider?.currency).toBeUndefined();
    expect(parsed?.managedProvider?.period).toBeUndefined();
  });

  it('accepts the full H1 shape with resetsAt/currency/period', () => {
    const parsed = responseSchema.parse({
      ...baseConfig,
      managedProvider: {
        ...baseManaged,
        resetsAt: '2026-06-01T00:00:00.000Z',
        currency: 'USD',
        period: 'month',
      },
    });
    expect(parsed?.managedProvider?.resetsAt).toBe('2026-06-01T00:00:00.000Z');
    expect(parsed?.managedProvider?.currency).toBe('USD');
    expect(parsed?.managedProvider?.period).toBe('month');
  });

  it('rejects non-string resetsAt', () => {
    expect(() =>
      responseSchema.parse({
        ...baseConfig,
        managedProvider: { ...baseManaged, resetsAt: 1234567890 },
      }),
    ).toThrow();
  });

  it('rejects unknown period values', () => {
    expect(() =>
      responseSchema.parse({
        ...baseConfig,
        managedProvider: { ...baseManaged, period: 'week' },
      }),
    ).toThrow();
  });

  it('accepts omitted credit fields and preserves undefined (server not populated)', () => {
    const parsed = responseSchema.parse({
      ...baseConfig,
      managedProvider: {
        provider: 'openrouter',
        keyHash: 'k-1',
        allowedModels: [],
        // creditLimitMonthly + creditUsedMonthly intentionally omitted
      },
    });
    expect(parsed?.managedProvider?.creditLimitMonthly).toBeUndefined();
    expect(parsed?.managedProvider?.creditUsedMonthly).toBeUndefined();
  });

  it('rejects non-numeric credit fields', () => {
    expect(() =>
      responseSchema.parse({
        ...baseConfig,
        managedProvider: {
          ...baseManaged,
          creditUsedMonthly: '100',
        },
      }),
    ).toThrow();
  });

  it('defaults isOssBuild to false when omitted', () => {
    const parsed = responseSchema.parse(baseConfig);
    expect(parsed?.isOssBuild).toBe(false);
  });

  it.each([true, false])('accepts explicit isOssBuild=%s', (isOssBuild) => {
    const parsed = responseSchema.parse({
      ...baseConfig,
      isOssBuild,
    });
    expect(parsed?.isOssBuild).toBe(isOssBuild);
  });
});
