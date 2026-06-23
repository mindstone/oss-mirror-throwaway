const originalFetch = global.fetch;

function createResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function setupWidgetBackgroundRefreshHarness() {
  jest.resetModules();

  const defineTask = jest.fn();
  const mockUseAuthStoreGetState = jest.fn();
  const mockDeriveWidgetActionItems = jest.fn();
  const mockWriteToAppGroupDefaults = jest.fn();
  const mockGetCurrentWidgetActionItemsCount = jest.fn();

  jest.doMock('expo-task-manager', () => ({
    __esModule: true,
    defineTask,
    isTaskRegisteredAsync: jest.fn(),
  }));

  jest.doMock('expo-background-fetch', () => ({
    __esModule: true,
    BackgroundFetchResult: { NoData: 1, NewData: 2, Failed: 3 },
    BackgroundFetchStatus: { Denied: 1, Restricted: 2, Available: 3 },
    getStatusAsync: jest.fn(),
    registerTaskAsync: jest.fn(),
    unregisterTaskAsync: jest.fn(),
  }));

  jest.doMock('@rebel/cloud-client', () => ({
    __esModule: true,
    useAuthStore: {
      getState: (...args: unknown[]) => mockUseAuthStoreGetState(...args),
    },
    createLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
    }),
  }));

  jest.doMock('../services/widgetDataSync', () => ({
    __esModule: true,
    deriveWidgetActionItems: (...args: unknown[]) => mockDeriveWidgetActionItems(...args),
    writeToAppGroupDefaults: (...args: unknown[]) => mockWriteToAppGroupDefaults(...args),
    getCurrentWidgetActionItemsCount: (...args: unknown[]) => mockGetCurrentWidgetActionItemsCount(...args),
  }));

  const backgroundFetch = require('expo-background-fetch');
  const widgetBackgroundRefresh = require('../services/widgetBackgroundRefresh');
  const taskCall = defineTask.mock.calls.find(
    ([name]: [string]) => name === widgetBackgroundRefresh.WIDGET_REFRESH_TASK,
  );
  const task = taskCall?.[1] as (() => Promise<number>) | undefined;
  if (!task) {
    throw new Error('Expected widget background refresh task to be defined');
  }

  const authState = {
    loadCredentials: jest.fn().mockResolvedValue(undefined),
    isPaired: true,
    cloudUrl: 'https://cloud.example.test',
    token: 'token-123',
  };
  mockUseAuthStoreGetState.mockImplementation(() => authState);
  mockDeriveWidgetActionItems.mockReturnValue([]);
  mockGetCurrentWidgetActionItemsCount.mockReturnValue(0);

  return {
    backgroundFetch,
    task,
    mockWriteToAppGroupDefaults,
    mockDeriveWidgetActionItems,
    mockGetCurrentWidgetActionItemsCount,
  };
}

describe('widgetBackgroundRefresh (Stage 3 hardening)', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns Failed and does not write when fetch response shape is unexpected', async () => {
    const harness = setupWidgetBackgroundRefreshHarness();
    (global.fetch as unknown as jest.Mock).mockResolvedValue(createResponse({}));

    const result = await harness.task();

    expect(result).toBe(harness.backgroundFetch.BackgroundFetchResult.Failed);
    expect(harness.mockDeriveWidgetActionItems).not.toHaveBeenCalled();
    expect(harness.mockWriteToAppGroupDefaults).not.toHaveBeenCalled();
  });

  it('returns NoData and preserves snapshot on empty result when current widget count is non-empty', async () => {
    const harness = setupWidgetBackgroundRefreshHarness();
    (global.fetch as unknown as jest.Mock).mockResolvedValue(createResponse({ items: [] }));
    harness.mockGetCurrentWidgetActionItemsCount.mockReturnValue(3);

    const result = await harness.task();

    expect(result).toBe(harness.backgroundFetch.BackgroundFetchResult.NoData);
    expect(harness.mockWriteToAppGroupDefaults).not.toHaveBeenCalled();
  });

  it('returns NoData and preserves snapshot when current widget count is unreadable', async () => {
    const harness = setupWidgetBackgroundRefreshHarness();
    (global.fetch as unknown as jest.Mock).mockResolvedValue(createResponse({ items: [] }));
    harness.mockGetCurrentWidgetActionItemsCount.mockReturnValue(null);

    const result = await harness.task();

    expect(result).toBe(harness.backgroundFetch.BackgroundFetchResult.NoData);
    expect(harness.mockWriteToAppGroupDefaults).not.toHaveBeenCalled();
  });

  it('writes an empty array when empty result is genuine (current widget count is zero)', async () => {
    const harness = setupWidgetBackgroundRefreshHarness();
    (global.fetch as unknown as jest.Mock).mockResolvedValue(createResponse({ items: [] }));
    harness.mockGetCurrentWidgetActionItemsCount.mockReturnValue(0);
    harness.mockDeriveWidgetActionItems.mockReturnValue([]);

    const result = await harness.task();

    expect(result).toBe(harness.backgroundFetch.BackgroundFetchResult.NewData);
    expect(harness.mockWriteToAppGroupDefaults).toHaveBeenCalledWith([]);
  });
});
