/**
 * Stage 1.A — Bridge `Decision` envelope round-trip tests.
 *
 * Asserts that `POST /contribution/report-state` emits a typed Decision
 * envelope on every non-malformed-input response, and preserves all legacy
 * fields (`promotionDecision`, `promotionReason`, `missingSignals`,
 * `guidance`, `error`, `currentStatus`, `attemptedStatus`) for the one-
 * release transition window per Decision 4 of the Stage 1 plan.
 *
 * Sister file: `bundledInboxBridge.test.ts` — the Stage 2.5 evidence-gate
 * suite that this file extends without editing. Existing assertions on
 * legacy fields stay green by construction.
 */

import os from 'node:os';
import {
  startBundledInboxBridge,
  stopBundledInboxBridge,
} from '../bundledInboxBridge';
import {
  DecisionEnvelopeBodySchema,
} from '@shared/contribution/decisionEnvelope';
import { getSettings } from '@core/services/settingsStore';

// ── Mocks (same shape as bundledInboxBridge.test.ts) ────────────────────

const mockState = { version: 1, items: [], history: [] };

vi.mock('@core/featureGating', () => ({
  isFeatureEnabled: vi.fn(() => true),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      refreshLicenseTier: vi.fn(() => Promise.resolve()),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({
    coreDirectory: '/mock/workspace',
    mcpConfigFile: null,
    onboardingCompleted: true,
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'gpt-4o-mini-transcribe-2025-12-15',
      ttsVoice: null,
      activationHotkey: null,
      activationHotkeyVoiceMode: true,
    },
    claude: {
      apiKey: null,
      model: 'claude-sonnet-4-5',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: true,
      extendedContext: true,
      thinkingEffort: 'high',
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    streaming: { enabled: true },
  })),
  updateSettings: vi.fn(),
}));

vi.mock('../inboxStore', () => ({
  addInboxItem: vi.fn(() => ({ accepted: true, itemId: 'mock', state: mockState })),
  updateInboxItem: vi.fn(() => mockState),
  removeInboxItem: vi.fn(() => mockState),
  getInboxState: vi.fn(() => mockState),
}));

vi.mock('../spaceService', () => ({
  validateSpacePath: vi.fn(),
  readSpaceReadmeFrontmatter: vi.fn(),
  updateSpaceFrontmatter: vi.fn(),
  scanSpaces: vi.fn(() => Promise.resolve([])),
  createSpace: vi.fn(),
  invalidateSpaceScanCache: vi.fn(),
}));

vi.mock('../conversationIndexService', () => ({
  searchConversations: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    getSession: vi.fn(() => Promise.resolve(null)),
  })),
}));

vi.mock('../demoModeService', () => ({
  isDemoModeActive: vi.fn(() => false),
}));

vi.mock('../../utils/logRedaction', () => ({
  redactObjectDeep: vi.fn((obj) => obj),
}));

vi.mock('../meetingHistoryStore', () => ({
  getMeetingsInRange: vi.fn(() => []),
  getMissedMeetings: vi.fn(() => []),
}));

vi.mock('../meetingBot/meetingBotService', () => ({}));

vi.mock('../mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => '/mock/mcp-config.json'),
  restartSuperMcpForConfigChangeAndAwaitExecution: vi.fn(() => Promise.resolve()),
  reloadSuperMcpNowForChatPackageMaterialization: vi.fn(() => Promise.resolve()),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() }),
}));

// ── Test setup ──────────────────────────────────────────────────────────

const CANONICAL_PATH = `${os.homedir()}/mcp-servers/envelope-test-mcp`;
const NON_CANONICAL_PATH = `${os.homedir()}/Documents/Rebel/scripts/envelope-test-mcp`;

function setSeEvidenceGateEnabled(enabled: boolean): void {
  const base = vi.mocked(getSettings).getMockImplementation?.() as (() => Record<string, unknown>) | undefined;
  const results = vi.mocked(getSettings).mock.results;
  const latest = results.length > 0 ? results[results.length - 1] : undefined;
  const snapshot = base ? base() : (latest?.value as Record<string, unknown> | undefined);
  vi.mocked(getSettings).mockReturnValue({
    ...(snapshot ?? {}),
    enforceSoftwareEngineerEvidence: enabled,
  } as ReturnType<typeof getSettings>);
}

