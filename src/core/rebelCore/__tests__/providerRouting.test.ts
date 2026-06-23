import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { canRouteSlashFormModel } from '../providerRouting';

describe('canRouteSlashFormModel', () => {
  it('returns true when a personal OpenRouter OAuth token is present', () => {
    expect(canRouteSlashFormModel({
      activeProvider: 'anthropic',
      openRouter: { oauthToken: 'or-token' },
    })).toBe(true);
  });

  it('returns true when activeProvider is mindstone', () => {
    expect(canRouteSlashFormModel({
      activeProvider: 'mindstone',
      openRouter: { oauthToken: null },
    })).toBe(true);
  });

  it('returns false when neither mindstone nor personal OpenRouter OAuth is available', () => {
    expect(canRouteSlashFormModel({
      activeProvider: undefined,
      openRouter: { oauthToken: null },
    })).toBe(false);
  });
});
