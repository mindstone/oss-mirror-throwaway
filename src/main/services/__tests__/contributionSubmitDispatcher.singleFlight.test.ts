import { beforeEach, describe, expect, it, vi } from 'vitest';

let storeData: Record<string, unknown> = {};

 
vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) { return storeData[key]; },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrObj === 'string') {
        storeData[keyOrObj] = value;
      } else {
        Object.assign(storeData, keyOrObj);
      }
    },
    has(key: string) { return key in storeData; },
    delete(key: string) { delete storeData[key]; },
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/path',
  })),
}));

const mockForkRepo = vi.fn();
const mockPushConnectorFiles = vi.fn();
const mockCreatePR = vi.fn();

 
vi.mock('../contributionGitHubService', () => {
  class GitHubReAuthRequiredError extends Error {
    constructor(message?: string) {
      super(message ?? 'Re-auth required');
      this.name = 'GitHubReAuthRequiredError';
    }
  }
  return {
    forkRepo: (...args: unknown[]) => mockForkRepo(...args),
    pushConnectorFiles: (...args: unknown[]) => mockPushConnectorFiles(...args),
    createPR: (...args: unknown[]) => mockCreatePR(...args),
    deriveSubmissionBranch: (contribution: { connectorName: string; id: string }) => {
      const shortId = contribution.id.split('-').at(-1) ?? contribution.id;
      return `contribution/${contribution.connectorName}-${shortId}`;
    },
    GitHubReAuthRequiredError,
  };
});

const mockSubmitViaRelay = vi.fn();
const mockRelayExtensionSubmit = vi.fn(async (request: {
  contribution: {
    id: string;
    connectorName: string;
    attributionMode: 'rebel-name' | 'anonymous';
    attributionName?: string;
  };
  files: Array<{ path: string; content: string }>;
  beforeSubmit?: (body: unknown) => void | Promise<void>;
}) => {
  const requestBody = {
    clientContributionId: request.contribution.id,
    connectorName: request.contribution.connectorName,
    attributionMode: request.contribution.attributionMode,
    ...(request.contribution.attributionMode === 'rebel-name' && request.contribution.attributionName
      ? { attributionName: request.contribution.attributionName }
      : {}),
    prTitle: `feat(${request.contribution.connectorName}): add connector`,
    prBody: JSON.stringify({ files: request.files }),
    files: request.files,
  };
  await request.beforeSubmit?.(requestBody);
  const response = await mockSubmitViaRelay(request.contribution, request.files, { requestBody });
  return { requestBody, response };
});
const mockRelayExtension = {
  submit: mockRelayExtensionSubmit,
  refreshStatus: vi.fn(),
};
const mockGetContributionRelayExtension = vi.fn(() => mockRelayExtension);

 
vi.mock('@core/services/contributionRelayExtension', () => {
  return {
    getContributionRelayExtension: () => mockGetContributionRelayExtension(),
  };
});

const mockReadConnectorFiles = vi.fn();

 
vi.mock('../contributionFileReader', () => {
  class ContributionFileReadError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'ContributionFileReadError';
      this.code = code;
    }
  }
  return {
    readConnectorFilesForSubmission: (...args: unknown[]) =>
      mockReadConnectorFiles(...args),
    ContributionFileReadError,
  };
});

import {
  createContribution,
  updateContribution,
  _resetStore,
} from '@core/services/contributionStore';
import {
  submitContribution,
  _getInFlightSubmissionCountForTesting,
  _resetForTesting as resetSubmitDispatcherForTesting,
} from '../contributionSubmitDispatcher';

describe('submitContribution single-flight', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
    resetSubmitDispatcherForTesting();
    vi.clearAllMocks();
  });

  it('serializes concurrent submitContribution calls per contributionId', async () => {
    const contribution = createContribution({
      sessionId: 'session-single-flight',
      connectorName: 'my-connector',
      status: 'draft',
      attributionMode: 'anonymous',
      localServerPath: '/tmp/my-connector',
    });
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });

    let resolveRelay:
      | ((value: {
        success: true;
        data: { relayContributionId: string; prUrl: string; prNumber: number };
        requestId: string;
      }) => void)
      | undefined;
    const relayPromise = new Promise<{
      success: true;
      data: { relayContributionId: string; prUrl: string; prNumber: number };
      requestId: string;
    }>((resolve) => {
      resolveRelay = resolve;
    });
    mockSubmitViaRelay.mockReturnValueOnce(relayPromise);

    const first = submitContribution(contribution.id);
    const second = submitContribution(contribution.id);

    // submitContributionInner awaits collectBuildContext() before
    // readConnectorFilesForSubmission, which transitively awaits a dynamic
    // `import('../tracking')`, an incremental-session-store read, AND a real
    // `fs.readFile` for the build plan. None of those are mocked here, so the
    // dispatcher needs an unpredictable amount of real wall-clock time to
    // progress from submit() entry to the relay call. Polling for the
    // steady-state signal (relay called exactly once) is robust to CPU
    // contention; a fixed setTimeout(50) flakes when the suite is loaded.
    //
    // This still proves single-flight: if both submit() paths went through,
    // mockSubmitViaRelay.mockReturnValueOnce(pendingRelayPromise) is
    // configured for ONE call only — the second call would receive undefined,
    // fail, and the count assertion below would catch any later second call.
    await vi.waitFor(
      () => {
        expect(mockSubmitViaRelay).toHaveBeenCalledTimes(1);
      },
      { timeout: 5000, interval: 10 },
    );

    expect(_getInFlightSubmissionCountForTesting()).toBe(1);
    expect(mockReadConnectorFiles).toHaveBeenCalledTimes(1);
    expect(mockSubmitViaRelay).toHaveBeenCalledTimes(1);

    resolveRelay?.({
      success: true,
      data: {
        relayContributionId: 'rel-single-flight',
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/500',
        prNumber: 500,
      },
      requestId: 'req-single-flight',
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toEqual({
      success: true,
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/500',
      prNumber: 500,
    });
    expect(_getInFlightSubmissionCountForTesting()).toBe(0);
  });
});
