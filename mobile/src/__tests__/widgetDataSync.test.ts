type MockInboxItem = {
  id: string;
  title: string;
  archived: boolean;
  urgent?: boolean;
};

describe('widgetDataSync recording writes', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('writes recordingStartedAt + recordingTitle before isRecording=true', () => {
    const storageSet = jest.fn();

    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios' },
    }));

    jest.doMock('@bacons/apple-targets', () => {
      class ExtensionStorage {
        constructor(_suiteName: string) {}

        set(key: string, value: unknown): void {
          storageSet(key, value);
        }

        get(_key: string): string | null {
          return null;
        }

        static reloadWidget(_kind: string): void {
          // no-op in tests
        }
      }

      return { ExtensionStorage };
    });

    jest.doMock('@rebel/cloud-client', () => ({
      useInboxStore: {
        getState: () => ({ items: [] as MockInboxItem[] }),
        subscribe: jest.fn(() => jest.fn()),
      },
      classifyInboxTier: jest.fn(() => 'act'),
      groupByTemporal: jest.fn((items: MockInboxItem[]) => new Map([['due-today', items]])),
      sortInboxItems: jest.fn((items: MockInboxItem[]) => items),
      createLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      })),
    }));

    jest.dontMock('../services/widgetDataSync');
    const { setWidgetRecordingState } = require('../services/widgetDataSync');

    setWidgetRecordingState(true, 'Meeting');

    const calledKeys = storageSet.mock.calls.map(([key]) => key);
    const startedAtIndex = calledKeys.indexOf('recordingStartedAt');
    const titleIndex = calledKeys.indexOf('recordingTitle');
    const recordingIndex = calledKeys.indexOf('isRecording');

    expect(startedAtIndex).toBeGreaterThanOrEqual(0);
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(recordingIndex).toBeGreaterThanOrEqual(0);
    expect(startedAtIndex).toBeLessThan(recordingIndex);
    expect(titleIndex).toBeLessThan(recordingIndex);
  });

  it('flips isRecording=false before clearing recordingStartedAt / recordingTitle on stop', () => {
    const storageSet = jest.fn();

    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios' },
    }));

    jest.doMock('@bacons/apple-targets', () => {
      class ExtensionStorage {
        constructor(_suiteName: string) {}

        set(key: string, value: unknown): void {
          storageSet(key, value);
        }

        get(_key: string): string | null {
          return null;
        }

        static reloadWidget(_kind: string): void {
          // no-op in tests
        }
      }

      return { ExtensionStorage };
    });

    jest.doMock('@rebel/cloud-client', () => ({
      useInboxStore: {
        getState: () => ({ items: [] as MockInboxItem[] }),
        subscribe: jest.fn(() => jest.fn()),
      },
      classifyInboxTier: jest.fn(() => 'act'),
      groupByTemporal: jest.fn((items: MockInboxItem[]) => new Map([['due-today', items]])),
      sortInboxItems: jest.fn((items: MockInboxItem[]) => items),
      createLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      })),
    }));

    jest.dontMock('../services/widgetDataSync');
    const { setWidgetRecordingState } = require('../services/widgetDataSync');

    setWidgetRecordingState(false);

    // On stop we must flip isRecording → 'false' FIRST so the Swift TTL guard
    // (which treats missing recordingStartedAt as "not recording") can never
    // observe isRecording='true' with no startedAt during the clear sequence.
    const calls = storageSet.mock.calls.map(([key, value]) => ({ key, value }));
    const isRecordingIndex = calls.findIndex((c) => c.key === 'isRecording' && c.value === 'false');
    const startedAtClearIndex = calls.findIndex((c) => c.key === 'recordingStartedAt' && c.value === '');
    const titleClearIndex = calls.findIndex((c) => c.key === 'recordingTitle' && c.value === '');

    expect(isRecordingIndex).toBeGreaterThanOrEqual(0);
    expect(startedAtClearIndex).toBeGreaterThanOrEqual(0);
    expect(titleClearIndex).toBeGreaterThanOrEqual(0);
    expect(isRecordingIndex).toBeLessThan(startedAtClearIndex);
    expect(isRecordingIndex).toBeLessThan(titleClearIndex);
  });
});
