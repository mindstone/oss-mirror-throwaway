/**
 * Behavioral tests for ElectronDesktopNotificationSink
 * (260610 notification-click-conversation fix, plan Stage 4).
 *
 * Contracts under guard:
 *  - Gate bails: missing title/destination, rebel-test mode, notifications
 *    disabled, platform unsupported → no Notification is constructed.
 *  - Retention: the sink subscribes 'click' and 'failed' ONLY — deliberately
 *    NO 'close' listener, because macOS can emit 'close' when a banner
 *    auto-dismisses to Notification Center (the delayed-click case retention
 *    exists for). A 'close' release would void the GC fix.
 *  - Click handler: records the intent BEFORE any windowing (so the payload
 *    survives the no-window path), then focuses/creates the main window and
 *    sends a PAYLOAD-FREE nudge on 'notification:clicked'. The payload only
 *    travels over the Zod-contracted `app:consume-pending-notification-click`
 *    invoke channel, so no raw-send payload drift guard is needed — payload
 *    drift on the nudge is structurally meaningless.
 *  - No-window path: intent still recorded; warn logged; no send; no throw.
 *  - Handler errors are logged, never thrown out of the Electron event.
 *
 * Not unit-tested here (per plan Verification Notes): actual GC retention of
 * Notification instances and the retained-set size cap — module-private state
 * with no observable seam; covered by manual/packaged verification.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

const harness = vi.hoisted(() => {
  class MockNotification {
    static instances: MockNotification[] = [];
    static supported = true;
    static isSupported = () => MockNotification.supported;

    options: { title: string; body: string };
    listeners = new Map<string, Listener[]>();
    show = vi.fn();

    constructor(options: { title: string; body: string }) {
      this.options = options;
      MockNotification.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
      return this;
    }

    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener();
      }
    }
  }

  return {
    MockNotification,
    mockLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    settings: { notifications: { enabled: true } } as Record<string, unknown>,
    rebelTestMode: false,
    // Cross-module call-order trace: proves intent is recorded before any
    // windowing (the no-silent-drop contract).
    callOrder: [] as string[],
    mockRecordIntent: vi.fn(),
    mockGetLiveWindow: vi.fn(),
    mockEnsureWindow: vi.fn(),
  };
});

vi.mock('electron', () => ({
  Notification: harness.MockNotification,
}));

vi.mock('@core/logger', () => ({
  logger: harness.mockLogger,
  createScopedLogger: vi.fn(() => harness.mockLogger),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => harness.settings),
}));

vi.mock('../../../utils/testIsolation', () => ({
  isRebelTestMode: vi.fn(() => harness.rebelTestMode),
}));

vi.mock('../notificationClickIntent', () => ({
  recordNotificationClickIntent: (...args: unknown[]) => {
    harness.callOrder.push('record');
    return harness.mockRecordIntent(...args);
  },
  getLiveNotificationMainWindow: (...args: unknown[]) => {
    harness.callOrder.push('getLive');
    return harness.mockGetLiveWindow(...args);
  },
  ensureNotificationMainWindow: async (...args: unknown[]) => {
    harness.callOrder.push('ensure');
    return harness.mockEnsureWindow(...args);
  },
}));

import { ElectronDesktopNotificationSink } from '../electronDesktopNotificationSink';

function makeWindow(overrides: Partial<{
  isDestroyed: boolean;
  isVisible: boolean;
  isMinimized: boolean;
  webContentsDestroyed: boolean;
}> = {}) {
  return {
    isDestroyed: vi.fn(() => overrides.isDestroyed ?? false),
    isVisible: vi.fn(() => overrides.isVisible ?? true),
    isMinimized: vi.fn(() => overrides.isMinimized ?? false),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: vi.fn(() => overrides.webContentsDestroyed ?? false),
      send: vi.fn(),
    },
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const PARAMS = { title: 'Rebel conversation finished', body: 'Done', sessionId: 'session-1' };

describe('ElectronDesktopNotificationSink', () => {
  let sink: ElectronDesktopNotificationSink;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.MockNotification.instances.length = 0;
    harness.MockNotification.supported = true;
    harness.settings = { notifications: { enabled: true } };
    harness.rebelTestMode = false;
    harness.callOrder.length = 0;
    harness.mockGetLiveWindow.mockReturnValue(null);
    harness.mockEnsureWindow.mockResolvedValue(null);
    sink = new ElectronDesktopNotificationSink();
  });

  describe('gate bails (no Notification constructed)', () => {
    it.each([
      ['missing title', { title: '', body: 'b', sessionId: 's' }],
      ['missing both sessionId and filePath', { title: 't', body: 'b' }],
    ])('%s', (_label, params) => {
      sink.showDesktopNotification(params);
      expect(harness.MockNotification.instances).toHaveLength(0);
    });

    it('rebel-test mode', () => {
      harness.rebelTestMode = true;
      sink.showDesktopNotification(PARAMS);
      expect(harness.MockNotification.instances).toHaveLength(0);
    });

    it('notifications disabled in settings', () => {
      harness.settings = { notifications: { enabled: false } };
      sink.showDesktopNotification(PARAMS);
      expect(harness.MockNotification.instances).toHaveLength(0);

      harness.settings = {};
      sink.showDesktopNotification(PARAMS);
      expect(harness.MockNotification.instances).toHaveLength(0);
    });

    it('platform does not support notifications', () => {
      harness.MockNotification.supported = false;
      sink.showDesktopNotification(PARAMS);
      expect(harness.MockNotification.instances).toHaveLength(0);
    });
  });

  describe('show + retention listener wiring', () => {
    it('shows the notification and subscribes click + failed but deliberately NOT close', () => {
      sink.showDesktopNotification(PARAMS);

      expect(harness.MockNotification.instances).toHaveLength(1);
      const notification = harness.MockNotification.instances[0];
      expect(notification.show).toHaveBeenCalledTimes(1);
      expect(notification.options).toEqual({ title: PARAMS.title, body: PARAMS.body });

      expect(notification.listeners.has('click')).toBe(true);
      expect(notification.listeners.has('failed')).toBe(true);
      // Retention contract: macOS emits 'close' on banner auto-dismiss to
      // Notification Center; releasing there would re-open the GC'd-handler
      // bug for delayed clicks. A 'close' subscription appearing here means
      // someone re-added the release — fail.
      expect(notification.listeners.has('close')).toBe(false);
    });

    it('passes an empty body through unchanged (the || fallback keeps it a string)', () => {
      sink.showDesktopNotification({ title: 't', body: '', filePath: '/f.md' });
      expect(harness.MockNotification.instances[0].options.body).toBe('');
    });

    it('a failed event does not throw', () => {
      sink.showDesktopNotification(PARAMS);
      expect(() => harness.MockNotification.instances[0].emit('failed')).not.toThrow();
    });
  });

  describe('click handler', () => {
    it('records the intent BEFORE any windowing, then sends a payload-free nudge to the live main window', async () => {
      const win = makeWindow();
      harness.mockGetLiveWindow.mockReturnValue(win);

      sink.showDesktopNotification({ ...PARAMS, filePath: '/note.md' });
      harness.MockNotification.instances[0].emit('click');
      await flushAsync();

      expect(harness.mockRecordIntent).toHaveBeenCalledWith({
        sessionId: 'session-1',
        filePath: '/note.md',
      });
      // Intent-before-windowing: a crash/no-window after this point cannot
      // lose the payload.
      expect(harness.callOrder.indexOf('record')).toBeLessThan(harness.callOrder.indexOf('getLive'));

      expect(win.focus).toHaveBeenCalledTimes(1);
      // Payload-free nudge: exactly the channel name, no payload args.
      expect(win.webContents.send).toHaveBeenCalledTimes(1);
      expect(win.webContents.send).toHaveBeenCalledWith('notification:clicked');
      expect(win.webContents.send.mock.calls[0]).toHaveLength(1);
      // Live window available → no ensure/create needed.
      expect(harness.mockEnsureWindow).not.toHaveBeenCalled();
    });

    it('shows and restores a hidden, minimized window before focusing', async () => {
      const win = makeWindow({ isVisible: false, isMinimized: true });
      harness.mockGetLiveWindow.mockReturnValue(win);

      sink.showDesktopNotification(PARAMS);
      harness.MockNotification.instances[0].emit('click');
      await flushAsync();

      expect(win.show).toHaveBeenCalledTimes(1);
      expect(win.restore).toHaveBeenCalledTimes(1);
      expect(win.focus).toHaveBeenCalledTimes(1);
    });

    it('falls back to ensureMainWindow when no live window, recording intent first', async () => {
      const created = makeWindow();
      harness.mockGetLiveWindow.mockReturnValue(null);
      harness.mockEnsureWindow.mockResolvedValue(created);

      sink.showDesktopNotification(PARAMS);
      harness.MockNotification.instances[0].emit('click');
      await flushAsync();

      expect(harness.callOrder.indexOf('record')).toBeLessThan(harness.callOrder.indexOf('ensure'));
      expect(created.focus).toHaveBeenCalledTimes(1);
      expect(created.webContents.send).toHaveBeenCalledWith('notification:clicked');
    });

    it('no-window path: intent is STILL recorded, warn logged, nothing sent, nothing thrown', async () => {
      harness.mockGetLiveWindow.mockReturnValue(null);
      harness.mockEnsureWindow.mockResolvedValue(null);

      sink.showDesktopNotification(PARAMS);
      expect(() => harness.MockNotification.instances[0].emit('click')).not.toThrow();
      await flushAsync();

      // The payload survives for the pull channel even though no window
      // existed at click time — the old silent `if (win)` drop is dead.
      expect(harness.mockRecordIntent).toHaveBeenCalledWith({
        sessionId: 'session-1',
        filePath: undefined,
      });
      expect(harness.mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1' }),
        'Notification clicked but no main window was available',
      );
    });

    it('does not nudge a window that died between ensure and focus', async () => {
      const dyingWin = makeWindow({ isDestroyed: true });
      harness.mockGetLiveWindow.mockReturnValue(dyingWin);

      sink.showDesktopNotification(PARAMS);
      harness.MockNotification.instances[0].emit('click');
      await flushAsync();

      expect(dyingWin.focus).not.toHaveBeenCalled();
      expect(dyingWin.webContents.send).not.toHaveBeenCalled();
    });

    it('logs and swallows errors from the click handler instead of throwing into Electron', async () => {
      harness.mockRecordIntent.mockImplementation(() => {
        throw new Error('record exploded');
      });

      sink.showDesktopNotification(PARAMS);
      expect(() => harness.MockNotification.instances[0].emit('click')).not.toThrow();
      await flushAsync();

      expect(harness.mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Error handling notification click',
      );
    });
  });
});
