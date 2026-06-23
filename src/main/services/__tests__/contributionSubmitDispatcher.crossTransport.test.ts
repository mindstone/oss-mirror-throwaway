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
  _resetForTesting as resetSubmitDispatcherForTesting,
} from '../contributionSubmitDispatcher';

describe('submitContribution cross-transport block', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
    resetSubmitDispatcherForTesting();
    vi.clearAllMocks();
  });

  it('returns DUPLICATE immediately for github mode when relayContributionId and prUrl are both present', async () => {
    const contribution = createContribution({
      sessionId: 'session-cross-transport-1',
      connectorName: 'my-connector',
      status: 'draft',
      attributionMode: 'github',
      localServerPath: '/tmp/my-connector',
    });

    updateContribution(contribution.id, {
      relayContributionId: 'rel-1',
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/42',
    });

    const result = await submitContribution(contribution.id);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DUPLICATE');
      expect(result.error.message).toContain('https://github.com/mindstone/mcp-servers/pull/42');
    }
    expect(mockReadConnectorFiles).not.toHaveBeenCalled();
    expect(mockForkRepo).not.toHaveBeenCalled();
    expect(mockPushConnectorFiles).not.toHaveBeenCalled();
    expect(mockCreatePR).not.toHaveBeenCalled();
    expect(mockSubmitViaRelay).not.toHaveBeenCalled();
  });

  it.skip('does not block github mode when relayContributionId exists but prUrl is missing', async () => {
    const contribution = createContribution({
      sessionId: 'session-cross-transport-2',
      connectorName: 'my-connector',
      status: 'draft',
      attributionMode: 'github',
      localServerPath: '/tmp/my-connector',
    });
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, { relayContributionId: 'rel-2' });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    mockForkRepo.mockResolvedValueOnce({
      owner: 'bot-user',
      repo: 'mcp-servers',
      defaultBranch: 'main',
    });
    mockPushConnectorFiles.mockResolvedValueOnce(undefined);
    mockCreatePR.mockResolvedValueOnce({
      kind: 'success',
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/100',
      prNumber: 100,
    });

    const result = await submitContribution(contribution.id);

    expect(result).toEqual({
      success: true,
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/100',
      prNumber: 100,
    });
    expect(mockForkRepo).toHaveBeenCalledOnce();
    expect(mockSubmitViaRelay).not.toHaveBeenCalled();
  });

  it('does not apply the github cross-transport block for rebel-name mode', async () => {
    const contribution = createContribution({
      sessionId: 'session-cross-transport-3',
      connectorName: 'my-connector',
      status: 'draft',
      attributionMode: 'rebel-name',
      attributionName: 'Alex Chen',
      localServerPath: '/tmp/my-connector',
    });
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, {
      relayContributionId: 'rel-3',
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/101',
    });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    mockSubmitViaRelay.mockResolvedValueOnce({
      success: true,
      data: {
        relayContributionId: 'rel-3',
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/101',
        prNumber: 101,
      },
      requestId: 'req-cross-transport-3',
    });

    const result = await submitContribution(contribution.id);

    expect(result).toEqual({
      success: true,
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/101',
      prNumber: 101,
    });
    expect(mockSubmitViaRelay).toHaveBeenCalledOnce();
    expect(mockForkRepo).not.toHaveBeenCalled();
  });
});