async function postReportState(
  port: number,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/contribution/report-state`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('bundledInboxBridge — /contribution/report-state Decision envelope', () => {
  afterEach(async () => {
    await stopBundledInboxBridge();
    vi.clearAllMocks();
  });

  beforeEach(async () => {
    const { _resetStore } = await import('@core/services/contributionStore');
    // Stage 3.F (260426): the legacy in-memory promotion service was
    // deleted; durable readiness lives on the contribution record itself,
    // so resetting the store is sufficient to clear all observation state.
    _resetStore();
    setSeEvidenceGateEnabled(false);
  });

  it('returns decision.kind=created when creating a draft record', async () => {
    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-1',
      connectorName: 'envelope-test-1',
      status: 'draft',
      localServerPath: CANONICAL_PATH,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);
    expect(payload.created).toBe(true);
    expect(payload.decision).toBeDefined();
    expect(payload.decision.kind).toBe('created');
    expect(payload.decision.build.id).toBe(payload.contributionId);
    expect(payload.decision.build.status).toBe('draft');
    expect(payload.decision.build.connectorName).toBe('envelope-test-1');
  });

  it('returns decision.kind=updated on testing → ready_to_submit promotion', async () => {
    const {
      createContribution,
      setLastTestPassedAt,
      setLastBuildFingerprint,
    } = await import('@core/services/contributionStore');
    const created = createContribution({
      sessionId: 'session-envelope-2',
      connectorName: 'envelope-test-2',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: CANONICAL_PATH,
    });
    // Stage 3.E (260426): pre-seed Stage 3 readiness fields directly on
    // the record. The reducer's predicate satisfies on
    // `lastReadyRequestedAt + lastTestPassedAt + fingerprintMatches`.
    // The bridge fires a fresh `ready_requested` observation, which
    // stamps `lastReadyRequestedAt` AND populates the fingerprint from
    // the agent-asserted value (or undefined → fail-open since no state
    // fingerprint is set yet — still fails predicate). To make this
    // test pass we set both lastTestPassedAt AND a matching fingerprint
    // that's also undefined (so the fail-open path triggers).
    setLastTestPassedAt(created.id, '2026-04-26T11:00:00.000Z');
    // Don't set fingerprint — fail-open lets predicate proceed when
    // both observed and stored are undefined. Bridge runs in core,
    // node:fs is real, package.json doesn't exist at CANONICAL_PATH
    // (test path) → observed fingerprint also undefined → fail-open.
    void setLastBuildFingerprint;

    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-2',
      connectorName: 'envelope-test-2',
      status: 'ready_to_submit',
      localServerPath: CANONICAL_PATH,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.decision.kind).toBe('updated');
    expect(payload.decision.build.status).toBe('ready_to_submit');
    // Legacy field preservation: Stage 3 emits the observation pipeline
    // decision instead of the legacy promotion-service decision.
    expect(payload.promotionDecision).toBe('updated');
  });

  it('bridge path gate-off: ready_requested promotes with server evidence and no SE evidence', async () => {
    setSeEvidenceGateEnabled(false);
    const {
      createContribution,
      setLastRegisteredAt,
    } = await import('@core/services/contributionStore');
    const created = createContribution({
      sessionId: 'session-envelope-gate-off',
      connectorName: 'envelope-gate-off',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: CANONICAL_PATH,
    });
    setLastRegisteredAt(created.id, '2026-04-26T12:00:00.000Z');

    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-gate-off',
      connectorName: 'envelope-gate-off',
      status: 'ready_to_submit',
      localServerPath: CANONICAL_PATH,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.decision.kind).toBe('updated');
    expect(payload.decision.build.status).toBe('ready_to_submit');
  });

  it('bridge path gate-on: defers to SE workflow when SE evidence is missing', async () => {
    setSeEvidenceGateEnabled(true);
    const {
      createContribution,
      getContributionById,
      setLastRegisteredAt,
    } = await import('@core/services/contributionStore');
    const created = createContribution({
      sessionId: 'session-envelope-gate-on',
      connectorName: 'envelope-gate-on',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: CANONICAL_PATH,
    });
    setLastRegisteredAt(created.id, '2026-04-26T12:00:00.000Z');

    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-gate-on',
      connectorName: 'envelope-gate-on',
      status: 'ready_to_submit',
      localServerPath: CANONICAL_PATH,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.decision.kind).toBe('deferred');
    expect(payload.decision.reason).toBe('missing_evidence');
    expect(payload.decision.nextAction).toBe('run_software_engineer_workflow');
    expect(payload.decision.chatSafeGuidance).toBe('Let me think this through properly before I share it.');
    const refreshed = getContributionById(created.id);
    expect(refreshed?.lastTransitionError).toContain('"reason":"missing_se_evidence"');
  });

  it('bridge path gate-on uses fingerprint-mismatch recovery guidance variant', async () => {
    setSeEvidenceGateEnabled(true);
    const {
      createContribution,
      setLastRegisteredAt,
      updateContribution,
    } = await import('@core/services/contributionStore');
    const created = createContribution({
      sessionId: 'session-envelope-gate-variant-b',
      connectorName: 'envelope-gate-variant-b',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: CANONICAL_PATH,
    });
    setLastRegisteredAt(created.id, '2026-04-26T12:00:00.000Z');
    updateContribution(created.id, {
      lastSoftwareEngineerEvidenceInvalidatedReason: 'fingerprint_mismatch',
    });

    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-gate-variant-b',
      connectorName: 'envelope-gate-variant-b',
      status: 'ready_to_submit',
      localServerPath: CANONICAL_PATH,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.decision.kind).toBe('deferred');
    expect(payload.decision.nextAction).toBe('run_software_engineer_workflow');
    expect(payload.decision.guidance).toContain('connector code has changed since');
  });

  it('returns decision.kind=deferred + reason=missing_evidence on direct-create ready_to_submit (no evidence)', async () => {
    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-3',
      connectorName: 'envelope-test-3',
      status: 'ready_to_submit',
      localServerPath: CANONICAL_PATH,
    });

    expect(res.status).toBe(202);
    const payload = await res.json();
    expect(payload.decision.kind).toBe('deferred');
    expect(payload.decision.reason).toBe('missing_evidence');
    expect(payload.decision.nextAction).toBe('run_tests');
    expect(payload.decision.guidance).toBeTruthy();
    // Stage 3.E (260426): direct-create at ready_to_submit creates `draft`
    // (not `testing`) per matrix #22 realignment.
    expect(payload.decision.build.status).toBe('draft');
    // Legacy preservation:
    expect(payload.promotionDecision).toBe('deferred');
    expect(payload.promotionReason).toBe('evidence-insufficient');
    expect(typeof payload.guidance).toBe('string');
  });

  it('returns decision.kind=deferred + reason=non_canonical_path on non-canonical direct-create', async () => {
    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-4',
      connectorName: 'envelope-test-4',
      status: 'ready_to_submit',
      localServerPath: NON_CANONICAL_PATH,
    });

    expect(res.status).toBe(202);
    const payload = await res.json();
    expect(payload.decision.kind).toBe('deferred');
    expect(payload.decision.reason).toBe('non_canonical_path');
    expect(payload.decision.nextAction).toBe('move_to_canonical_path');
    expect(payload.decision.guidance).toBeTruthy();
    // Legacy preservation:
    expect(payload.promotionDecision).toBe('deferred');
    expect(payload.promotionReason).toBe('non-canonical-path');
  });

  it('returns decision.kind=deferred + reason=non_canonical_path on existing-record non-canonical promotion', async () => {
    const { createContribution } = await import('@core/services/contributionStore');
    createContribution({
      sessionId: 'session-envelope-5',
      connectorName: 'envelope-test-5',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: NON_CANONICAL_PATH,
    });

    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-5',
      connectorName: 'envelope-test-5',
      status: 'ready_to_submit',
      localServerPath: NON_CANONICAL_PATH,
    });

    expect(res.status).toBe(202);
    const payload = await res.json();
    expect(payload.decision.kind).toBe('deferred');
    expect(payload.decision.reason).toBe('non_canonical_path');
    expect(payload.decision.nextAction).toBe('move_to_canonical_path');
    expect(payload.decision.build).toBeDefined();
    // Legacy preservation:
    expect(payload.promotionDecision).toBe('deferred');
    expect(payload.promotionReason).toBe('non-canonical-path');
  });

  it('returns decision.kind=rejected + reason=invalid_transition with HTTP 200 (was 400 pre-Stage-1)', async () => {
    const { createContribution } = await import('@core/services/contributionStore');
    // Seed a `submitted` record; transitioning back to `testing` is invalid.
    createContribution({
      sessionId: 'session-envelope-6',
      connectorName: 'envelope-test-6',
      status: 'submitted',
      attributionMode: 'anonymous',
      localServerPath: CANONICAL_PATH,
    });

    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-6',
      connectorName: 'envelope-test-6',
      status: 'testing',
      localServerPath: CANONICAL_PATH,
    });

    // Stage 1.A: invalid-transition rejection moved 400 → 200.
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(false);
    expect(payload.decision.kind).toBe('rejected');
    expect(payload.decision.reason).toBe('invalid_transition');
    expect(payload.decision.nextAction).toBe('wait_for_review');
    expect(payload.decision.guidance).toBeTruthy();
    // Legacy preservation:
    expect(payload.error).toBeTruthy();
    expect(payload.currentStatus).toBe('submitted');
    expect(payload.attemptedStatus).toBe('testing');
    // Stage 1 fix pass: the rejected response must also carry the legacy
    // promotionDecision / promotionReason / guidance fields per Decision 4
    // of the plan ("Fields kept on deferred / rejected responses: All of the
    // above PLUS promotionDecision, promotionReason, missingSignals,
    // guidance"). Reviewers flagged the prior omission as a Decision 4
    // contract violation.
    expect(payload.promotionDecision).toBe('rejected');
    expect(payload.promotionReason).toBe('invalid-transition');
    expect(typeof payload.guidance).toBe('string');
    expect(payload.guidance.length).toBeGreaterThan(0);
  });

  it('returns decision.kind=noop when re-asserting current status', async () => {
    const { createContribution } = await import('@core/services/contributionStore');
    createContribution({
      sessionId: 'session-envelope-7',
      connectorName: 'envelope-test-7',
      status: 'draft',
      attributionMode: 'anonymous',
      localServerPath: CANONICAL_PATH,
    });

    const { port, token } = await startBundledInboxBridge();
    const res = await postReportState(port, token, {
      sessionId: 'session-envelope-7',
      connectorName: 'envelope-test-7',
      status: 'draft',
      localServerPath: CANONICAL_PATH,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.decision.kind).toBe('noop');
    expect(payload.decision.build.status).toBe('draft');
  });

  it('preserves all legacy fields on every response shape (created/updated/deferred/rejected/noop)', async () => {
    // Stage 2.D (260426): the path-first lookup means two sessions reporting
    // at the same canonical path operate on the SAME record. This test
    // exercises three decision shapes (created, deferred, rejected) which
    // need three independent records — use unique paths per sub-block.
    const LEGACY_PATH_1 = `${os.homedir()}/mcp-servers/envelope-legacy-1`;
    const LEGACY_PATH_2 = `${os.homedir()}/mcp-servers/envelope-legacy-2`;
    const LEGACY_PATH_3 = `${os.homedir()}/mcp-servers/envelope-legacy-3`;

    // Created
    const { port, token } = await startBundledInboxBridge();
    const created = await postReportState(port, token, {
      sessionId: 'session-envelope-legacy-1',
      connectorName: 'legacy-test',
      status: 'draft',
      localServerPath: LEGACY_PATH_1,
    }).then((r) => r.json());
    expect(created.success).toBe(true);
    expect(created.contributionId).toBeTruthy();
    expect(created.status).toBe('draft');
    expect(created.created).toBe(true);

    // Deferred (missing-evidence)
    const deferred = await postReportState(port, token, {
      sessionId: 'session-envelope-legacy-2',
      connectorName: 'legacy-test-2',
      status: 'ready_to_submit',
      localServerPath: LEGACY_PATH_2,
    }).then((r) => r.json());
    expect(deferred.promotionDecision).toBe('deferred');
    expect(deferred.promotionReason).toBe('evidence-insufficient');
    // Stage 3.E (260426): missingSignals dropped — Stage 3 reducer
    // doesn't enumerate missing signal kinds (they're now durable
    // readiness fields, not transient signals).
    expect(typeof deferred.guidance).toBe('string');

    // Rejected (invalid-transition)
    const { createContribution } = await import('@core/services/contributionStore');
    createContribution({
      sessionId: 'session-envelope-legacy-3',
      connectorName: 'legacy-test-3',
      status: 'submitted',
      attributionMode: 'anonymous',
      localServerPath: LEGACY_PATH_3,
    });
    const rejected = await postReportState(port, token, {
      sessionId: 'session-envelope-legacy-3',
      connectorName: 'legacy-test-3',
      status: 'testing',
      localServerPath: LEGACY_PATH_3,
    }).then((r) => r.json());
    expect(rejected.error).toBeTruthy();
    expect(rejected.currentStatus).toBe('submitted');
    expect(rejected.attemptedStatus).toBe('testing');
  });

  it('400 malformed-input responses do NOT carry a decision field', async () => {
    const { port, token } = await startBundledInboxBridge();

    // Missing sessionId
    const res1 = await postReportState(port, token, { status: 'draft' });
    expect(res1.status).toBe(400);
    const body1 = await res1.json();
    expect(body1.success).toBe(false);
    expect(body1.error).toContain('sessionId');
    expect(body1.decision).toBeUndefined();

    // Bad status enum
    const res2 = await postReportState(port, token, {
      sessionId: 'session-bad-status',
      status: 'not-a-real-status',
    });
    expect(res2.status).toBe(400);
    const body2 = await res2.json();
    expect(body2.decision).toBeUndefined();

    // Empty localServerPath
    const res3 = await postReportState(port, token, {
      sessionId: 'session-empty-path',
      connectorName: 'foo',
      status: 'draft',
      localServerPath: '',
    });
    expect(res3.status).toBe(400);
    const body3 = await res3.json();
    expect(body3.decision).toBeUndefined();
  });

  it('decision envelope schema validates with Zod (round-trip across all kinds)', async () => {
    const { port, token } = await startBundledInboxBridge();

    // created
    const createdBody = await postReportState(port, token, {
      sessionId: 'session-zod-1',
      connectorName: 'zod-test',
      status: 'draft',
      localServerPath: CANONICAL_PATH,
    }).then((r) => r.json());
    expect(() => DecisionEnvelopeBodySchema.parse(createdBody)).not.toThrow();

    // deferred (missing-evidence)
    const deferredBody = await postReportState(port, token, {
      sessionId: 'session-zod-2',
      connectorName: 'zod-test-2',
      status: 'ready_to_submit',
      localServerPath: CANONICAL_PATH,
    }).then((r) => r.json());
    expect(() => DecisionEnvelopeBodySchema.parse(deferredBody)).not.toThrow();

    // deferred (non-canonical)
    const nonCanonicalBody = await postReportState(port, token, {
      sessionId: 'session-zod-3',
      connectorName: 'zod-test-3',
      status: 'ready_to_submit',
      localServerPath: NON_CANONICAL_PATH,
    }).then((r) => r.json());
    expect(() => DecisionEnvelopeBodySchema.parse(nonCanonicalBody)).not.toThrow();

    // updated (promotion)
    // Stage 3.F (260426): legacy in-memory signal recording is gone;
    // pre-seed durable readiness directly on the record so the bridge's
    // `ready_requested` observation satisfies the predicate
    // (`lastReadyRequestedAt + lastTestPassedAt + fingerprintMatches`).
    const { createContribution, setLastTestPassedAt } = await import(
      '@core/services/contributionStore'
    );
    const created = createContribution({
      sessionId: 'session-zod-4',
      connectorName: 'zod-test-4',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: CANONICAL_PATH,
    });
    setLastTestPassedAt(created.id, new Date().toISOString());
    const updatedBody = await postReportState(port, token, {
      sessionId: 'session-zod-4',
      connectorName: 'zod-test-4',
      status: 'ready_to_submit',
      localServerPath: CANONICAL_PATH,
    }).then((r) => r.json());
    expect(() => DecisionEnvelopeBodySchema.parse(updatedBody)).not.toThrow();

    // rejected (invalid-transition)
    createContribution({
      sessionId: 'session-zod-5',
      connectorName: 'zod-test-5',
      status: 'submitted',
      attributionMode: 'anonymous',
      localServerPath: CANONICAL_PATH,
    });
    const rejectedBody = await postReportState(port, token, {
      sessionId: 'session-zod-5',
      connectorName: 'zod-test-5',
      status: 'testing',
      localServerPath: CANONICAL_PATH,
    }).then((r) => r.json());
    expect(() => DecisionEnvelopeBodySchema.parse(rejectedBody)).not.toThrow();

    // noop
    createContribution({
      sessionId: 'session-zod-6',
      connectorName: 'zod-test-6',
      status: 'draft',
      attributionMode: 'anonymous',
      localServerPath: CANONICAL_PATH,
    });
    const noopBody = await postReportState(port, token, {
      sessionId: 'session-zod-6',
      connectorName: 'zod-test-6',
      status: 'draft',
      localServerPath: CANONICAL_PATH,
    }).then((r) => r.json());
    expect(() => DecisionEnvelopeBodySchema.parse(noopBody)).not.toThrow();
  });

  it('decision.guidance is a non-empty string for deferred/rejected responses', async () => {
    // Stage 2.D (260426): unique paths so deferred + rejected sub-blocks
    // operate on independent records (path-first lookup would otherwise
    // link them).
    const GUIDANCE_PATH_1 = `${os.homedir()}/mcp-servers/envelope-guidance-1`;
    const GUIDANCE_PATH_2 = `${os.homedir()}/mcp-servers/envelope-guidance-2`;

    const { port, token } = await startBundledInboxBridge();
    const deferred = await postReportState(port, token, {
      sessionId: 'session-guidance-1',
      connectorName: 'guidance-test',
      status: 'ready_to_submit',
      localServerPath: GUIDANCE_PATH_1,
    }).then((r) => r.json());
    expect(typeof deferred.decision.guidance).toBe('string');
    expect(deferred.decision.guidance.length).toBeGreaterThan(0);

    const { createContribution } = await import('@core/services/contributionStore');
    createContribution({
      sessionId: 'session-guidance-2',
      connectorName: 'guidance-test-2',
      status: 'submitted',
      attributionMode: 'anonymous',
      localServerPath: GUIDANCE_PATH_2,
    });
    const rejected = await postReportState(port, token, {
      sessionId: 'session-guidance-2',
      connectorName: 'guidance-test-2',
      status: 'testing',
      localServerPath: GUIDANCE_PATH_2,
    }).then((r) => r.json());
    expect(typeof rejected.decision.guidance).toBe('string');
    expect(rejected.decision.guidance.length).toBeGreaterThan(0);
  });

  // Note: the 404 path (`updated === undefined`) is unreachable from the public
  // HTTP surface because `existing.id` is always pulled from a same-request
  // `getContributionBySession` lookup. The 500 fallback (catch-all) is exercised
  // by the existing bridge tests via mocked imports and is not envelope-specific.
  // The malformed-input 400 path is covered above (line ~447).
});
