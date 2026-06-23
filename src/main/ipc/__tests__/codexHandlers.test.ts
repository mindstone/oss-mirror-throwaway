import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

const testState = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => Promise<unknown>>(),
  sendToAllWindows: vi.fn(),
  codexLogin: vi.fn(),
  codexLogout: vi.fn(),
  getCodexStatus: vi.fn(),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown) => Promise<unknown>) => {
    testState.handlers.set(channel, handler);
  }),
}));

vi.mock('../../services/codexAuthService', () => ({
  codexLogin: testState.codexLogin,
  codexLogout: testState.codexLogout,
  getCodexStatus: testState.getCodexStatus,
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: testState.sendToAllWindows });
});

function getHandler(channel: string): (event: unknown) => Promise<unknown> {
  const handler = testState.handlers.get(channel);
  if (!handler) {
    throw new Error(`Missing handler for channel: ${channel}`);
  }
  return handler;
}

describe('codexHandlers credential-update signaling', () => {
  beforeEach(async () => {
    testState.handlers.clear();
    testState.sendToAllWindows.mockClear();
    testState.codexLogin.mockReset().mockResolvedValue({ success: true, email: 'user@example.com' });
    testState.codexLogout.mockReset().mockResolvedValue(undefined);
    testState.getCodexStatus.mockReset().mockReturnValue({ connected: false });

    const { registerCodexHandlers } = await import('../codexHandlers');
    registerCodexHandlers();
  });

  it('broadcasts settings:external-update and triggers catch-up on successful Codex reconnect', async () => {
    const scheduler = { handleAppLaunch: vi.fn() };
    // FOX-3494: sweep guard now reads the POST-heal activeProvider.
    const healProviderAfterReconnect = vi.fn((): AppSettings['activeProvider'] => 'codex');
    const { registerCodexHandlers } = await import('../codexHandlers');
    registerCodexHandlers({
      getScheduler: () => scheduler as any,
      healProviderAfterReconnect,
    });

    const result = await getHandler('codex:login')(undefined);

    expect(testState.codexLogin).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true });
    expect(healProviderAfterReconnect).toHaveBeenCalledTimes(1);
    expect(testState.sendToAllWindows).toHaveBeenCalledWith('settings:external-update');
    expect(scheduler.handleAppLaunch).toHaveBeenCalledTimes(1);
  });

  it('triggers catch-up after a heal flips a stranded activeProvider to codex (FOX-3494)', async () => {
    const scheduler = { handleAppLaunch: vi.fn() };
    // Pre-heal the user was on 'anthropic'; the heal flips them to 'codex', so
    // the sweep (which reads POST-heal) MUST fire — the old pre-heal read skipped it.
    const healProviderAfterReconnect = vi.fn((): AppSettings['activeProvider'] => 'codex');
    const { registerCodexHandlers } = await import('../codexHandlers');
    registerCodexHandlers({
      getScheduler: () => scheduler as any,
      healProviderAfterReconnect,
    });

    await getHandler('codex:login')(undefined);

    expect(healProviderAfterReconnect).toHaveBeenCalledTimes(1);
    expect(scheduler.handleAppLaunch).toHaveBeenCalledTimes(1);
  });

  it('broadcasts settings:external-update on successful Codex login without catch-up when post-heal provider is not codex', async () => {
    const scheduler = { handleAppLaunch: vi.fn() };
    const healProviderAfterReconnect = vi.fn((): AppSettings['activeProvider'] => 'anthropic');
    const { registerCodexHandlers } = await import('../codexHandlers');
    registerCodexHandlers({
      getScheduler: () => scheduler as any,
      healProviderAfterReconnect,
    });

    const result = await getHandler('codex:login')(undefined);

    expect(testState.codexLogin).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true });
    expect(testState.sendToAllWindows).toHaveBeenCalledWith('settings:external-update');
    expect(scheduler.handleAppLaunch).not.toHaveBeenCalled();
  });

  it('does not broadcast, heal, or catch up when codex login returns success=false', async () => {
    testState.codexLogin.mockResolvedValueOnce({ success: false, error: 'cancelled' });
    const scheduler = { handleAppLaunch: vi.fn() };
    const healProviderAfterReconnect = vi.fn((): AppSettings['activeProvider'] => 'codex');
    const { registerCodexHandlers } = await import('../codexHandlers');
    registerCodexHandlers({
      getScheduler: () => scheduler as any,
      healProviderAfterReconnect,
    });

    await getHandler('codex:login')(undefined);

    expect(healProviderAfterReconnect).not.toHaveBeenCalled();
    expect(testState.sendToAllWindows).not.toHaveBeenCalled();
    expect(scheduler.handleAppLaunch).not.toHaveBeenCalled();
  });

  it('broadcasts settings:external-update on successful Codex logout', async () => {
    await getHandler('codex:logout')(undefined);

    expect(testState.sendToAllWindows).toHaveBeenCalledWith('settings:external-update');
  });
});
