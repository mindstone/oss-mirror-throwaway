/**
 * Unit tests for the `app:consume-pending-notification-click` IPC handler
 * (260610 notification-click-conversation fix, plan Stage 4).
 *
 * Uses the REAL notificationClickIntent store (not a mock) so this is an
 * honest handler→store round-trip: consume-once must hold across the IPC
 * boundary, and the handler's response must satisfy the channel's Zod
 * response schema for both hit and miss (the contract the renderer's
 * auto-derived `window.appApi.consumePendingNotificationClick()` parses).
 *
 * Pattern: appHandlers.revealPath.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appChannels } from '@shared/ipc/channels/app';

const { registeredHandlers, mockLogger } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  mockLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0') },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), openExternal: vi.fn() },
  clipboard: {},
  nativeImage: {},
  dialog: {},
}));

vi.mock('@core/logger', () => ({
  logger: mockLogger,
  createScopedLogger: vi.fn(() => mockLogger),
}));

vi.mock('../../utils/isAllowedExternalUrl', () => ({ isAllowedExternalUrl: vi.fn(() => true) }));
vi.mock('../../services/gracefulShutdown', () => ({ wasCleanExit: vi.fn(() => true) }));
vi.mock('../../services/safeModeContext', () => ({
  getSafeModeContext: vi.fn(),
  saveContextBeforeRelaunch: vi.fn(),
}));
vi.mock('../../services/tutorialPlayerServer', () => ({ getTutorialPlayerUrl: vi.fn() }));
vi.mock('../../services/spaceService', () => ({ resolveViaSpaceName: vi.fn(async () => null) }));

import { registerAppHandlers } from '../appHandlers';
// REAL store, deliberately unmocked.
import {
  consumePendingNotificationClickIntent,
  recordNotificationClickIntent,
} from '../../services/desktopNotification/notificationClickIntent';

const CHANNEL = 'app:consume-pending-notification-click';
const responseSchema = appChannels[CHANNEL].response;
const TTL_MS = 5 * 60 * 1000;

function getConsumeHandler(): (event: unknown) => unknown {
  const handler = registeredHandlers.get(CHANNEL);
  expect(handler).toBeDefined();
  return handler as (event: unknown) => unknown;
}

describe('app:consume-pending-notification-click handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    // Drain any intent left behind by a previous test (real module state).
    consumePendingNotificationClickIntent();
    registerAppHandlers({
      getSettings: () => ({ coreDirectory: '/workspace' }) as never,
      isSafeMode: () => false,
      setSafeModeEnabled: vi.fn(),
    });
  });

  it('returns null on an empty store and logs the miss at info', () => {
    const consume = getConsumeHandler();
    const result = consume({});

    expect(result).toBeNull();
    expect(responseSchema.parse(result)).toBeNull();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ hit: false, missReason: 'miss-empty' }),
      'Consumed pending notification click intent',
    );
  });

  it('returns a recorded sessionId intent once, then null (consume-once across the IPC boundary)', () => {
    recordNotificationClickIntent({ sessionId: 'session-42' });
    const consume = getConsumeHandler();

    const hit = consume({});
    expect(hit).toEqual(
      expect.objectContaining({ sessionId: 'session-42', clickedAt: expect.any(Number) }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ hit: true, sessionId: 'session-42', intentAgeMs: expect.any(Number) }),
      'Consumed pending notification click intent',
    );

    const miss = consume({});
    expect(miss).toBeNull();
  });

  it('returns a filePath intent that satisfies the channel response schema', () => {
    recordNotificationClickIntent({ filePath: '/space/notes.md' });
    const consume = getConsumeHandler();

    const result = consume({});
    const parsed = responseSchema.parse(result);
    expect(parsed).toEqual(expect.objectContaining({ filePath: '/space/notes.md' }));
  });

  it('hit responses satisfy the Zod refine (at least one destination present)', () => {
    recordNotificationClickIntent({ sessionId: 's-1', filePath: '/f.md' });
    const consume = getConsumeHandler();
    expect(() => responseSchema.parse(consume({}))).not.toThrow();
  });

  it('returns null for an expired intent and logs miss-expired with the intent age', () => {
    recordNotificationClickIntent({ sessionId: 'stale' }, Date.now() - TTL_MS - 1000);
    const consume = getConsumeHandler();

    const result = consume({});
    expect(result).toBeNull();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ hit: false, missReason: 'miss-expired', intentAgeMs: expect.any(Number) }),
      'Consumed pending notification click intent',
    );
  });
});
