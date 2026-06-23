import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { DetectedMeeting } from '../meetingBotTypes';

type Listener = (...args: unknown[]) => void;

const harness = vi.hoisted(() => {
  class MockNotification {
    static instances: MockNotification[] = [];
    static supported = true;
    static isSupported = vi.fn(() => MockNotification.supported);

    listeners = new Map<string, Listener[]>();
    show = vi.fn();

    constructor(public readonly options: { title: string; body: string }) {
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
    getAllWindows: vi.fn((): unknown[] => []),
    mockLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    settings: { meetingBot: { enabled: true, joinMode: 'prompt' } } as Record<string, unknown>,
    rebelTestMode: false,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: harness.getAllWindows,
  },
  Notification: harness.MockNotification,
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => harness.mockLogger),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => harness.settings),
}));

vi.mock('@main/services/meetingCacheStore', () => ({
  getCachedMeetings: vi.fn(() => ({ meetings: [] })),
  hasRealPrepPath: vi.fn(() => false),
}));

vi.mock('../pendingTranscriptsStore', () => ({
  getPendingTranscripts: vi.fn(() => []),
  updatePendingTranscriptCalendarInfo: vi.fn(),
}));

vi.mock('../meetingBotRuntimeRegistry', () => ({
  registerCurrentMeetingProvider: vi.fn(),
  stopLocalRecording: vi.fn(),
  getLocalRecordingStatus: vi.fn(() => ({ isRecording: false, isCapturing: false, isUploading: false })),
}));

vi.mock('../../../utils/testIsolation', () => ({
  isRebelTestMode: vi.fn(() => harness.rebelTestMode),
}));

vi.mock('../recorderInstallation', () => ({
  isRecorderInstalled: vi.fn(() => true),
}));

function makeWindow(overrides: Partial<{
  isDestroyed: boolean;
  isVisible: boolean;
  isMinimized: boolean;
  webContentsDestroyed: boolean;
  loading: boolean;
}> = {}) {
  const listeners = new Map<string, Listener[]>();
  return {
    isDestroyed: vi.fn(() => overrides.isDestroyed ?? false),
    isVisible: vi.fn(() => overrides.isVisible ?? true),
    isMinimized: vi.fn(() => overrides.isMinimized ?? false),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: vi.fn(() => overrides.webContentsDestroyed ?? false),
      isLoadingMainFrame: vi.fn(() => overrides.loading ?? false),
      send: vi.fn(),
      once: vi.fn((event: string, listener: Listener) => {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
      }),
      emit(event: string): void {
        for (const listener of listeners.get(event) ?? []) {
          listener();
        }
      },
    },
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const MEETING: DetectedMeeting = {
  platform: 'zoom',
  title: 'Pipeline review',
  url: 'https://meet.example.test/abc',
  windowId: 'meeting-window-1',
};

describe('desktopSdkService meeting notification click targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.MockNotification.instances.length = 0;
    harness.MockNotification.supported = true;
    harness.settings = { meetingBot: { enabled: true, joinMode: 'prompt' } };
    harness.rebelTestMode = false;
  });

  it('sends the click payload to the injected main window without scanning all windows', async () => {
    const service = await import('../desktopSdkService');
    const injectedMainWindow = makeWindow();
    const wrongWindow = makeWindow();

    harness.getAllWindows.mockReturnValue([wrongWindow]);
    service.setMeetingNotificationWindowTarget({
      getMainWindow: () => injectedMainWindow as unknown as BrowserWindow,
      ensureMainWindow: async () => {
        throw new Error('ensure should not be called when main window is live');
      },
    });

    service.showMeetingDetectedNotification(MEETING);
    harness.MockNotification.instances[0]?.emit('click');
    await flushAsync();

    expect(harness.getAllWindows).not.toHaveBeenCalled();
    expect(injectedMainWindow.focus).toHaveBeenCalledTimes(1);
    expect(injectedMainWindow.webContents.send).toHaveBeenCalledWith('meeting-notification:clicked', {
      meetingUrl: MEETING.url,
      meetingTitle: MEETING.title,
    });
    expect(wrongWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('ensures and targets a recreated main window when no live main window exists', async () => {
    const service = await import('../desktopSdkService');
    const recreatedWindow = makeWindow({ isVisible: false, isMinimized: true });
    const ensureMainWindow = vi.fn(async () => recreatedWindow as unknown as BrowserWindow);

    service.setMeetingNotificationWindowTarget({
      getMainWindow: () => null,
      ensureMainWindow,
    });

    service.showMeetingDetectedNotification(MEETING);
    harness.MockNotification.instances[0]?.emit('click');
    await flushAsync();

    expect(ensureMainWindow).toHaveBeenCalledTimes(1);
    expect(recreatedWindow.show).toHaveBeenCalledTimes(1);
    expect(recreatedWindow.restore).toHaveBeenCalledTimes(1);
    expect(recreatedWindow.focus).toHaveBeenCalledTimes(1);
    expect(recreatedWindow.webContents.send).toHaveBeenCalledWith('meeting-notification:clicked', {
      meetingUrl: MEETING.url,
      meetingTitle: MEETING.title,
    });
  });

  it('waits for a reloading main frame before sending the click payload', async () => {
    const service = await import('../desktopSdkService');
    const loadingWindow = makeWindow({ loading: true });

    service.setMeetingNotificationWindowTarget({
      getMainWindow: () => loadingWindow as unknown as BrowserWindow,
      ensureMainWindow: async () => loadingWindow as unknown as BrowserWindow,
    });

    service.showMeetingDetectedNotification(MEETING);
    harness.MockNotification.instances[0]?.emit('click');
    await flushAsync();

    expect(loadingWindow.webContents.send).not.toHaveBeenCalled();
    expect(loadingWindow.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));

    loadingWindow.webContents.emit('did-finish-load');

    expect(loadingWindow.webContents.send).toHaveBeenCalledWith('meeting-notification:clicked', {
      meetingUrl: MEETING.url,
      meetingTitle: MEETING.title,
    });
  });
});
