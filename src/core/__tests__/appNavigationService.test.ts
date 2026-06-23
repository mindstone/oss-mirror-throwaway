import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppNavigationResult,
  AppNavigationService,
} from '@core/appNavigationService';

describe('AppNavigationService boundary', () => {
  let setAppNavigationService: typeof import('@core/appNavigationService').setAppNavigationService;
  let getAppNavigationService: typeof import('@core/appNavigationService').getAppNavigationService;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/appNavigationService');
    setAppNavigationService = mod.setAppNavigationService;
    getAppNavigationService = mod.getAppNavigationService;
  });

  it('returns null before any service is registered', () => {
    expect(getAppNavigationService()).toBeNull();
  });

  it('returns the registered implementation by reference', async () => {
    const impl: AppNavigationService = {
      navigateApp: vi.fn(
        async (): Promise<AppNavigationResult> => ({
          kind: 'ok',
          destination: 'settings',
          settingsTab: 'meetings',
        }),
      ),
    };

    setAppNavigationService(impl);

    expect(getAppNavigationService()).toBe(impl);
  });
});
