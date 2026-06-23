import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
  }),
}));

vi.mock('@core/services/apiRateLimitCooldown', () => ({
  apiRateLimitCooldown: {
    remainingMs: vi.fn(),
  },
}));

const { apiRateLimitCooldown } = await import('@core/services/apiRateLimitCooldown');
const { checkApiCooldownHealth } = await import('../apiCooldown');

const mockRemainingMs = vi.mocked(apiRateLimitCooldown.remainingMs);

describe('checkApiCooldownHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns pass when less than 30 seconds remain', () => {
    mockRemainingMs.mockReturnValue(29_999);

    expect(checkApiCooldownHealth()).toMatchObject({
      id: 'apiCooldownHealth',
      status: 'pass',
      details: { scope: 'api', remainingMs: 29_999 },
    });
  });

  it('returns warn when exactly 30 seconds remain', () => {
    mockRemainingMs.mockReturnValue(30_000);

    expect(checkApiCooldownHealth()).toMatchObject({
      id: 'apiCooldownHealth',
      status: 'warn',
      message: 'API rate-limit cooldown active.',
      remediation: 'Rebel is briefly paused to respect a rate limit. New turns will resume automatically.',
      details: { scope: 'api', remainingMs: 30_000 },
    });
  });

  it('returns warn with correct details when more than 30 seconds remain', () => {
    mockRemainingMs.mockReturnValue(60_000);

    expect(checkApiCooldownHealth()).toMatchObject({
      id: 'apiCooldownHealth',
      name: 'API Cooldown',
      status: 'warn',
      details: { scope: 'api', remainingMs: 60_000 },
    });
  });
});
