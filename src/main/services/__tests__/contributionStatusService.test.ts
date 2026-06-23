import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContributionRelayExtension } from '@core/services/contributionRelayExtension';
import type { ConnectorContribution } from '@core/services/contributionTypes';

let storeData: Record<string, unknown> = {};

let createContribution: typeof import('@core/services/contributionStore').createContribution;
let getContributionById: typeof import('@core/services/contributionStore').getContributionById;
let updateContribution: typeof import('@core/services/contributionStore').updateContribution;
let resetStore: typeof import('@core/services/contributionStore')._resetStore;
let registerContributionRelayExtension: typeof import('@core/services/contributionRelayExtension').registerContributionRelayExtension;
let refreshContributionStatus: typeof import('../contributionStatusService').refreshContributionStatus;
let resetStatusServiceForTesting: typeof import('../contributionStatusService')._resetForTesting;

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

describe('refreshContributionStatus relay extension seam', () => {
  beforeEach(async () => {
    storeData = {};
    vi.clearAllMocks();
    vi.resetModules();

    const contributionStore = await import('@core/services/contributionStore');
    const contributionRelayExtension = await import('@core/services/contributionRelayExtension');
    const contributionStatusService = await import('../contributionStatusService');

    createContribution = contributionStore.createContribution;
    getContributionById = contributionStore.getContributionById;
    updateContribution = contributionStore.updateContribution;
    resetStore = contributionStore._resetStore;
    registerContributionRelayExtension =
      contributionRelayExtension.registerContributionRelayExtension;
    refreshContributionStatus = contributionStatusService.refreshContributionStatus;
    resetStatusServiceForTesting = contributionStatusService._resetForTesting;

    resetStore();
    resetStatusServiceForTesting();
  });

  afterEach(() => {
    storeData = {};
    vi.resetModules();
  });

  it('returns RELAY_UNAVAILABLE_OSS_BUILD when relay status refresh has no registered extension', async () => {
    const contribution = createContribution({
      sessionId: 'session-status-oss',
      connectorName: 'my-connector',
      status: 'draft',
      attributionMode: 'anonymous',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contribution.id, { status: 'testing' });
    updateContribution(contribution.id, { status: 'ready_to_submit' });
    updateContribution(contribution.id, {
      status: 'submitted',
      relayContributionId: 'rel-oss',
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/42',
    });

    const result = await refreshContributionStatus(contribution.id, { force: true });

    expect(result).toEqual({
      success: false,
      error: 'RELAY_UNAVAILABLE_OSS_BUILD',
      message: 'Contribution sharing through Rebel is not available in this build.',
    });
  });

  it('refreshes through a registered relay extension and stamps published-email confirmation', async () => {
    const contribution = createSubmittedRelayContribution('session-status-enterprise');
    const refreshStatus = vi.fn<ContributionRelayExtension['refreshStatus']>(
      async (relayContributionId) => {
        expect(relayContributionId).toBe('rel-published');
        return {
          success: true,
          data: {
            prState: 'closed',
            merged: true,
            reviews: [],
            checkRuns: [],
            htmlUrl: 'https://github.com/mindstone/mcp-servers/pull/42',
          },
        };
      },
    );
    const notifyPublished = vi.fn<
      NonNullable<ContributionRelayExtension['notifyPublished']>
    >(async (publishedContribution) => {
      expect(publishedContribution.status).toBe('published');
      expect(publishedContribution.publishedEmailSentAt).toBeUndefined();
      return { sent: true };
    });

    registerContributionRelayExtension({
      submit: vi.fn(async () => {
        throw new Error('submit is not used by status refresh');
      }),
      refreshStatus,
      notifyPublished,
    });

    const result = await refreshContributionStatus(contribution.id, { force: true });

    expect(result.success).toBe(true);
    expect(result.contribution?.status).toBe('published');
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(notifyPublished).toHaveBeenCalledTimes(1);

    const stored = getContributionById(contribution.id);
    expect(stored?.status).toBe('published');
    expect(stored?.publishedEmailSentAt).toEqual(expect.any(String));
  });
});

function createSubmittedRelayContribution(sessionId: string): ConnectorContribution {
  const contribution = createContribution({
    sessionId,
    connectorName: 'my-connector',
    status: 'draft',
    attributionMode: 'anonymous',
    localServerPath: '/home/user/my-connector',
  });
  updateContribution(contribution.id, { status: 'testing' });
  updateContribution(contribution.id, { status: 'ready_to_submit' });
  updateContribution(contribution.id, {
    status: 'submitted',
    relayContributionId: 'rel-published',
    prUrl: 'https://github.com/mindstone/mcp-servers/pull/42',
  });
  updateContribution(contribution.id, { status: 'ci_pass' });
  updateContribution(contribution.id, { status: 'approved' });

  const stored = getContributionById(contribution.id);
  if (!stored) {
    throw new Error('Expected contribution to exist after test setup');
  }
  return stored;
}
