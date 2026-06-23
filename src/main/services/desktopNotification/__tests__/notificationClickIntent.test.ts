/**
 * Behavioral tests for the pending notification-click intent store
 * (260610 notification-click-conversation fix, plan Stage 4).
 *
 * Contracts under guard:
 *  - consume-once: a recorded intent is returned exactly once, then the store
 *    is empty (miss-empty), so a click can never replay/double-navigate.
 *  - TTL: intents older than 5 minutes (measured from clickedAt, NOT
 *    notification creation) are dropped with missReason 'miss-expired'.
 *  - latest-click-wins: recording overwrites any pending intent (accepted
 *    product behavior, DA Q1 — collapse-to-last matches user intent).
 *  - window-target indirection: unwired defaults fail loud (warn log) and
 *    return null; wired targets are filtered for destroyed windows.
 *
 * Module state (pendingIntent + window target) is reset via vi.resetModules()
 * + dynamic import per test, so tests are order-independent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@core/logger', () => ({
  logger: mockLogger,
  createScopedLogger: vi.fn(() => mockLogger),
}));

const TTL_MS = 5 * 60 * 1000;

async function loadIntentModule() {
  return await import('../notificationClickIntent');
}

function makeWindow(overrides: Partial<{
  isDestroyed: boolean;
  webContentsDestroyed: boolean;
}> = {}): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => overrides.isDestroyed ?? false),
    webContents: {
      isDestroyed: vi.fn(() => overrides.webContentsDestroyed ?? false),
    },
  } as unknown as BrowserWindow;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('recordNotificationClickIntent', () => {
  it('throws when neither sessionId nor filePath is provided (no empty intents can enter the store)', async () => {
    const mod = await loadIntentModule();
    expect(() => mod.recordNotificationClickIntent({})).toThrow(/sessionId or filePath/);
    // Nothing was stored.
    expect(mod.consumePendingNotificationClickIntent()).toBeNull();
  });

  it('omits absent destination keys instead of storing undefined values', async () => {
    const mod = await loadIntentModule();
    mod.recordNotificationClickIntent({ sessionId: 's-1' }, 1000);
    const intent = mod.consumePendingNotificationClickIntent(1000);
    expect(intent).toEqual({ sessionId: 's-1', clickedAt: 1000 });
    expect(intent).not.toHaveProperty('filePath');
  });
});

describe('consume-once semantics', () => {
  it('returns a recorded intent exactly once, then miss-empty', async () => {
    const mod = await loadIntentModule();
    mod.recordNotificationClickIntent({ sessionId: 's-1', filePath: '/f.md' }, 5000);

    const first = mod.consumePendingNotificationClickIntentResult(6000);
    expect(first.intent).toEqual({ sessionId: 's-1', filePath: '/f.md', clickedAt: 5000 });
    expect(first.intentAgeMs).toBe(1000);
    expect(first.missReason).toBeUndefined();

    const second = mod.consumePendingNotificationClickIntentResult(6000);
    expect(second.intent).toBeNull();
    expect(second.intentAgeMs).toBeNull();
    expect(second.missReason).toBe('miss-empty');
  });

  it('consume on an empty store reports miss-empty', async () => {
    const mod = await loadIntentModule();
    const result = mod.consumePendingNotificationClickIntentResult();
    expect(result).toEqual({ intent: null, intentAgeMs: null, missReason: 'miss-empty' });
  });

  it('the simple consume wrapper also clears (no replay through either entry point)', async () => {
    const mod = await loadIntentModule();
    mod.recordNotificationClickIntent({ sessionId: 's-2' }, 1000);
    expect(mod.consumePendingNotificationClickIntent(1000)?.sessionId).toBe('s-2');
    expect(mod.consumePendingNotificationClickIntent(1000)).toBeNull();
  });
});

describe('TTL (measured from clickedAt)', () => {
  it('drops intents older than 5 minutes with miss-expired and the real age', async () => {
    const mod = await loadIntentModule();
    mod.recordNotificationClickIntent({ sessionId: 's-old' }, 0);
    const result = mod.consumePendingNotificationClickIntentResult(TTL_MS + 1);
    expect(result.intent).toBeNull();
    expect(result.missReason).toBe('miss-expired');
    expect(result.intentAgeMs).toBe(TTL_MS + 1);
  });

  it('returns an intent aged exactly TTL (boundary is exclusive)', async () => {
    const mod = await loadIntentModule();
    mod.recordNotificationClickIntent({ sessionId: 's-boundary' }, 0);
    const result = mod.consumePendingNotificationClickIntentResult(TTL_MS);
    expect(result.intent?.sessionId).toBe('s-boundary');
    expect(result.missReason).toBeUndefined();
  });

  it('an expired consume still clears the store (expired intents cannot resurrect)', async () => {
    const mod = await loadIntentModule();
    mod.recordNotificationClickIntent({ sessionId: 's-old' }, 0);
    expect(mod.consumePendingNotificationClickIntentResult(TTL_MS + 1).missReason).toBe('miss-expired');
    expect(mod.consumePendingNotificationClickIntentResult(TTL_MS + 1).missReason).toBe('miss-empty');
  });
});

describe('latest-click-wins', () => {
  it('a second record overwrites the first; only the latest is consumable, once', async () => {
    const mod = await loadIntentModule();
    mod.recordNotificationClickIntent({ sessionId: 'first' }, 1000);
    mod.recordNotificationClickIntent({ filePath: '/latest.md' }, 2000);

    const intent = mod.consumePendingNotificationClickIntent(2500);
    expect(intent).toEqual({ filePath: '/latest.md', clickedAt: 2000 });
    expect(mod.consumePendingNotificationClickIntent(2500)).toBeNull();
  });
});

describe('window-target indirection', () => {
  it('fails loud (warn) and returns null when used before wiring', async () => {
    const mod = await loadIntentModule();

    expect(mod.getLiveNotificationMainWindow()).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith('Notification window target used before wiring');

    mockLogger.warn.mockClear();
    await expect(mod.ensureNotificationMainWindow()).resolves.toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith('Notification window ensure used before wiring');
  });

  it('returns the wired window when live and filters destroyed windows/webContents', async () => {
    const mod = await loadIntentModule();
    const liveWin = makeWindow();
    mod.setNotificationWindowTarget({
      getMainWindow: () => liveWin,
      ensureMainWindow: async () => liveWin,
    });

    expect(mod.getLiveNotificationMainWindow()).toBe(liveWin);
    await expect(mod.ensureNotificationMainWindow()).resolves.toBe(liveWin);
    // Wired target must not hit the fail-loud default.
    expect(mockLogger.warn).not.toHaveBeenCalled();

    const destroyedWin = makeWindow({ isDestroyed: true });
    mod.setNotificationWindowTarget({
      getMainWindow: () => destroyedWin,
      ensureMainWindow: async () => destroyedWin,
    });
    expect(mod.getLiveNotificationMainWindow()).toBeNull();
    await expect(mod.ensureNotificationMainWindow()).resolves.toBeNull();

    const deadContentsWin = makeWindow({ webContentsDestroyed: true });
    mod.setNotificationWindowTarget({
      getMainWindow: () => deadContentsWin,
      ensureMainWindow: async () => deadContentsWin,
    });
    expect(mod.getLiveNotificationMainWindow()).toBeNull();
    await expect(mod.ensureNotificationMainWindow()).resolves.toBeNull();
  });

  it('returns null when the wired getter has no window', async () => {
    const mod = await loadIntentModule();
    mod.setNotificationWindowTarget({
      getMainWindow: () => null,
      ensureMainWindow: async () => null,
    });
    expect(mod.getLiveNotificationMainWindow()).toBeNull();
    await expect(mod.ensureNotificationMainWindow()).resolves.toBeNull();
  });
});
