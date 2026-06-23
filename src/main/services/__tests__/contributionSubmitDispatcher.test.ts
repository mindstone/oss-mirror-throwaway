/**
 * Tests for contributionSubmitDispatcher.ts
 *
 * Covers the two routing branches and the key invariants from the
 * Stage 2 plan:
 *   - attributionMode === 'github'  → GitHub path (fork/push/PR), no relay call
 *   - attributionMode === 'rebel-name' / 'anonymous' → relay call, no GitHub fetch
 *   - Relay success persists `relayContributionId` on the record
 *   - Missing contribution id returns NOT_FOUND
 *   - Missing localServerPath returns VALIDATION
 *   - Re-auth error bubbles up as `reAuthRequired: true`
 *   - Relay failure body is lifted through as a typed failure
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── In-memory store mock ───────────────────────────────────────────

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

// ─── Mock GitHub submission primitives ──────────────────────────────

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

// Stage 2 review (260427) — tester gpt-5.5 asked for a regression guard on
// the silent-failure rule (AGENTS.md): the GitHub-direct degraded branches
// MUST log via `log.error` BEFORE returning the success envelope. Without
// this guard, a future agent could remove the log line and we'd lose the
// observability surface for post-side-effect persistence failures.
//
// Approach: replace `createScopedLogger` with a spy factory; the
// `loggerSpies` map is keyed by `service` so tests assert against the
// dispatcher's logger specifically. Use `vi.hoisted` so the factory and
// the spies map are initialized BEFORE `vi.mock` runs (vi.mock is hoisted
// to the top of the file).
const loggerHoisted = vi.hoisted(() => {
  const loggerSpies: Record<string, {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  }> = {};
  return { loggerSpies };
});
const loggerSpies = loggerHoisted.loggerSpies;

 
vi.mock('@core/logger', async () => {
  const actual = await vi.importActual<typeof import('@core/logger')>('@core/logger');
  return {
    ...actual,
    createScopedLogger: ({ service }: { service: string }) => {
      const spy = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      loggerHoisted.loggerSpies[service] = spy;
      return spy;
    },
  };
});

// ─── Mock relay extension ───────────────────────────────────────────
//
// The private extension owns build+HTTP in production. Tests keep a fake
// extension registered by default and route its HTTP leg through the old
// `mockSubmitViaRelay` spy so existing transport assertions stay focused.

const mockSubmitViaRelay = vi.fn();
const mockRelayExtensionSubmit = vi.fn(async (request: {
  contribution: {
    id: string;
    connectorName: string;
    attributionMode: 'rebel-name' | 'anonymous';
    attributionName?: string;
    summary?: string;
    motivation?: string;
    reviewerNotes?: string;
    prTitle?: string;
    prBody?: string;
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
    prTitle: request.contribution.prTitle ?? `feat(${request.contribution.connectorName}): add connector`,
    prBody: request.contribution.prBody ?? JSON.stringify({
      summary: request.contribution.summary,
      motivation: request.contribution.motivation,
      reviewerNotes: request.contribution.reviewerNotes,
      files: request.files,
    }),
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
const mockGetContributionRelayExtension = vi.fn<() => typeof mockRelayExtension | null>(
  () => mockRelayExtension,
);

 
vi.mock('@core/services/contributionRelayExtension', () => {
  return {
    getContributionRelayExtension: () => mockGetContributionRelayExtension(),
  };
});

// ─── Mock file reader ───────────────────────────────────────────────

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

// Import after mocks
import {
  createContribution,
  getContributionById,
  updateContribution,
  _resetStore,
} from '@core/services/contributionStore';
import { computePayloadFingerprintExcludingAppendix } from '@core/services/contributionPrFormatter';
import * as contributionStore from '@core/services/contributionStore';
import {
  resolveDuplicate,
  submitContribution,
  _resetForTesting as resetSubmitDispatcherForTesting,
} from '../contributionSubmitDispatcher';

// ─── Helpers ────────────────────────────────────────────────────────

type AttributionMode = 'github' | 'rebel-name' | 'anonymous';

function makeContrib(
  overrides: Partial<{
    connectorName: string;
    attributionMode: AttributionMode;
    attributionName?: string;
    localServerPath: string;
    status: 'draft' | 'testing' | 'ready_to_submit';
  }> = {},
) {
  const contrib = createContribution({
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    connectorName: overrides.connectorName ?? 'my-connector',
    status: overrides.status ?? 'draft',
    attributionMode: overrides.attributionMode ?? 'anonymous',
    ...(overrides.attributionName !== undefined
      ? { attributionName: overrides.attributionName }
      : overrides.attributionMode === 'rebel-name'
        ? { attributionName: 'Alex Chen' }
        : {}),
    ...(overrides.localServerPath !== undefined
      ? { localServerPath: overrides.localServerPath }
      : { localServerPath: '/home/user/my-connector' }),
  });
  return contrib;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('submitContribution', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
    resetSubmitDispatcherForTesting();
    vi.clearAllMocks();
  });

  it('returns NOT_FOUND for an unknown contribution id', async () => {
    const result = await submitContribution('missing');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  // Skipped by OSS scrub: GitHub contribution submission path is disabled in this build
  // (see submitViaGitHub in contributionSubmitDispatcher.ts). These tests cover the
  // old behavior and will be re-enabled if/when the GitHub path is re-introduced.
  describe.skip('github branch', () => {
    it('forks, pushes, creates PR, and persists the submitted status', async () => {
      const contrib = makeContrib({
        attributionMode: 'github',
        connectorName: 'my-connector',
        localServerPath: '/home/user/my-connector',
      });
      // Transition to ready_to_submit so the `submitted` transition is valid.
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

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
        prUrl: 'https://github.com/org/repo/pull/42',
        prNumber: 42,
      });

      const result = await submitContribution(contrib.id);

      expect(result).toEqual({
        success: true,
        prUrl: 'https://github.com/org/repo/pull/42',
        prNumber: 42,
      });
      expect(mockSubmitViaRelay).not.toHaveBeenCalled();

      const refreshed = getContributionById(contrib.id);
      expect(refreshed?.status).toBe('submitted');
      expect(refreshed?.prUrl).toBe('https://github.com/org/repo/pull/42');
      expect(refreshed?.attributionMode).toBe('github');
      expect(refreshed?.attributionName).toBe('bot-user');
    });

    it('returns degraded success when GitHub post-PR persistence throws', async () => {
      const contrib = makeContrib({
        attributionMode: 'github',
        connectorName: 'my-connector',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

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
        prUrl: 'https://github.com/org/repo/pull/142',
        prNumber: 142,
      });
      const updateSpy = vi
        .spyOn(contributionStore, 'updateContribution')
        .mockImplementationOnce(() => {
          throw new Error('disk write failed after PR creation');
        });

      const result = await submitContribution(contrib.id);

      expect(result).toEqual({
        success: true,
        prUrl: 'https://github.com/org/repo/pull/142',
        prNumber: 142,
        degraded: 'persistence-failed',
      });
      // Silent-failure regression guard: log.error MUST be called before the
      // success-with-degraded envelope is returned. Pino arg-order: object
      // first, message second.
      const logSpy = loggerSpies['contribution-submit-dispatcher'];
      expect(logSpy?.error).toHaveBeenCalled();
      const errorCall = logSpy.error.mock.calls.find(
        (call) => call[1] === 'Failed to persist GitHub submit result',
      );
      expect(errorCall, 'expected log.error("Failed to persist GitHub submit result")').toBeTruthy();
      expect(errorCall?.[0]).toMatchObject({
        contributionId: contrib.id,
        prUrl: 'https://github.com/org/repo/pull/142',
        prNumber: 142,
      });
      // Pino object MUST include the underlying error for diagnosability.
      expect((errorCall?.[0] as { err?: unknown }).err).toBeInstanceOf(Error);
      updateSpy.mockRestore();
    });

    it('returns degraded success when GitHub post-PR persistence finds a deleted record', async () => {
      const contrib = makeContrib({
        attributionMode: 'github',
        connectorName: 'my-connector',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

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
        prUrl: 'https://github.com/org/repo/pull/143',
        prNumber: 143,
      });
      const updateSpy = vi
        .spyOn(contributionStore, 'updateContribution')
        .mockImplementationOnce(() => undefined);

      const result = await submitContribution(contrib.id);

      expect(result).toEqual({
        success: true,
        prUrl: 'https://github.com/org/repo/pull/143',
        prNumber: 143,
        degraded: 'record-deleted',
      });
      // Silent-failure regression guard for the record-deleted branch.
      const logSpy = loggerSpies['contribution-submit-dispatcher'];
      expect(logSpy?.error).toHaveBeenCalled();
      const errorCall = logSpy.error.mock.calls.find(
        (call) =>
          call[1] ===
          'Failed to persist GitHub submit result: contribution missing after PR creation',
      );
      expect(errorCall, 'expected log.error for record-missing branch').toBeTruthy();
      expect(errorCall?.[0]).toMatchObject({
        contributionId: contrib.id,
        prUrl: 'https://github.com/org/repo/pull/143',
        prNumber: 143,
      });
      updateSpy.mockRestore();
    });

    it('deduplicates concurrent submit calls for the same contribution id', async () => {
      const contrib = makeContrib({
        attributionMode: 'github',
        connectorName: 'my-connector',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

      mockReadConnectorFiles.mockResolvedValueOnce({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockForkRepo.mockResolvedValueOnce({
        owner: 'bot-user',
        repo: 'mcp-servers',
        defaultBranch: 'main',
      });
      mockPushConnectorFiles.mockResolvedValue(undefined);
      mockCreatePR.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                kind: 'success',
                prUrl: 'https://github.com/org/repo/pull/777',
                prNumber: 777,
              });
            }, 20);
          }),
      );

      const firstSubmit = submitContribution(contrib.id);
      const secondSubmit = submitContribution(contrib.id);

      const [firstResult, secondResult] = await Promise.all([firstSubmit, secondSubmit]);
      expect(firstResult).toEqual(secondResult);
      expect(firstResult).toEqual({
        success: true,
        prUrl: 'https://github.com/org/repo/pull/777',
        prNumber: 777,
      });
      expect(mockReadConnectorFiles).toHaveBeenCalledTimes(1);
      expect(mockForkRepo).toHaveBeenCalledTimes(1);
      expect(mockPushConnectorFiles).toHaveBeenCalledTimes(1);
      expect(mockCreatePR).toHaveBeenCalledTimes(1);
    });

    it('returns VALIDATION when localServerPath is missing', async () => {
      const contrib = makeContrib({
        attributionMode: 'github',
        localServerPath: '',
      });
      // Manually clear the path (the default helper would set it) by creating
      // with an explicit empty string, then patching the store record.
      storeData.contributions = (storeData.contributions as unknown[]).map((c) => ({
        ...(c as Record<string, unknown>),
        localServerPath: undefined,
      }));

      const result = await submitContribution(contrib.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('VALIDATION');
        expect(result.error.message).toMatch(/local server path/i);
      }
      expect(mockForkRepo).not.toHaveBeenCalled();
    });

    it('surfaces re-auth required errors as reAuthRequired:true', async () => {
      const contrib = makeContrib({
        attributionMode: 'github',
        localServerPath: '/home/user/my-connector',
      });

      mockReadConnectorFiles.mockResolvedValueOnce({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      const { GitHubReAuthRequiredError } = await import('../contributionGitHubService');
      mockForkRepo.mockRejectedValueOnce(new GitHubReAuthRequiredError('Token expired'));

      const result = await submitContribution(contrib.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.reAuthRequired).toBe(true);
      }
    });

    it('retries push+createPR when createPR reports fresh-ref-not-yet-visible', async () => {
      const contrib = makeContrib({
        attributionMode: 'github',
        connectorName: 'my-connector',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

      mockReadConnectorFiles.mockResolvedValueOnce({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockForkRepo.mockResolvedValueOnce({
        owner: 'bot-user',
        repo: 'mcp-servers',
        defaultBranch: 'main',
      });
      mockPushConnectorFiles.mockResolvedValue(undefined);
      mockCreatePR
        .mockResolvedValueOnce({
          kind: 'fresh-ref-not-yet-visible',
          // synthesized for unit coverage; real fixture validation tracked in planning doc
          body: {
            message: 'Validation Failed',
            errors: [{ field: 'head', code: 'invalid', message: 'head does not exist' }],
          },
        })
        .mockResolvedValueOnce({
          kind: 'success',
          prUrl: 'https://github.com/org/repo/pull/84',
          prNumber: 84,
        });

      const result = await submitContribution(contrib.id);

      expect(mockPushConnectorFiles).toHaveBeenCalledTimes(2);
      expect(mockCreatePR).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        success: true,
        prUrl: 'https://github.com/org/repo/pull/84',
        prNumber: 84,
      });
    });

    // Stage 1 review (260427) — tester gpt-5.5 surfaced these gaps.
    // Coverage for: createPR returns unknown-422 → dispatcher MUST fail-closed
    // (typed INTERNAL failure, no silent fall-through). Contract test for the
    // throw at submitViaGitHub's retry-loop tail.
    it('fails closed (typed INTERNAL) when createPR returns unknown-422', async () => {
      const contrib = makeContrib({
        attributionMode: 'github',
        connectorName: 'my-connector',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

      mockReadConnectorFiles.mockResolvedValueOnce({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockForkRepo.mockResolvedValueOnce({
        owner: 'bot-user',
        repo: 'mcp-servers',
        defaultBranch: 'main',
      });
      mockPushConnectorFiles.mockResolvedValue(undefined);
      mockCreatePR.mockResolvedValueOnce({
        kind: 'unknown-422',
        body: {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', code: 'something_unrecognised' }],
        },
      });

      const result = await submitContribution(contrib.id);

      // unknown-422 must surface as a typed failure, NOT silent success.
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INTERNAL');
        expect(result.error.message).toMatch(/422/i);
      }
      // Single attempt — unknown-422 does NOT retry.
      expect(mockPushConnectorFiles).toHaveBeenCalledTimes(1);
      expect(mockCreatePR).toHaveBeenCalledTimes(1);
    });

    // Coverage for: pushConnectorFiles fails on the retry attempt (after first
    // createPR returned fresh-ref-not-yet-visible). Behaviour: failure must
    // propagate to the outer try/catch and surface as a typed INTERNAL failure;
    // no silent retry-storm.
    it('surfaces typed INTERNAL failure when pushConnectorFiles fails on retry', async () => {
      const contrib = makeContrib({
        attributionMode: 'github',
        connectorName: 'my-connector',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

      mockReadConnectorFiles.mockResolvedValueOnce({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockForkRepo.mockResolvedValueOnce({
        owner: 'bot-user',
        repo: 'mcp-servers',
        defaultBranch: 'main',
      });
      // First push succeeds; first createPR returns fresh-ref-not-yet-visible
      // (caller will retry); second push throws.
      mockPushConnectorFiles
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('GitHub push refused: ref pinned by another branch'));
      mockCreatePR.mockResolvedValueOnce({
        kind: 'fresh-ref-not-yet-visible',
        body: {
          message: 'Validation Failed',
          errors: [{ field: 'head', code: 'invalid', message: 'head does not exist' }],
        },
      });

      const result = await submitContribution(contrib.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INTERNAL');
        expect(result.error.message).toContain('GitHub push refused');
      }
      expect(mockPushConnectorFiles).toHaveBeenCalledTimes(2);
      expect(mockCreatePR).toHaveBeenCalledTimes(1);
    });
  });

  describe('relay branch', () => {
    it('returns RELAY_UNAVAILABLE_OSS_BUILD when no private relay extension is registered', async () => {
      const contrib = makeContrib({
        attributionMode: 'anonymous',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });
      mockGetContributionRelayExtension.mockReturnValueOnce(null);

      const result = await submitContribution(contrib.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RELAY_UNAVAILABLE_OSS_BUILD');
        expect(result.error.message).toBe('Contribution sharing through Rebel is not available in this build.');
      }
      expect(mockReadConnectorFiles).not.toHaveBeenCalled();
      expect(mockSubmitViaRelay).not.toHaveBeenCalled();
    });

    it('calls the relay, persists relayContributionId, and returns success', async () => {
      const contrib = makeContrib({
        attributionMode: 'rebel-name',
        attributionName: 'Alex Chen',
        connectorName: 'my-connector',
        localServerPath: '/home/user/my-connector',
      });
      // Transition to ready_to_submit so `submitted` is valid.
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

      mockReadConnectorFiles.mockResolvedValueOnce({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockSubmitViaRelay.mockResolvedValueOnce({
        success: true,
        data: {
          relayContributionId: 'rel-xyz',
          prUrl: 'https://github.com/mindstone/mcp-servers/pull/88',
          prNumber: 88,
        },
        requestId: 'req-dispatch-1',
      });

      const result = await submitContribution(contrib.id);

      expect(result).toEqual({
        success: true,
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/88',
        prNumber: 88,
      });
      expect(mockForkRepo).not.toHaveBeenCalled();
      expect(mockSubmitViaRelay).toHaveBeenCalledOnce();

      const refreshed = getContributionById(contrib.id);
      expect(refreshed?.status).toBe('submitted');
      expect(refreshed?.relayContributionId).toBe('rel-xyz');
      expect(refreshed?.prUrl).toBe('https://github.com/mindstone/mcp-servers/pull/88');
      // Attribution mode must be preserved (relay doesn't force github).
      expect(refreshed?.attributionMode).toBe('rebel-name');
    });

    it('lifts a relay failure body through as a typed dispatcher failure', async () => {
      const contrib = makeContrib({
        attributionMode: 'anonymous',
        localServerPath: '/home/user/my-connector',
      });

      mockReadConnectorFiles.mockResolvedValueOnce({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockSubmitViaRelay.mockResolvedValueOnce({
        success: false,
        error: { code: 'RATE_LIMIT', message: 'Slow down, friend.' },
      });

      const result = await submitContribution(contrib.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('RATE_LIMIT');
        expect(result.error.message).toBe('Slow down, friend.');
      }

      // No relay id should have been written because relay didn't succeed.
      const refreshed = getContributionById(contrib.id);
      expect(refreshed?.relayContributionId).toBeUndefined();
    });

    it('matrix #8 end-to-end: same relay-id + same content duplicate is idempotent success', async () => {
      const contrib = makeContrib({
        attributionMode: 'anonymous',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

      mockReadConnectorFiles.mockResolvedValue({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockSubmitViaRelay
        .mockResolvedValueOnce({
          success: true,
          data: {
            relayContributionId: 'rel-existing',
            prUrl: 'https://github.com/mindstone/mcp-servers/pull/88',
            prNumber: 88,
          },
          requestId: 'req-matrix-8-initial',
        })
        .mockResolvedValueOnce({
          success: false,
          error: {
            code: 'DUPLICATE',
            message: 'already submitted',
            details: {
              relayContributionId: 'rel-existing',
              prUrl: 'https://github.com/mindstone/mcp-servers/pull/88',
              prNumber: 88,
            },
          },
        });

      const firstResult = await submitContribution(contrib.id);
      expect(firstResult).toEqual({
        success: true,
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/88',
        prNumber: 88,
      });
      const afterFirst = getContributionById(contrib.id) as
        | (ReturnType<typeof getContributionById> & { lastSubmittedFingerprintExcludingAppendix?: string })
        | undefined;
      expect(typeof afterFirst?.lastSubmittedFingerprintExcludingAppendix).toBe('string');
      const firstFingerprint = afterFirst?.lastSubmittedFingerprintExcludingAppendix;

      const result = await submitContribution(contrib.id);

      expect(result).toEqual({
        success: true,
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/88',
        prNumber: 88,
        duplicate: true,
      });
      const refreshed = getContributionById(contrib.id) as
        | (ReturnType<typeof getContributionById> & { lastSubmittedFingerprintExcludingAppendix?: string })
        | undefined;
      expect(refreshed?.status).toBe('submitted');
      expect(refreshed?.relayContributionId).toBe('rel-existing');
      expect(refreshed?.lastSubmittedFingerprintExcludingAppendix).toBe(firstFingerprint);
    });

    it('matrix #9 end-to-end: changed content with reused relay-id is rejected as DUPLICATE real_error', async () => {
      const contrib = makeContrib({
        attributionMode: 'anonymous',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });
      updateContribution(contrib.id, { summary: 'Original summary' });

      mockReadConnectorFiles.mockResolvedValue({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockSubmitViaRelay
        .mockResolvedValueOnce({
          success: true,
          data: {
            relayContributionId: 'rel-prior',
            prUrl: 'https://github.com/mindstone/mcp-servers/pull/189',
            prNumber: 189,
          },
          requestId: 'req-matrix-9-initial',
        })
        .mockResolvedValueOnce({
          success: false,
          error: {
            code: 'DUPLICATE',
            message: 'already submitted',
            details: {
              relayContributionId: 'rel-prior',
              prUrl: 'https://github.com/mindstone/mcp-servers/pull/189',
              prNumber: 189,
            },
          },
        });

      const firstSubmit = await submitContribution(contrib.id);
      expect(firstSubmit.success).toBe(true);
      const fingerprintAfterFirstSubmit = (
        getContributionById(contrib.id) as
          | (ReturnType<typeof getContributionById> & { lastSubmittedFingerprintExcludingAppendix?: string })
          | undefined
      )?.lastSubmittedFingerprintExcludingAppendix;
      expect(typeof fingerprintAfterFirstSubmit).toBe('string');

      updateContribution(contrib.id, { summary: 'Updated summary with changed content' });
      const result = await submitContribution(contrib.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DUPLICATE');
        expect(result.error.message).toContain('changed');
        expect(result.error.message).toContain('fresh submission');
      }

      const refreshed = getContributionById(contrib.id) as
        | (ReturnType<typeof getContributionById> & { lastSubmittedFingerprintExcludingAppendix?: string })
        | undefined;
      expect(refreshed?.relayContributionId).toBe('rel-prior');
      expect(typeof refreshed?.lastSubmittedFingerprintExcludingAppendix).toBe('string');
      expect(refreshed?.lastSubmittedFingerprintExcludingAppendix).not.toBe(fingerprintAfterFirstSubmit);
    });

    it('matrix #10 end-to-end: different relay-id duplicate is rejected as cross-contribution collision', async () => {
      const contrib = makeContrib({
        attributionMode: 'anonymous',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

      mockReadConnectorFiles.mockResolvedValue({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockSubmitViaRelay
        .mockResolvedValueOnce({
          success: true,
          data: {
            relayContributionId: 'rel-local',
            prUrl: 'https://github.com/mindstone/mcp-servers/pull/190',
            prNumber: 190,
          },
          requestId: 'req-matrix-10-initial',
        })
        .mockResolvedValueOnce({
          success: false,
          error: {
            code: 'DUPLICATE',
            message: 'already submitted',
            details: {
              relayContributionId: 'rel-other',
              prUrl: 'https://github.com/mindstone/mcp-servers/pull/190',
              prNumber: 190,
            },
          },
        });

      const firstSubmit = await submitContribution(contrib.id);
      expect(firstSubmit.success).toBe(true);

      const result = await submitContribution(contrib.id);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DUPLICATE');
        expect(result.error.message).toContain('different contribution');
      }
    });

    it('returns degraded success when updateContribution throws', async () => {
      const contrib = makeContrib({
        attributionMode: 'rebel-name',
        attributionName: 'Alex Chen',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

      mockReadConnectorFiles.mockResolvedValueOnce({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockSubmitViaRelay.mockResolvedValueOnce({
        success: true,
        data: {
          relayContributionId: 'rel-throw',
          prUrl: 'https://github.com/mindstone/mcp-servers/pull/101',
          prNumber: 101,
        },
        requestId: 'req-dispatch-throw',
      });
      const originalUpdateContribution = contributionStore.updateContribution;
      const updateSpy = vi
        .spyOn(contributionStore, 'updateContribution')
        .mockImplementationOnce((id, updates) => originalUpdateContribution(id, updates))
        .mockImplementationOnce(() => {
          throw new Error('disk full');
        });

      const result = await submitContribution(contrib.id);

      expect(result).toEqual({
        success: true,
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/101',
        prNumber: 101,
        degraded: 'persistence-failed',
      });
      updateSpy.mockRestore();
    });

    it('returns degraded success when record was deleted before persistence', async () => {
      const contrib = makeContrib({
        attributionMode: 'anonymous',
        localServerPath: '/home/user/my-connector',
      });
      updateContribution(contrib.id, { status: 'testing' });
      updateContribution(contrib.id, { status: 'ready_to_submit' });

      mockReadConnectorFiles.mockResolvedValueOnce({
        files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
        skippedDenylisted: [],
      });
      mockSubmitViaRelay.mockResolvedValueOnce({
        success: true,
        data: {
          relayContributionId: 'rel-missing',
          prUrl: 'https://github.com/mindstone/mcp-servers/pull/202',
          prNumber: 202,
        },
        requestId: 'req-dispatch-missing',
      });
      const originalUpdateContribution = contributionStore.updateContribution;
      const updateSpy = vi
        .spyOn(contributionStore, 'updateContribution')
        .mockImplementationOnce((id, updates) => originalUpdateContribution(id, updates))
        .mockImplementationOnce(() => undefined);

      const result = await submitContribution(contrib.id);

      expect(result).toEqual({
        success: true,
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/202',
        prNumber: 202,
        degraded: 'record-deleted',
      });
      updateSpy.mockRestore();
    });
  });
});

describe('resolveDuplicate matrix (Stage 1 v5.1)', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
    resetSubmitDispatcherForTesting();
    vi.clearAllMocks();
  });

  const payloadWithBody = (body: string) => ({
    clientContributionId: 'contrib-dup',
    connectorName: 'my-connector',
    attributionMode: 'anonymous',
    prTitle: 'feat(connector): add my-connector',
    prBody: body,
    files: [{ path: 'connectors/my-connector/src/index.ts', content: 'export const x = 1;' }],
  });
  const buildContextSuffix =
    '\n\n---\n**Build Context** (auto-generated provenance)\n- App-Workflow: direct';

  it('#8 same contribution + same fingerprint => idempotent_success', () => {
    const contribution = makeContrib({ attributionMode: 'anonymous' });
    updateContribution(contribution.id, { relayContributionId: 'rel-8' });
    const payload = payloadWithBody(`## Summary\nStable${buildContextSuffix}`);
    updateContribution(contribution.id, {
      lastSubmittedFingerprintExcludingAppendix: computePayloadFingerprintExcludingAppendix(payload),
    } as Parameters<typeof updateContribution>[1]);

    const refreshed = getContributionById(contribution.id)!;
    expect(
      resolveDuplicate(
        { relayContributionId: 'rel-8' },
        refreshed,
        payload,
      ),
    ).toEqual({ kind: 'idempotent_success' });
  });

  it('#9 matching relay-id + fingerprint mismatch => content_changed_but_id_reused', () => {
    const contribution = makeContrib({ attributionMode: 'anonymous' });
    updateContribution(contribution.id, { relayContributionId: 'rel-9' });
    const previousPayload = payloadWithBody(`## Summary\nOld${buildContextSuffix}`);
    updateContribution(contribution.id, {
      lastSubmittedFingerprintExcludingAppendix: computePayloadFingerprintExcludingAppendix(previousPayload),
    } as Parameters<typeof updateContribution>[1]);

    const currentPayload = payloadWithBody(`## Summary\nNew content${buildContextSuffix}`);
    const refreshed = getContributionById(contribution.id)!;
    expect(
      resolveDuplicate(
        { relayContributionId: 'rel-9' },
        refreshed,
        currentPayload,
      ),
    ).toEqual({
      kind: 'real_error',
      reason: 'content_changed_but_id_reused',
    });
  });

  it('#10 stored relay-id present + different response relay-id => cross_contribution_id_collision', () => {
    const contribution = makeContrib({ attributionMode: 'anonymous' });
    updateContribution(contribution.id, {
      relayContributionId: 'rel-local',
      lastSubmittedFingerprintExcludingAppendix: 'fingerprint',
    } as Parameters<typeof updateContribution>[1]);

    const refreshed = getContributionById(contribution.id)!;
    expect(
      resolveDuplicate(
        { relayContributionId: 'rel-other' },
        refreshed,
        payloadWithBody(`## Summary\nStable${buildContextSuffix}`),
      ),
    ).toEqual({
      kind: 'real_error',
      reason: 'cross_contribution_id_collision',
    });
  });

  it('#11 stored relay-id absent + fingerprint match => idempotent_success', () => {
    const contribution = makeContrib({ attributionMode: 'anonymous' });
    const payload = payloadWithBody(`## Summary\nStable${buildContextSuffix}`);
    updateContribution(contribution.id, {
      lastSubmittedFingerprintExcludingAppendix: computePayloadFingerprintExcludingAppendix(payload),
    } as Parameters<typeof updateContribution>[1]);

    const refreshed = getContributionById(contribution.id)!;
    expect(
      resolveDuplicate(
        { relayContributionId: 'rel-11' },
        refreshed,
        payload,
      ),
    ).toEqual({ kind: 'idempotent_success' });
  });
});

describe('submitContribution duplicate first-submit retry observability', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
    resetSubmitDispatcherForTesting();
    vi.clearAllMocks();
  });

  it('logs warn for fingerprint-only first-submit retry idempotent match', async () => {
    const contrib = makeContrib({
      attributionMode: 'anonymous',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });

    mockReadConnectorFiles.mockResolvedValue({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    mockSubmitViaRelay
      .mockResolvedValueOnce({
        success: false,
        error: {
          code: 'RATE_LIMIT',
          message: 'Slow down, friend.',
        },
      })
      .mockResolvedValueOnce({
        success: false,
        error: {
          code: 'DUPLICATE',
          message: 'already submitted',
          details: {
            relayContributionId: 'rel-first-retry',
            prUrl: 'https://github.com/mindstone/mcp-servers/pull/404',
            prNumber: 404,
          },
        },
      });

    const firstAttempt = await submitContribution(contrib.id);
    expect(firstAttempt.success).toBe(false);
    if (!firstAttempt.success) {
      expect(firstAttempt.error.code).toBe('RATE_LIMIT');
    }
    const afterFirstAttempt = getContributionById(contrib.id) as
      | (ReturnType<typeof getContributionById> & { lastSubmittedFingerprintExcludingAppendix?: string })
      | undefined;
    expect(afterFirstAttempt?.relayContributionId).toBeUndefined();
    expect(typeof afterFirstAttempt?.lastSubmittedFingerprintExcludingAppendix).toBe('string');

    const result = await submitContribution(contrib.id);
    expect(result).toEqual({
      success: true,
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/404',
      prNumber: 404,
      duplicate: true,
    });

    const logSpy = loggerSpies['contribution-submit-dispatcher'];
    const warnCall = logSpy?.warn.mock.calls.find(
      (call) => call[1] === 'Relay duplicate accepted via fingerprint-only first-submit retry path',
    );
    expect(warnCall).toBeTruthy();
    expect(warnCall?.[0]).toMatchObject({
      contributionId: contrib.id,
      scenario: 'first_submit_retry_fingerprint_match',
      relayContributionId: 'rel-first-retry',
    });

    const refreshed = getContributionById(contrib.id);
    expect(refreshed?.relayContributionId).toBe('rel-first-retry');
  });
});

describe('submitContribution — Stage 3 attribution routing + denylist surfacing', () => {
  beforeEach(() => {
    storeData = {};
    _resetStore();
    resetSubmitDispatcherForTesting();
    vi.clearAllMocks();
  });

  it.skip('routes using effectiveAttributionMode when request overrides stored mode', async () => {
    const contrib = makeContrib({
      attributionMode: 'rebel-name',
      attributionName: 'Alex',
      connectorName: 'my-connector',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });

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
      prUrl: 'https://github.com/org/repo/pull/600',
      prNumber: 600,
    });

    const result = await submitContribution(contrib.id, {
      desiredAttributionMode: 'github',
    });

    expect(result).toEqual({
      success: true,
      prUrl: 'https://github.com/org/repo/pull/600',
      prNumber: 600,
    });
    expect(mockForkRepo).toHaveBeenCalledTimes(1);
    expect(mockSubmitViaRelay).not.toHaveBeenCalled();
  });

  it('applies cross-transport DUPLICATE block using effectiveAttributionMode', async () => {
    const contrib = makeContrib({
      attributionMode: 'rebel-name',
      attributionName: 'Alex',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, {
      relayContributionId: 'rel-existing',
      prUrl: 'https://github.com/mindstone/mcp-servers/pull/42',
    });

    const result = await submitContribution(contrib.id, {
      desiredAttributionMode: 'github',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DUPLICATE');
      expect(result.error.message).toContain('/pull/42');
    }
    expect(mockForkRepo).not.toHaveBeenCalled();
    expect(mockSubmitViaRelay).not.toHaveBeenCalled();
  });

  it.skip('GitHub success preserves byline and clears relayContributionId', async () => {
    const contrib = makeContrib({
      attributionMode: 'rebel-name',
      attributionName: 'Alex',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });
    updateContribution(contrib.id, { relayContributionId: 'rel-old' });

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
      prUrl: 'https://github.com/org/repo/pull/601',
      prNumber: 601,
    });

    await submitContribution(contrib.id, {
      desiredAttributionMode: 'github',
    });

    const refreshed = getContributionById(contrib.id);
    expect(refreshed?.status).toBe('submitted');
    expect(refreshed?.attributionMode).toBe('github');
    expect(refreshed?.attributionName).toBe('bot-user');
    expect(Object.prototype.hasOwnProperty.call(refreshed!, 'relayContributionId')).toBe(false);
  });

  it('relay anonymous success clears attributionName and persists anonymous mode', async () => {
    const contrib = makeContrib({
      attributionMode: 'rebel-name',
      attributionName: 'Alex',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    mockSubmitViaRelay.mockResolvedValueOnce({
      success: true,
      data: {
        relayContributionId: 'rel-anon',
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/602',
        prNumber: 602,
      },
      requestId: 'req-relay-anon',
    });

    await submitContribution(contrib.id, {
      desiredAttributionMode: 'anonymous',
    });

    const refreshed = getContributionById(contrib.id);
    expect(refreshed?.attributionMode).toBe('anonymous');
    expect(Object.prototype.hasOwnProperty.call(refreshed!, 'attributionName')).toBe(false);
    expect(refreshed?.relayContributionId).toBe('rel-anon');
  });

  it('does not mutate attribution fields on recoverable failure', async () => {
    const contrib = makeContrib({
      attributionMode: 'rebel-name',
      attributionName: 'Alex',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });
    updateContribution(contrib.id, { relayContributionId: 'rel-existing' });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    mockSubmitViaRelay.mockResolvedValueOnce({
      success: false,
      error: { code: 'RATE_LIMIT', message: 'Slow down, friend.' },
    });

    const result = await submitContribution(contrib.id, {
      desiredAttributionMode: 'anonymous',
    });

    expect(result.success).toBe(false);
    const refreshed = getContributionById(contrib.id);
    expect(refreshed?.attributionMode).toBe('rebel-name');
    expect(refreshed?.attributionName).toBe('Alex');
    expect(refreshed?.relayContributionId).toBe('rel-existing');
  });

  it.skip('threads skippedDenylisted onto success responses', async () => {
    const contrib = makeContrib({
      attributionMode: 'github',
      connectorName: 'my-connector',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: ['.env', 'credentials.json'],
    });
    mockForkRepo.mockResolvedValueOnce({
      owner: 'bot-user',
      repo: 'mcp-servers',
      defaultBranch: 'main',
    });
    mockPushConnectorFiles.mockResolvedValueOnce(undefined);
    mockCreatePR.mockResolvedValueOnce({
      kind: 'success',
      prUrl: 'https://github.com/org/repo/pull/603',
      prNumber: 603,
    });

    const result = await submitContribution(contrib.id);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skippedDenylisted).toEqual(['.env', 'credentials.json']);
    }
  });

  // Stage 3 review (260427) — gpt-5.5 surfaced gap: rebel-name persistence
  // path was not directly pinned. The implementation correctly resolves
  // `request.desiredAttributionName ?? contribution.attributionName`; this
  // test pins both branches.
  it('relay rebel-name success persists desiredAttributionName when supplied', async () => {
    const contrib = makeContrib({
      attributionMode: 'rebel-name',
      attributionName: 'Old Name',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    mockSubmitViaRelay.mockResolvedValueOnce({
      success: true,
      data: {
        relayContributionId: 'rel-rn-1',
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/700',
        prNumber: 700,
      },
      requestId: 'req-rn-1',
    });

    await submitContribution(contrib.id, {
      desiredAttributionMode: 'rebel-name',
      desiredAttributionName: 'New Name',
    });

    const refreshed = getContributionById(contrib.id);
    expect(refreshed?.attributionMode).toBe('rebel-name');
    expect(refreshed?.attributionName).toBe('New Name');
  });

  it('relay rebel-name success falls back to stored attributionName when desiredAttributionName is undefined', async () => {
    const contrib = makeContrib({
      attributionMode: 'rebel-name',
      attributionName: 'Stored Name',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    mockSubmitViaRelay.mockResolvedValueOnce({
      success: true,
      data: {
        relayContributionId: 'rel-rn-2',
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/701',
        prNumber: 701,
      },
      requestId: 'req-rn-2',
    });

    await submitContribution(contrib.id, {
      desiredAttributionMode: 'rebel-name',
      // no desiredAttributionName
    });

    const refreshed = getContributionById(contrib.id);
    expect(refreshed?.attributionName).toBe('Stored Name');
  });

  // Stage 3 review (260427) — tester gpt-5.5 surfaced gap: GitHub success
  // transition writes status + attributionMode + attributionName +
  // relayContributionId-clear in a SINGLE updateContribution call
  // (atomicity invariant). Pins via spy on the store.
  it.skip('GitHub success writes the success transition atomically (single updateContribution call)', async () => {
    const contrib = makeContrib({
      attributionMode: 'github',
      connectorName: 'my-connector',
      localServerPath: '/home/user/my-connector',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });
    updateContribution(contrib.id, { relayContributionId: 'rel-stale' });

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
      prUrl: 'https://github.com/org/repo/pull/702',
      prNumber: 702,
    });

    const updateSpy = vi.spyOn(contributionStore, 'updateContribution');
    try {
      await submitContribution(contrib.id);

      // Find calls made AFTER createPR resolved (i.e. the success transition).
      // The spy sees ALL store writes, including the test setup writes; we
      // identify the success-transition write as the one that includes
      // status: 'submitted'.
      const submittedCalls = updateSpy.mock.calls.filter(
        (call) => (call[1] as { status?: string }).status === 'submitted',
      );
      expect(submittedCalls.length).toBe(1);
      const [, updates] = submittedCalls[0];
      // The updates argument must contain ALL four fields atomically.
      expect(updates).toMatchObject({
        prUrl: 'https://github.com/org/repo/pull/702',
        status: 'submitted',
        attributionMode: 'github',
        attributionName: 'bot-user',
        relayContributionId: null, // null sentinel = clear
      });
    } finally {
      updateSpy.mockRestore();
    }
  });
});

// ─── Tests: PR metadata composition (Stage 3) ───────────────────────
//
// Stage 3 of docs/plans/260424_contribution_pr_template_revamp.md wires
// the shared formatter into `submitViaGitHub`. These tests assert the
// audit §5 own-fork bare-title rule, the fail-closed behaviour on
// missing attribution, user-form sanitization, dispatcher-level
// cross-transport parity, and the friendly DUPLICATE-on-retry message.

describe('submitContribution — PR metadata composition (Stage 3)', () => {
  function stubGithubHappyPath(forkOwner = 'octocat') {
    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    mockForkRepo.mockResolvedValueOnce({
      owner: forkOwner,
      repo: 'mcp-servers',
      defaultBranch: 'main',
    });
    mockPushConnectorFiles.mockResolvedValueOnce(undefined);
    mockCreatePR.mockResolvedValueOnce({
      kind: 'success',
      prUrl: 'https://github.com/org/repo/pull/1',
      prNumber: 1,
    });
  }

  function capturedCreatePr(): { title: string; body: string } {
    const firstCall = mockCreatePR.mock.calls[0] as unknown[];
    return firstCall[0] as { title: string; body: string };
  }

  function capturedPushCommitMessage(): string {
    const firstCall = mockPushConnectorFiles.mock.calls[0] as unknown[];
    return firstCall[5] as string;
  }

  beforeEach(() => {
    storeData = {};
    _resetStore();
    resetSubmitDispatcherForTesting();
    vi.clearAllMocks();
  });

  it.skip('own-fork title has NO submitter suffix — bare "feat(connector): add <name>" (audit §5)', async () => {
    const contrib = makeContrib({
      attributionMode: 'github',
      localServerPath: '/tmp/rebel-stage3-own-fork-title',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });
    updateContribution(contrib.id, { summary: 'Adds the my-connector connector.' });
    stubGithubHappyPath('octocat');

    const result = await submitContribution(contrib.id);

    expect(result.success).toBe(true);
    const { title, body } = capturedCreatePr();
    expect(title).toBe('feat(connector): add my-connector');
    expect(title).not.toContain('— submitted by');
    expect(capturedPushCommitMessage()).toBe('feat(connector): add my-connector');
    // Body Submitter section still carries fork.owner (body is not bare).
    expect(body).toContain('## Submitter\noctocat');
    expect(body).toContain('## Summary\nAdds the my-connector connector.');
  });

  it.skip('fail-closed: dispatcher maps formatter validation error to VALIDATION (no PR created)', async () => {
    // Simulate attributionMode 'github' with fork.owner being blanked
    // post-fork — the formatter throws because non-anonymous needs a
    // name, and the dispatcher must surface that as VALIDATION, NOT
    // INTERNAL (which would leak the internal Error.message to the UI
    // without structure).
    const contrib = makeContrib({
      attributionMode: 'github',
      localServerPath: '/tmp/rebel-stage3-fail-closed',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    // fork.owner empty → formatter rejects non-anonymous body construction.
    mockForkRepo.mockResolvedValueOnce({
      owner: '',
      repo: 'mcp-servers',
      defaultBranch: 'main',
    });

    const result = await submitContribution(contrib.id);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION');
      expect(result.error.message).toMatch(/attributionName/);
    }
    expect(mockPushConnectorFiles).not.toHaveBeenCalled();
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  it.skip('user-form sanitization: adversarial <script> in summary is stripped in both transports', async () => {
    const adversarialSummary = 'Legit header <script>alert(1)</script> rest';

    // --- Own-fork path ---
    const ownForkContrib = makeContrib({
      connectorName: 'my-connector',
      attributionMode: 'github',
      localServerPath: '/tmp/rebel-stage3-sanitize-ownfork',
    });
    updateContribution(ownForkContrib.id, { status: 'testing' });
    updateContribution(ownForkContrib.id, { status: 'ready_to_submit' });
    updateContribution(ownForkContrib.id, { summary: adversarialSummary });
    stubGithubHappyPath('octocat');

    await submitContribution(ownForkContrib.id);
    const ownForkBody = capturedCreatePr().body;

    // --- Relay path ---
    vi.clearAllMocks();
    const relayContrib = makeContrib({
      connectorName: 'my-connector',
      attributionMode: 'rebel-name',
      attributionName: 'Alex Chen',
      localServerPath: '/tmp/rebel-stage3-sanitize-relay',
    });
    updateContribution(relayContrib.id, { status: 'testing' });
    updateContribution(relayContrib.id, { status: 'ready_to_submit' });
    updateContribution(relayContrib.id, { summary: adversarialSummary });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    // The fake relay extension sees the (contribution, files) pair. Exercise
    // the shared helper directly with the same precedence rules for parity
    // verification.
    mockSubmitViaRelay.mockResolvedValueOnce({
      success: true,
      data: {
        relayContributionId: 'rel-sanitize',
        prUrl: 'https://github.com/mindstone/mcp-servers/pull/1',
        prNumber: 1,
      },
      requestId: 'req-sanitize',
    });
    await submitContribution(relayContrib.id);

    // Assert own-fork body has adversarial content stripped.
    expect(ownForkBody).not.toContain('<script');
    expect(ownForkBody).toContain('Legit header');
    expect(ownForkBody).toContain('rest');

    // Relay branch assertion: since the private extension is faked in this
    // test, byte-identical parity across transports is asserted below using
    // the shared `composePrMetadataFromContribution` helper directly.
  });

  it('dispatcher-level parity smoke test: same contribution → same body modulo submissionPath', async () => {
    // Exercise the shared helper directly (both submit paths delegate to
    // it) with identical contribution fixtures but different transport
    // contexts. Strip the `submissionPath` substring from each body
    // before comparison — that's the only legit divergence point.
    const { composePrMetadataFromContribution } = await import(
      '@core/services/contributionPrMetadata'
    );
    const { inferConfigSummaryFromDisk } = await import(
      '@core/services/contributionPrFormatter'
    );

    const contribution = makeContrib({
      connectorName: 'humaans',
      attributionMode: 'rebel-name',
      attributionName: 'Alex Chen',
      localServerPath: '/tmp/rebel-stage3-parity-nonexistent',
    });
    updateContribution(contribution.id, { summary: 'Parity test summary.' });
    const refreshed = getContributionById(contribution.id);
    expect(refreshed).toBeDefined();

    const configResult = await inferConfigSummaryFromDisk(refreshed!.localServerPath);

    const relay = composePrMetadataFromContribution(refreshed!, {
      submissionPath: 'Rebel relay',
      attributionMode: 'rebel-name',
      attributionName: 'Alex Chen',
      includeSubmitterInTitle: true,
      configResult,
    });
    const ownFork = composePrMetadataFromContribution(refreshed!, {
      submissionPath: 'GitHub fork',
      attributionMode: 'github',
      // Own-fork uses fork.owner as attributionName in the real flow.
      attributionName: 'Alex Chen',
      includeSubmitterInTitle: false,
      configResult,
    });

    // Bodies are identical (no Submitter section divergence — own-fork
    // still has ## Submitter because attributionMode is non-anonymous).
    // Neither body embeds `submissionPath` so simple equality holds.
    expect(ownFork.body).toBe(relay.body);

    // Titles differ only by the submitter suffix (relay non-anonymous
    // has it; own-fork does not, per audit §5).
    expect(relay.title).toBe('feat(connector): add humaans — submitted by Alex Chen');
    expect(ownFork.title).toBe('feat(connector): add humaans');
  });

  it('title overflow (relay non-anonymous): long name → suffix dropped; body keeps Submitter', async () => {
    const { composePrMetadataFromContribution } = await import(
      '@core/services/contributionPrMetadata'
    );
    const connectorName = 'a'.repeat(80);
    const attributionName = 'Alice-'.repeat(20);

    const contribution = makeContrib({
      connectorName,
      attributionMode: 'rebel-name',
      attributionName,
    });

    const result = composePrMetadataFromContribution(contribution, {
      submissionPath: 'Rebel relay',
      attributionMode: 'rebel-name',
      attributionName,
      includeSubmitterInTitle: true,
      configResult: { outcome: 'missing' },
    });

    // Title falls back to bare (suffix would overflow TITLE_MAX=120).
    expect(result.title).toBe(`feat(connector): add ${connectorName}`);
    expect(result.title.length).toBeLessThanOrEqual(120);
    // Body's Submitter section still carries the name — only the
    // title-suffix is dropped on overflow.
    expect(result.body).toContain(`## Submitter\n${attributionName}`);
  });

  it('DUPLICATE-on-retry-with-edits: returns friendly error containing existing prUrl', async () => {
    const existingPrUrl = 'https://github.com/mindstone/mcp-servers/pull/55';
    const contrib = makeContrib({
      attributionMode: 'rebel-name',
      attributionName: 'Alex Chen',
      localServerPath: '/tmp/rebel-stage3-duplicate-retry',
    });
    updateContribution(contrib.id, { status: 'testing' });
    updateContribution(contrib.id, { status: 'ready_to_submit' });
    updateContribution(contrib.id, {
      status: 'submitted',
      prUrl: existingPrUrl,
      relayContributionId: 'rel-already-in-flight',
    });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    // Backend responds with a non-idempotent DUPLICATE (no PR metadata
    // in the error body) because the retried payload hash mismatches.
    mockSubmitViaRelay.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'DUPLICATE',
        message: 'already submitted with different payload hash',
      },
    });

    const result = await submitContribution(contrib.id);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DUPLICATE');
      expect(result.error.message).toContain(existingPrUrl);
      // Must not leak the raw backend message.
      expect(result.error.message).not.toContain('payload hash');
    }
  });

  it('DUPLICATE without existing prUrl passes the raw backend message through (no friendly rewrite)', async () => {
    // Belt-and-braces: friendly rewrite only fires when we have the
    // existing prUrl context. Without it, users need the raw backend
    // message so they can debug.
    const contrib = makeContrib({
      attributionMode: 'anonymous',
      localServerPath: '/tmp/rebel-stage3-duplicate-no-url',
    });

    mockReadConnectorFiles.mockResolvedValueOnce({
      files: [{ path: 'connectors/my-connector/src/index.ts', content: 'x' }],
      skippedDenylisted: [],
    });
    mockSubmitViaRelay.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'DUPLICATE',
        message: 'duplicate submission from another session',
      },
    });

    const result = await submitContribution(contrib.id);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DUPLICATE');
      expect(result.error.message).toBe('duplicate submission from another session');
    }
  });
});
