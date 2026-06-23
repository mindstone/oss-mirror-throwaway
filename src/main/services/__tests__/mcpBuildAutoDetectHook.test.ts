import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetSeEvidenceFlagTrackingForTest,
  createMcpBuildAutoDetectHook,
} from '../mcpBuildAutoDetectHook';

// ─── Mocks ──────────────────────────────────────────────────────────

// Shared logger mock so Stage 4b Fix 4 tests can assert on log.warn calls.
const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  getActiveTurnForSession: vi.fn(() => undefined as string | undefined),
  getContextAccumulator: vi.fn(() => undefined),
}));

const sessionStoreMocks = vi.hoisted(() => ({
  getSession: vi.fn(async () => null),
}));

const seTaskDetectionMocks = vi.hoisted(() => ({
  detectSoftwareEngineerTaskCompletion: vi.fn(() => ({ found: false as const, reason: 'no_tasks_in_window' as const })),
  extractTaskEventsFromConversationShape: vi.fn(() => []),
  extractTaskEventsFromPersistedEvents: vi.fn(() => []),
}));

 
vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({
    homePath: '/Users/testuser',
  })),
}));

 
vi.mock('@core/utils/portablePath', () => ({
  toPortablePath: vi.fn((value: string) => value.replace(/\\/g, '/')),
}));

 
vi.mock('@core/services/contributionStore', () => ({
  // Stage 2.D (260426): hook now reads via path-first / session-fallback;
  // tests mock both lookups. Default returns `undefined` for both so each
  // test can opt in by overriding the active-session mock (path-first miss
  // is the common path for legacy tests).
  getActiveContributionBySession: vi.fn(),
  getContributionByPath: vi.fn(),
  getContributionById: vi.fn(),
  addLinkedSession: vi.fn(),
  createContribution: vi.fn(),
  updateContribution: vi.fn(),
  listContributions: vi.fn(() => []),
  // Self-block follow-on (260427) — sub-stage C. Helpers used by the
  // stuck-registration backstop. Default returns are no-ops so existing
  // tests continue to pass; the new sub-stage C tests opt in by
  // overriding `getContributionsBySession`.
  getContributionsBySession: vi.fn(() => []),
  markStuckRegistrationNudgeFired: vi.fn(),
}));

 
vi.mock('@core/utils/canonicalConnectorPath', () => ({
  canonicalizeConnectorPath: vi.fn((value: string | undefined | null) => {
    if (!value || !value.trim()) return '';
    return value.replace(/\\/g, '/').toLowerCase();
  }),
}));

 
vi.mock('@core/services/contributionObservationService', () => ({
  observeContribution: vi.fn(async () => ({
    decision: 'updated',
    reason: 'mocked',
    promoted: false,
    fingerprintMismatch: false,
  })),
  buildMissingSeEvidenceTransitionError: vi.fn(({ chatSafeGuidance }: { chatSafeGuidance?: string }) =>
    JSON.stringify({
      reason: 'missing_se_evidence',
      chatSafeGuidance: chatSafeGuidance ?? 'Let me think this through properly before I share it.',
    })),
  isMissingSeEvidenceTransitionError: vi.fn((value?: string) => {
    if (typeof value !== 'string') return false;
    try {
      const parsed = JSON.parse(value) as { reason?: string };
      return parsed.reason === 'missing_se_evidence';
    } catch {
      return false;
    }
  }),
  // Self-block follow-on (260427) — sub-stage C. Promoted public alias
  // of the per-canonical-path mutex; mocked here as a thin pass-through
  // so flag-write critical sections still fire under unit tests.
  withCanonicalPathMutex: vi.fn(async (_canonical: string, fn: () => Promise<unknown>) => fn()),
}));

 
vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: registryMocks,
}));

 
vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => sessionStoreMocks),
}));

 
vi.mock('@core/services/seTaskDetection', () => ({
  detectSoftwareEngineerTaskCompletion: seTaskDetectionMocks.detectSoftwareEngineerTaskCompletion,
  extractTaskEventsFromConversationShape: seTaskDetectionMocks.extractTaskEventsFromConversationShape,
  extractTaskEventsFromPersistedEvents: seTaskDetectionMocks.extractTaskEventsFromPersistedEvents,
}));

 
vi.mock('@core/services/mcpConfigManager', () => ({
  getMcpServerNames: vi.fn(async () => [] as string[]),
  readMcpServerDetails: vi.fn(async () => ({ args: [] as string[] })),
}));

 
vi.mock('../mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => '/tmp/test-mcp-config.json'),
}));

 
vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({ coreDirectory: '/Users/testuser/Documents/Rebel' })),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerMocks,
}));

 
vi.mock('../fileConversationStore', () => ({
  hasSessionWriteInDirectory: vi.fn(() => false),
}));

 
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => '{}'),
    },
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
  };
});

import { getPlatformConfig } from '@core/platform';
import {
  getActiveContributionBySession,
  getContributionByPath,
  getContributionById,
  addLinkedSession,
  createContribution,
  updateContribution,
  listContributions,
  getContributionsBySession,
  markStuckRegistrationNudgeFired,
} from '@core/services/contributionStore';
import type { ConnectorContribution } from '@core/services/contributionTypes';
import { observeContribution } from '@core/services/contributionObservationService';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import {
  detectSoftwareEngineerTaskCompletion,
  extractTaskEventsFromConversationShape,
  extractTaskEventsFromPersistedEvents,
} from '@core/services/seTaskDetection';
import {
  getMcpServerNames,
  readMcpServerDetails,
} from '@core/services/mcpConfigManager';
import { getSettings } from '@core/services/settingsStore';
import * as contributionPathClassifier from '@shared/utils/contributionPathClassifier';
import { hasSessionWriteInDirectory } from '../fileConversationStore';

// ─── Helpers ────────────────────────────────────────────────────────

const SESSION_ID = 'test-session-123';
const HOME_PATH = '/Users/testuser';
const CONNECTOR_DIR = path.join(HOME_PATH, 'mcp-servers', 'my-connector');
const SCRIPT_PATH = path.join(CONNECTOR_DIR, 'dist', 'index.js');
const NON_CANONICAL_SCRIPT_PATH = '/Users/testuser/Documents/Rebel/Chief-of-Staff/scripts/fibonacci-mcp/server.js';
const NON_CANONICAL_DIR = '/Users/testuser/Documents/Rebel/Chief-of-Staff/scripts/fibonacci-mcp';

function setSeEvidenceGateEnabled(enabled: boolean): void {
  const base = vi.mocked(getSettings).getMockImplementation?.() as (() => Record<string, unknown>) | undefined;
  const results = vi.mocked(getSettings).mock.results;
  const latest = results.length > 0 ? results[results.length - 1] : undefined;
  const snapshot = base ? base() : (latest?.value as Record<string, unknown> | undefined);
  vi.mocked(getSettings).mockReturnValue({
    ...(snapshot ?? { coreDirectory: '/Users/testuser/Documents/Rebel' }),
    enforceSoftwareEngineerEvidence: enabled,
  } as ReturnType<typeof getSettings>);
}

function makeHookInput(overrides: {
  tool_name?: string;
  tool_id?: string;
  package_id?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  output?: string;
} = {}) {
  return {
    tool_name: overrides.tool_name ?? 'mcp__super-mcp-router__use_tool',
    tool_input: {
      tool_id: overrides.tool_id ?? 'RebelMcpConnectors__rebel_mcp_add_server',
      package_id: overrides.package_id ?? 'RebelMcpConnectors',
      args: overrides.args ?? {
        name: 'My Connector',
        command: 'node',
        args: [SCRIPT_PATH],
      },
    },
    tool_response: {
      output: overrides.output ?? '{"success": true}',
      isError: overrides.isError ?? false,
    },
    tool_use_id: 'tool-use-abc',
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('mcpBuildAutoDetectHook', () => {
  let hook: ReturnType<typeof createMcpBuildAutoDetectHook>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSeEvidenceFlagTrackingForTest();
    setSeEvidenceGateEnabled(false);
    vi.mocked(getPlatformConfig).mockReturnValue({ homePath: HOME_PATH } as ReturnType<typeof getPlatformConfig>);
    // Stage 2.D (260426): default both lookups to "no record" so tests opt
    // in by overriding the active-session mock. Path-first miss falls
    // through to session-fallback, matching pre-2.D behaviour.
    vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
    vi.mocked(getContributionByPath).mockReturnValue(undefined);
    vi.mocked(getContributionById).mockReturnValue(undefined);
    vi.mocked(listContributions).mockReturnValue([]);
    vi.mocked(addLinkedSession).mockImplementation((() => undefined) as never);
    vi.mocked(hasSessionWriteInDirectory).mockReturnValue(false);
    // Self-block follow-on (260427) — sub-stage C. Default the
    // session-scoped lookup to empty so existing legacy tests don't
    // surface stuck-registration firings.
    vi.mocked(getContributionsBySession).mockReturnValue([]);
    vi.mocked(agentTurnRegistry.getActiveTurnForSession).mockReturnValue(undefined);
    vi.mocked(agentTurnRegistry.getContextAccumulator).mockReturnValue(undefined);
    vi.mocked(getIncrementalSessionStore).mockReturnValue(sessionStoreMocks as any);
    sessionStoreMocks.getSession.mockResolvedValue(null);
    vi.mocked(extractTaskEventsFromConversationShape).mockReturnValue([]);
    vi.mocked(extractTaskEventsFromPersistedEvents).mockReturnValue([]);
    vi.mocked(detectSoftwareEngineerTaskCompletion).mockReturnValue({
      found: false,
      reason: 'no_tasks_in_window',
    });
    hook = createMcpBuildAutoDetectHook({ sessionId: SESSION_ID });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Happy path: custom build detected → creates testing contribution
  it('creates contribution for custom build under ~/mcp-servers/', async () => {
    const result = await hook(makeHookInput());

    expect(result).toEqual({});
    expect(createContribution).toHaveBeenCalledOnce();
    expect(createContribution).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      connectorName: 'My Connector',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: CONNECTOR_DIR,
    });
  });

  it('add_server gate-off: ready_requested observation carries enforceSoftwareEngineerEvidence=false', async () => {
    setSeEvidenceGateEnabled(false);
    const existingRecord: ConnectorContribution = {
      id: 'contrib-gate-off',
      sessionId: SESSION_ID,
      linkedSessionIds: [SESSION_ID],
      connectorName: 'My Connector',
      status: 'testing',
      attributionMode: 'anonymous',
      acknowledgedEvents: [],
      localServerPath: CONNECTOR_DIR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(getContributionByPath).mockReturnValue(existingRecord);
    vi.mocked(getActiveContributionBySession).mockReturnValue(existingRecord);

    await hook(makeHookInput());

    const readyCall = vi.mocked(observeContribution).mock.calls.find(
      ([obs]) => (obs as { kind?: string }).kind === 'ready_requested',
    );
    expect(readyCall?.[1]).toEqual({ enforceSoftwareEngineerEvidence: false });
  });

  it('add_server gate-on: missing_se_evidence deferral writes synthetic transition error', async () => {
    setSeEvidenceGateEnabled(true);
    const existingRecord: ConnectorContribution = {
      id: 'contrib-gate-on',
      sessionId: SESSION_ID,
      linkedSessionIds: [SESSION_ID],
      connectorName: 'My Connector',
      status: 'testing',
      attributionMode: 'anonymous',
      acknowledgedEvents: [],
      localServerPath: CONNECTOR_DIR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(getContributionByPath).mockReturnValue(existingRecord);
    vi.mocked(getActiveContributionBySession).mockReturnValue(existingRecord);
    vi.mocked(getContributionById).mockReturnValue(existingRecord);
    vi.mocked(observeContribution).mockImplementation(async (obs: { kind?: string }) => {
      if (obs.kind === 'ready_requested') {
        return {
          decision: 'deferred',
          reason: 'missing_se_evidence',
          promoted: false,
          fingerprintMismatch: false,
          contributionId: existingRecord.id,
        } as Awaited<ReturnType<typeof observeContribution>>;
      }
      return {
        decision: 'updated',
        reason: 'mocked',
        promoted: false,
        fingerprintMismatch: false,
      } as Awaited<ReturnType<typeof observeContribution>>;
    });

    await hook(makeHookInput());

    const readyCall = vi.mocked(observeContribution).mock.calls.find(
      ([obs]) => (obs as { kind?: string }).kind === 'ready_requested',
    );
    expect(readyCall?.[1]).toEqual({ enforceSoftwareEngineerEvidence: true });
    const syntheticWrite = vi.mocked(updateContribution).mock.calls.find(
      ([id, patch]) =>
        id === existingRecord.id
        && typeof (patch as { lastTransitionError?: unknown }).lastTransitionError === 'string',
    );
    expect(syntheticWrite).toBeDefined();
    const transitionError = syntheticWrite?.[1] as { lastTransitionError?: string } | undefined;
    expect(transitionError?.lastTransitionError).toContain('"reason":"missing_se_evidence"');
  });

  // 2. Catalog install (catalogId present) → skipped
  it('skips catalog installs with catalogId', async () => {
    const result = await hook(makeHookInput({
      args: {
        name: 'Fathom',
        catalogId: 'bundled-fathom',
        command: 'node',
        args: [SCRIPT_PATH],
      },
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
  });

  // 3. Third-party server (path not under ~/mcp-servers/) → skipped
  it('skips third-party servers not under ~/mcp-servers/', async () => {
    const result = await hook(makeHookInput({
      args: {
        name: 'External MCP',
        command: 'node',
        args: ['/usr/local/lib/external-mcp/index.js'],
      },
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
  });

  it('synthesizes testing contribution with non-canonical-path error when fallback path is agent-authored', async () => {
    vi.mocked(hasSessionWriteInDirectory).mockReturnValue(true);
    vi.mocked(createContribution).mockReturnValue({
      id: 'contrib-non-canonical',
      sessionId: SESSION_ID,
      linkedSessionIds: [SESSION_ID],
      connectorName: 'fibonacci',
      status: 'testing',
      attributionMode: 'anonymous',
      acknowledgedEvents: [],
      localServerPath: NON_CANONICAL_DIR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await hook(makeHookInput({
      args: {
        name: 'fibonacci',
        command: `node ${NON_CANONICAL_SCRIPT_PATH}`,
        args: [NON_CANONICAL_SCRIPT_PATH],
      },
    }));

    expect(result).toEqual({});
    expect(createContribution).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      connectorName: 'fibonacci',
      status: 'testing',
      attributionMode: 'anonymous',
      localServerPath: NON_CANONICAL_DIR,
    });
    expect(updateContribution).toHaveBeenCalledWith('contrib-non-canonical', {
      lastTransitionError: expect.any(String),
    });

    const updatePayload = vi.mocked(updateContribution).mock.calls[0][1] as {
      lastTransitionError?: string;
    };
    const parsed = JSON.parse(updatePayload.lastTransitionError ?? '{}');
    expect(parsed.reason).toBe('non-canonical-path');
    expect(parsed.observedPath).toBe(NON_CANONICAL_DIR);
    expect(parsed.expectedPathPrefix).toBe('~/mcp-servers/<api-name>-mcp/');

    const nonCanonicalWarn = loggerMocks.warn.mock.calls.find(
      ([entry]) => (entry as { reason?: string } | undefined)?.reason === 'contribution-path-non-canonical',
    );
    expect(nonCanonicalWarn).toBeTruthy();
    expect(nonCanonicalWarn?.[0]).toMatchObject({
      gate: 'add-server-observer',
      sessionId: SESSION_ID,
      contributionId: 'contrib-non-canonical',
      connectorName: 'fibonacci',
    });
  });

  it('skips non-canonical fallback when session has no authored files under that path', async () => {
    const result = await hook(makeHookInput({
      args: {
        name: 'fibonacci',
        command: `node ${NON_CANONICAL_SCRIPT_PATH}`,
        args: [NON_CANONICAL_SCRIPT_PATH],
      },
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();

    const thirdPartySkipLog = loggerMocks.debug.mock.calls.find(
      ([entry]) => (entry as { reason?: string } | undefined)?.reason === 'add-server-third-party-skip',
    );
    expect(thirdPartySkipLog).toBeTruthy();
  });

  it('does not re-synthesize non-canonical fallback when a contribution already exists', async () => {
    vi.mocked(getActiveContributionBySession).mockReturnValue({
      id: 'contrib-existing-testing',
      sessionId: SESSION_ID,
      linkedSessionIds: [SESSION_ID],
      connectorName: 'fibonacci',
      status: 'testing',
      attributionMode: 'anonymous',
      acknowledgedEvents: [],
      localServerPath: NON_CANONICAL_DIR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(hasSessionWriteInDirectory).mockReturnValue(true);

    const result = await hook(makeHookInput({
      args: {
        name: 'fibonacci',
        command: `node ${NON_CANONICAL_SCRIPT_PATH}`,
        args: [NON_CANONICAL_SCRIPT_PATH],
      },
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
    expect(updateContribution).not.toHaveBeenCalled();
  });

  it('skips non-canonical fallback synthesis when args.name is missing', async () => {
    vi.mocked(hasSessionWriteInDirectory).mockReturnValue(true);

    const result = await hook(makeHookInput({
      args: {
        command: `node ${NON_CANONICAL_SCRIPT_PATH}`,
        args: [NON_CANONICAL_SCRIPT_PATH],
      },
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
    const missingNameWarn = loggerMocks.warn.mock.calls.find(
      ([entry]) => (entry as { reason?: string } | undefined)?.reason === 'add-server-missing-name',
    );
    expect(missingNameWarn).toBeTruthy();
  });

  // 4. Wrong tool_id → skipped
  it('skips tool calls with wrong tool_id', async () => {
    const result = await hook(makeHookInput({
      tool_id: 'RebelMcpConnectors__rebel_mcp_remove_server',
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
  });

  // 5. Non-use_tool tool call → skipped
  it('skips non-use_tool tool calls', async () => {
    const result = await hook(makeHookInput({
      tool_name: 'Write',
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
  });

  // 6. Genuine tool error (not timeout) → skipped
  it('skips tool calls that returned a genuine error (not timeout)', async () => {
    const result = await hook(makeHookInput({
      isError: true,
      output: 'MCP tool error: some actual failure',
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
  });

  // 6b. Timeout error → still creates contribution (known Super-MCP restart pattern)
  it('creates contribution even when tool times out (Super-MCP restart pattern)', async () => {
    const result = await hook(makeHookInput({
      isError: true,
      output: 'MCP tool error [code=-32001]: Request timed out\nContext: {"timeout":120000} (tool: use_tool)',
    }));

    expect(result).toEqual({});
    expect(createContribution).toHaveBeenCalledOnce();
  });

  // 6c. Connection lost error → still creates contribution
  it('creates contribution even when tool connection was lost', async () => {
    const result = await hook(makeHookInput({
      isError: true,
      output: 'Tool connection was lost during execution of RebelMcpConnectors/rebel_mcp_add_server. This action may have already been performed.',
    }));

    expect(result).toEqual({});
    expect(createContribution).toHaveBeenCalledOnce();
  });

  // 7. Idempotent: existing contribution → no duplicate
  it('does not create duplicate when contribution already exists with ready_to_submit', async () => {
    const existingRecord = {
      id: 'contrib-existing',
      sessionId: SESSION_ID,
      linkedSessionIds: [SESSION_ID],
      connectorName: 'My Connector',
      status: 'ready_to_submit' as const,
      attributionMode: 'anonymous' as const,
      acknowledgedEvents: [],
      localServerPath: CONNECTOR_DIR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(getContributionByPath).mockReturnValue(existingRecord);
    vi.mocked(getActiveContributionBySession).mockReturnValue(existingRecord);

    const result = await hook(makeHookInput());

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
    expect(updateContribution).not.toHaveBeenCalled();
  });

  // 8. Status guard: existing draft → no update beyond side-data
  it('does not update contribution in draft status (no side-data divergence)', async () => {
    const existingRecord = {
      id: 'contrib-draft',
      sessionId: SESSION_ID,
      linkedSessionIds: [SESSION_ID],
      connectorName: 'My Connector',
      status: 'draft' as const,
      attributionMode: 'anonymous' as const,
      acknowledgedEvents: [],
      localServerPath: CONNECTOR_DIR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(getContributionByPath).mockReturnValue(existingRecord);
    vi.mocked(getActiveContributionBySession).mockReturnValue(existingRecord);

    const result = await hook(makeHookInput());

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
    // Stage 3.E: side-data updates only fire when name/path differ. Here
    // the mock pre-seeds matching values so no update is triggered.
    expect(updateContribution).not.toHaveBeenCalled();
  });

  // 9. Status guard: existing testing → updates to ready_to_submit
  it('updates contribution from testing to ready_to_submit', async () => {
    const existingRecord = {
      id: 'contrib-testing',
      sessionId: SESSION_ID,
      linkedSessionIds: [SESSION_ID],
      connectorName: 'Old Name',
      status: 'testing' as const,
      attributionMode: 'anonymous' as const,
      acknowledgedEvents: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(getContributionByPath).mockReturnValue(existingRecord);
    vi.mocked(getActiveContributionBySession).mockReturnValue(existingRecord);

    const result = await hook(makeHookInput());

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
    // Stage 4: side-data sync goes through updateContribution (name + path
    // differ); promotion goes through the promotion service as an
    // `add-server-observer` operational signal.
    expect(updateContribution).toHaveBeenCalledWith('contrib-testing', {
      connectorName: 'My Connector',
      localServerPath: CONNECTOR_DIR,
    });
    // Stage 3.E: observation pipeline replaces the legacy promotion signal.
    expect(observeContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'server_registered',
        sessionId: SESSION_ID,
        localServerPath: CONNECTOR_DIR,
        source: 'post-tool-add-server',
      }),
    );
  });

  it('clears stale non-canonical-path error when add_server corrects path back to canonical', async () => {
    const existingRecord = {
      id: 'contrib-stale-error',
      sessionId: SESSION_ID,
      linkedSessionIds: [SESSION_ID],
      connectorName: 'Old Name',
      status: 'testing' as const,
      attributionMode: 'anonymous' as const,
      acknowledgedEvents: [],
      localServerPath: NON_CANONICAL_DIR,
      lastTransitionError: JSON.stringify({
        reason: 'non-canonical-path',
        observedPath: NON_CANONICAL_DIR,
      }),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(getContributionByPath).mockReturnValue(existingRecord);
    vi.mocked(getActiveContributionBySession).mockReturnValue(existingRecord);

    const result = await hook(makeHookInput());

    expect(result).toEqual({});
    expect(updateContribution).toHaveBeenCalledWith('contrib-stale-error', {
      connectorName: 'My Connector',
      localServerPath: CONNECTOR_DIR,
      lastTransitionError: undefined,
    });
  });

  // 10. Status guard: existing submitted → no regression
  it('does not regress contribution from submitted status', async () => {
    const existingRecord = {
      id: 'contrib-submitted',
      sessionId: SESSION_ID,
      linkedSessionIds: [SESSION_ID],
      connectorName: 'My Connector',
      status: 'submitted' as const,
      attributionMode: 'anonymous' as const,
      acknowledgedEvents: [],
      localServerPath: CONNECTOR_DIR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(getContributionByPath).mockReturnValue(existingRecord);
    vi.mocked(getActiveContributionBySession).mockReturnValue(existingRecord);

    const result = await hook(makeHookInput());

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
    expect(updateContribution).not.toHaveBeenCalled();
  });

  // 11. Tilde expansion in path
  it('handles tilde expansion in args paths', async () => {
    const result = await hook(makeHookInput({
      args: {
        name: 'Tilde Connector',
        command: 'node',
        args: ['~/mcp-servers/tilde-connector/dist/index.js'],
      },
    }));

    expect(result).toEqual({});
    expect(createContribution).toHaveBeenCalledOnce();
    expect(createContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorName: 'Tilde Connector',
        localServerPath: path.join(HOME_PATH, 'mcp-servers', 'tilde-connector'),
      }),
    );
  });

  // 12. Derives connector directory from deep script path
  it('derives connector directory from deep nested script path', async () => {
    const deepPath = path.join(HOME_PATH, 'mcp-servers', 'deep-connector', 'src', 'build', 'dist', 'server.js');

    const result = await hook(makeHookInput({
      args: {
        name: 'Deep Connector',
        command: 'node',
        args: [deepPath],
      },
    }));

    expect(result).toEqual({});
    expect(createContribution).toHaveBeenCalledOnce();
    expect(createContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorName: 'Deep Connector',
        localServerPath: path.join(HOME_PATH, 'mcp-servers', 'deep-connector'),
      }),
    );
  });

  // Additional edge cases

  it('handles use_tool tool name without MCP prefix', async () => {
    const result = await hook(makeHookInput({
      tool_name: 'use_tool',
    }));

    expect(result).toEqual({});
    expect(createContribution).toHaveBeenCalledOnce();
  });

  it('skips when tool_id does not end with rebel_mcp_add_server', async () => {
    const result = await hook(makeHookInput({
      tool_id: 'SomeOtherPackage__some_other_tool',
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
  });

  it('skips tool_id that ends with rebel_mcp_add_server but without __ delimiter', async () => {
    const result = await hook(makeHookInput({
      tool_id: 'SomePkg_custom_rebel_mcp_add_server',
    }));

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
  });

  it('skips when args is missing from tool_input', async () => {
    const result = await hook({
      tool_name: 'mcp__super-mcp-router__use_tool',
      tool_input: {
        tool_id: 'RebelMcpConnectors__rebel_mcp_add_server',
        package_id: 'RebelMcpConnectors',
        // no args field
      },
      tool_response: { output: '{}', isError: false },
      tool_use_id: 'tool-use-abc',
    });

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
  });

  it('returns {} even when contribution store throws', async () => {
    vi.mocked(getContributionByPath).mockImplementation(() => {
      throw new Error('Store unavailable');
    });
    vi.mocked(getActiveContributionBySession).mockImplementation(() => {
      throw new Error('Store unavailable');
    });

    const result = await hook(makeHookInput());

    expect(result).toEqual({});
    expect(createContribution).not.toHaveBeenCalled();
  });

  it('uses "Unknown Connector" when name is not a string', async () => {
    const result = await hook(makeHookInput({
      args: {
        name: 42,
        command: 'node',
        args: [SCRIPT_PATH],
      },
    }));

    expect(result).toEqual({});
    expect(createContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorName: 'Unknown Connector',
      }),
    );
  });

  // ─── File-Write Detection Tests ─────────────────────────────────

  describe('file-write detection', () => {
    function makeWriteInput(filePath: string) {
      return {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'console.log("hello")' },
        tool_response: { output: 'File written', isError: false },
        tool_use_id: 'tool-write-1',
      };
    }

    it('does NOT create contribution for file writes (too early — fires on scaffolding)', async () => {
      const filePath = path.join(HOME_PATH, 'mcp-servers', 'coda-mcp', 'src', 'index.ts');
      const result = await hook(makeWriteInput(filePath));

      expect(result).toEqual({});
      expect(createContribution).not.toHaveBeenCalled();
    });

    it('does NOT create contribution for Create tool under ~/mcp-servers/', async () => {
      const filePath = path.join(HOME_PATH, 'mcp-servers', 'slack-mcp', 'package.json');
      const result = await hook({
        tool_name: 'Create',
        tool_input: { file_path: filePath, content: '{}' },
        tool_response: { output: 'File created', isError: false },
        tool_use_id: 'tool-create-1',
      });

      expect(result).toEqual({});
      expect(createContribution).not.toHaveBeenCalled();
    });

    it('does NOT create contribution for Edit tool under ~/mcp-servers/', async () => {
      const filePath = path.join(HOME_PATH, 'mcp-servers', 'notion-mcp', 'src', 'index.ts');
      const result = await hook({
        tool_name: 'Edit',
        tool_input: { file_path: filePath, old_str: 'foo', new_str: 'bar' },
        tool_response: { output: 'File edited', isError: false },
        tool_use_id: 'tool-edit-1',
      });

      expect(result).toEqual({});
      expect(createContribution).not.toHaveBeenCalled();
    });
  });

  // ─── Bash Detection Tests ───────────────────────────────────────

  describe('bash command detection', () => {
    function makeBashInput(command: string, isError = false) {
      return {
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: { output: 'ok', isError },
        tool_use_id: 'tool-bash-1',
      };
    }

    it('does NOT create contribution for mkdir (scaffolding, not a build)', async () => {
      const result = await hook(makeBashInput('mkdir -p ~/mcp-servers/coda-mcp/src'));

      expect(result).toEqual({});
      expect(createContribution).not.toHaveBeenCalled();
    });

    it('does NOT create contribution for npm install (dependency install, not a build)', async () => {
      const result = await hook(makeBashInput('cd ~/mcp-servers/clockify-mcp && npm install'));

      expect(result).toEqual({});
      expect(createContribution).not.toHaveBeenCalled();
    });

    it('emits build_detected observation for npm run build in ~/mcp-servers/', async () => {
      const result = await hook(makeBashInput('cd ~/mcp-servers/clockify-mcp && npm run build'));

      expect(result).toEqual({});
      // Stage 3.E: file-detection routes through observeContribution.
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'build_detected',
          connectorName: 'clockify-mcp',
          localServerPath: path.join(HOME_PATH, 'mcp-servers', 'clockify-mcp'),
          source: 'post-tool-bash',
        }),
      );
    });

    it('emits build_detected observation for npx tsc in ~/mcp-servers/', async () => {
      const result = await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npx tsc'));

      expect(result).toEqual({});
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'build_detected',
          connectorName: 'coda-mcp',
          source: 'post-tool-bash',
        }),
      );
    });

    it('promotes testing to ready_to_submit when npm test succeeds in ~/mcp-servers/', async () => {
      // Simulate existing contribution at testing — Stage 2.D path-first.
      const existingRecord = {
        id: 'contrib-testing',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'coda-mcp',
        status: 'testing' as const,
        attributionMode: 'anonymous' as const,
        acknowledgedEvents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(getContributionByPath).mockReturnValue(existingRecord);
      vi.mocked(getActiveContributionBySession).mockReturnValue(existingRecord);

      const result = await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npm test 2>&1'));

      expect(result).toEqual({});
      // Stage 4: side-data (localServerPath) is updated directly, promotion
      // routes through the promotion service as a `test-pass` evidence signal.
      expect(updateContribution).toHaveBeenCalledWith('contrib-testing', {
        localServerPath: path.join(HOME_PATH, 'mcp-servers', 'coda-mcp'),
      });
      // Stage 3.E: test-pass signal routes through observeContribution.
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'test_passed',
          sessionId: SESSION_ID,
          localServerPath: path.join(HOME_PATH, 'mcp-servers', 'coda-mcp'),
          source: 'post-tool-bash',
        }),
      );
    });

    it('does not promote when test command fails', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue({
        id: 'contrib-testing',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'coda-mcp',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npm test 2>&1', true));

      expect(result).toEqual({});
      expect(updateContribution).not.toHaveBeenCalled();
    });

    it('does not promote when contribution is not at testing status', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue({
        id: 'contrib-ready',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'coda-mcp',
        status: 'ready_to_submit',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npm test'));

      expect(result).toEqual({});
      expect(updateContribution).not.toHaveBeenCalled();
    });

    it('does not promote for non-test Bash commands', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue({
        id: 'contrib-testing',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'coda-mcp',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npm run build'));

      expect(result).toEqual({});
      expect(updateContribution).not.toHaveBeenCalled();
    });

    it('skips Bash commands that do not reference mcp-servers/ or connectors/', async () => {
      const result = await hook(makeBashInput('ls -la /tmp'));

      expect(result).toEqual({});
      expect(createContribution).not.toHaveBeenCalled();
    });

    it('emits build_detected for Bash with relative mcp-servers/ path and build command', async () => {
      const result = await hook(makeBashInput('cd mcp-servers/typeform && npm run build'));

      expect(result).toEqual({});
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'build_detected', connectorName: 'typeform' }),
      );
    });

    it('does NOT observe for relative mcp-servers/ path without build command', async () => {
      const result = await hook(makeBashInput('cd mcp-servers/typeform && npm install'));

      expect(result).toEqual({});
      expect(observeContribution).not.toHaveBeenCalled();
    });

    it('skips errored Bash build commands', async () => {
      const result = await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npm run build', true));

      expect(result).toEqual({});
      expect(observeContribution).not.toHaveBeenCalled();
    });

    it('routes both build commands through observeContribution; reducer dedupes idempotently', async () => {
      await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npm run build'));
      expect(observeContribution).toHaveBeenCalledTimes(1);

      vi.mocked(getActiveContributionBySession).mockReturnValue({
        id: 'contrib-1',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'coda-mcp',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Stage 3.E: a subsequent build_detected fires another observation;
      // the reducer (not the hook) decides whether it's a noop.
      await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npm run build'));
      expect(observeContribution).toHaveBeenCalledTimes(2);
    });

    // ─── Stage 2.D cross-session linking ─────────────────────────

    it('Stage 2.D: cross-session test-pass — path-first lookup wins, addLinkedSession appends current session', async () => {
      const codaPath = path.join(HOME_PATH, 'mcp-servers', 'coda-mcp');
      // Path-first lookup returns a record owned by ANOTHER session.
      vi.mocked(getContributionByPath).mockReturnValue({
        id: 'contrib-cross',
        sessionId: 'session-original',
        linkedSessionIds: ['session-original'],
        connectorName: 'coda-mcp',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: codaPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      // Session-fallback returns nothing — path-first must win.
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);

      await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npm test 2>&1'));

      // Stage 3.E: cross-session link is recorded inside observeContribution
      // (no longer here in handleTestPassPromotion). The hook routes the
      // test-pass signal to observation; the observation pipeline owns
      // path-first lookup + linked session append.
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'test_passed',
          sessionId: SESSION_ID,
        }),
      );
    });

    it('Stage 2.D: idempotent — addLinkedSession not called when current session already linked', async () => {
      const codaPath = path.join(HOME_PATH, 'mcp-servers', 'coda-mcp');
      vi.mocked(getContributionByPath).mockReturnValue({
        id: 'contrib-already-linked',
        sessionId: 'session-original',
        linkedSessionIds: ['session-original', SESSION_ID],
        connectorName: 'coda-mcp',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: codaPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);

      await hook(makeBashInput('cd ~/mcp-servers/coda-mcp && npm test 2>&1'));

      // Already linked — no second append.
      expect(addLinkedSession).not.toHaveBeenCalled();
    });
  });

  // ─── Connector Repo Clone Detection Tests ───────────────────────

  describe('connector repo clone detection (arbitrary paths)', () => {
    const CLONE_PATH = '/Users/testuser/development/mcp-servers-humaans-hello';
    const CONNECTOR_DIR = path.join(CLONE_PATH, 'connectors', 'humaans');
    const VALID_PKG = JSON.stringify({
      name: '@mindstone-engineering/mcp-server-humaans',
      version: '1.0.0',
    });

    function setupValidConnectorRepo() {
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s === path.join(CONNECTOR_DIR, 'package.json');
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
        const s = String(p);
        if (s === path.join(CONNECTOR_DIR, 'package.json')) return VALID_PKG;
        throw new Error('File not found');
      });
    }

    function makeWriteInput(filePath: string) {
      return {
        tool_name: 'Write',
        tool_input: { file_path: filePath, content: 'console.log("hello")' },
        tool_response: { output: 'File written', isError: false },
        tool_use_id: 'tool-write-1',
      };
    }

    function makeBashInput(command: string) {
      return {
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: { output: 'ok', isError: false },
        tool_use_id: 'tool-bash-1',
      };
    }

    it('does NOT create contribution for Write to connector repo clone (file writes disabled)', async () => {
      setupValidConnectorRepo();
      const filePath = path.join(CONNECTOR_DIR, 'src', 'tools', 'hello.ts');
      const result = await hook(makeWriteInput(filePath));

      expect(result).toEqual({});
      expect(createContribution).not.toHaveBeenCalled();
    });

    it('emits build_detected for build command in connector repo clone', async () => {
      setupValidConnectorRepo();
      const command = `cd ${CONNECTOR_DIR} && npm run build`;
      const result = await hook(makeBashInput(command));

      expect(result).toEqual({});
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'build_detected',
          connectorName: 'humaans',
          localServerPath: CONNECTOR_DIR,
        }),
      );
    });

    it('does NOT observe build_detected for npm test in connector repo clone (test, not build)', async () => {
      setupValidConnectorRepo();
      const command = `cd ${CONNECTOR_DIR} && npm test 2>&1`;
      const result = await hook(makeBashInput(command));

      expect(result).toEqual({});
      // npm test fires test_passed when an existing record matches; here
      // there's no existing record so observeContribution would be called
      // but it would noop. We only assert it's NOT a build_detected.
      const buildCalls = vi.mocked(observeContribution).mock.calls.filter(
        ([obs]) => (obs as { kind?: string }).kind === 'build_detected',
      );
      expect(buildCalls).toHaveLength(0);
    });

    it('promotes testing to ready_to_submit when npm test succeeds in connector repo clone', async () => {
      setupValidConnectorRepo();
      const existingRecord = {
        id: 'contrib-testing-clone',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'humaans',
        status: 'testing' as const,
        attributionMode: 'anonymous' as const,
        acknowledgedEvents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(getContributionByPath).mockReturnValue(existingRecord);
      vi.mocked(getActiveContributionBySession).mockReturnValue(existingRecord);

      const command = `cd ${CONNECTOR_DIR} && npm test 2>&1`;
      const result = await hook(makeBashInput(command));

      expect(result).toEqual({});
      // Stage 3.E: side-data only; observation pipeline owns the signal.
      expect(updateContribution).toHaveBeenCalledWith('contrib-testing-clone', {
        localServerPath: CONNECTOR_DIR,
      });
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'test_passed',
          sessionId: SESSION_ID,
          localServerPath: CONNECTOR_DIR,
        }),
      );
    });

    it('does NOT observe build_detected for Bash heredoc write to connector repo clone (not a build)', async () => {
      setupValidConnectorRepo();
      const command = `cat > ${CONNECTOR_DIR}/test/hello.test.ts << 'HEREDOC'\nconsole.log("test")\nHEREDOC`;
      const result = await hook(makeBashInput(command));

      expect(result).toEqual({});
      expect(observeContribution).not.toHaveBeenCalled();
    });

    it('skips connector path when package.json is missing', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const filePath = path.join(CLONE_PATH, 'connectors', 'fake', 'src', 'index.ts');
      const result = await hook(makeWriteInput(filePath));

      expect(result).toEqual({});
      expect(observeContribution).not.toHaveBeenCalled();
    });

    it('skips connector path when package name is not recognized', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        name: '@some-other-org/mcp-server-foo',
        version: '1.0.0',
      }));

      const filePath = path.join(CLONE_PATH, 'connectors', 'foo', 'src', 'index.ts');
      const result = await hook(makeWriteInput(filePath));

      expect(result).toEqual({});
      expect(observeContribution).not.toHaveBeenCalled();
    });

    it('accepts @mindstone-ai package via build command', async () => {
      const aiConnectorDir = path.join(CLONE_PATH, 'connectors', 'ai-connector');
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        return String(p) === path.join(aiConnectorDir, 'package.json');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        name: '@mindstone-ai/mcp-server-ai-connector',
      }));

      const result = await hook(makeBashInput(`cd ${aiConnectorDir} && npm run build`));

      expect(result).toEqual({});
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'build_detected' }),
      );
    });

    it('accepts @mindstone package via build command', async () => {
      const msConnectorDir = path.join(CLONE_PATH, 'connectors', 'ms-connector');
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        return String(p) === path.join(msConnectorDir, 'package.json');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        name: '@mindstone/mcp-server-ms-connector',
      }));

      const result = await hook(makeBashInput(`cd ${msConnectorDir} && npm run build`));

      expect(result).toEqual({});
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'build_detected' }),
      );
    });

    it('handles tilde paths in connector repo clones via build command', async () => {
      const tildeConnectorDir = path.join(HOME_PATH, 'dev', 'my-fork', 'connectors', 'slack');
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        return String(p) === path.join(tildeConnectorDir, 'package.json');
      });
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        name: '@mindstone-engineering/mcp-server-slack',
      }));

      const result = await hook(makeBashInput(`cd ~/dev/my-fork/connectors/slack && npm run build`));

      expect(result).toEqual({});
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'build_detected',
          connectorName: 'slack',
          localServerPath: tildeConnectorDir,
        }),
      );
    });

    it('prefers ~/mcp-servers/ detection over connector repo clone detection', async () => {
      const result = await hook(makeBashInput(`cd ~/mcp-servers/my-connector/connectors/nested && npm run build`));

      expect(result).toEqual({});
      // Should use 'my-connector' from ~/mcp-servers/ (Strategy 1), not 'nested'
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'build_detected',
          connectorName: 'my-connector',
        }),
      );
    });
  });

  // ─── Stage 4b Fix 1: Nested-path misclassification ──────────────

  describe('Stage 4b Fix 1: nested-path connector detection', () => {
    // Exercised via the rebel_mcp_add_server path, which passes its path arg
    // through findMcpServerPath -> detectMcpServerPath -> isUnderMcpServers.
    // localServerPath is the observable (path.basename gives the name the
    // task wants to verify; we check localServerPath directly so case
    // preservation is visible).

    it('extracts connector identity from connectors/<name>/ anywhere under ~/mcp-servers/ (src/index.ts)', async () => {
      const result = await hook(makeHookInput({
        args: {
          name: 'Fathom',
          command: 'node',
          args: ['/Users/testuser/mcp-servers/connectors/fathom/src/index.ts'],
        },
      }));
      expect(result).toEqual({});
      expect(createContribution).toHaveBeenCalledWith(expect.objectContaining({
        connectorName: 'Fathom',
        localServerPath: '/Users/testuser/mcp-servers/connectors/fathom',
      }));
    });

    it('extracts connector identity from connectors/<name>/package.json', async () => {
      const result = await hook(makeHookInput({
        args: {
          name: 'Fathom',
          command: 'node',
          args: ['/Users/testuser/mcp-servers/connectors/fathom/package.json'],
        },
      }));
      expect(result).toEqual({});
      expect(createContribution).toHaveBeenCalledWith(expect.objectContaining({
        localServerPath: '/Users/testuser/mcp-servers/connectors/fathom',
      }));
    });

    it('falls back to first-segment-under-mcp-servers for paths without connectors/<name>/ (baseline)', async () => {
      const result = await hook(makeHookInput({
        args: {
          name: 'Foo',
          command: 'node',
          args: ['/Users/testuser/mcp-servers/foo-mcp/src/index.ts'],
        },
      }));
      expect(result).toEqual({});
      expect(createContribution).toHaveBeenCalledWith(expect.objectContaining({
        localServerPath: '/Users/testuser/mcp-servers/foo-mcp',
      }));
    });

    it('handles fork-clone paths like ~/mcp-servers/<repo>/connectors/<name>/ and preserves case', async () => {
      const result = await hook(makeHookInput({
        args: {
          name: 'MyConnector',
          command: 'node',
          args: ['/Users/testuser/mcp-servers/MyRepo/connectors/MyConnector/src/index.ts'],
        },
      }));
      expect(result).toEqual({});
      // Fix 1 preserves case from the source path for the connectors-nested
      // detection (matching detectConnectorRepoPath convention).
      expect(createContribution).toHaveBeenCalledWith(expect.objectContaining({
        localServerPath: '/Users/testuser/mcp-servers/MyRepo/connectors/MyConnector',
      }));
    });

    it('creates no contribution when connectors/<name>/ is outside ~/mcp-servers/ without a valid package.json', async () => {
      const result = await hook(makeHookInput({
        args: {
          name: 'Foo',
          command: 'node',
          args: ['/some/unrelated/connectors/foo/src/index.ts'],
        },
      }));
      expect(result).toEqual({});
      expect(createContribution).not.toHaveBeenCalled();
    });
  });

  // ─── Stage 4b Fix 2: findMcpServerPath inspects args.command ────

  describe('Stage 4b Fix 2: findMcpServerPath scans args.command', () => {
    it('extracts path from args.command when args.args has no path', async () => {
      const result = await hook(makeHookInput({
        args: {
          name: 'Foo',
          command: 'node /Users/testuser/mcp-servers/foo/dist/index.js',
          args: ['--port=3000'],
        },
      }));
      expect(result).toEqual({});
      expect(createContribution).toHaveBeenCalledWith(expect.objectContaining({
        localServerPath: '/Users/testuser/mcp-servers/foo',
      }));
    });

    it('extracts tilde path from args.command', async () => {
      const result = await hook(makeHookInput({
        args: {
          name: 'Bar',
          command: 'node ~/mcp-servers/bar/index.js',
        },
      }));
      expect(result).toEqual({});
      expect(createContribution).toHaveBeenCalledWith(expect.objectContaining({
        localServerPath: '/Users/testuser/mcp-servers/bar',
      }));
    });

    it('still finds path from args.args (baseline unchanged)', async () => {
      const result = await hook(makeHookInput({
        args: {
          name: 'Baz',
          command: 'node',
          args: ['/Users/testuser/mcp-servers/baz'],
        },
      }));
      expect(result).toEqual({});
      expect(createContribution).toHaveBeenCalledWith(expect.objectContaining({
        localServerPath: '/Users/testuser/mcp-servers/baz',
      }));
    });

    it('creates no contribution when args.command is unrelated', async () => {
      const result = await hook(makeHookInput({
        args: {
          name: 'External',
          command: 'ls /tmp',
        },
      }));
      expect(result).toEqual({});
      expect(createContribution).not.toHaveBeenCalled();
    });
  });

  // ─── Stage 4b Fix 3: Bash detection inspects cwd ────────────────

  describe('Stage 4b Fix 3: Bash detection inspects tool_input.cwd', () => {
    function makeBashInputWithCwd(command: string, cwd: string | undefined, isError = false) {
      return {
        tool_name: 'Bash',
        tool_input: cwd !== undefined ? { command, cwd } : { command },
        tool_response: { output: 'ok', isError },
        tool_use_id: 'tool-bash-cwd-1',
      };
    }

    it('emits build_detected when only cwd points at ~/mcp-servers/<name>', async () => {
      const result = await hook(makeBashInputWithCwd('npm run build', '/Users/testuser/mcp-servers/quote-api'));
      expect(result).toEqual({});
      expect(observeContribution).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'build_detected',
        connectorName: 'quote-api',
        localServerPath: '/Users/testuser/mcp-servers/quote-api',
      }));
    });

    it('emits build_detected for pnpm build when cwd is nested connectors/<name>/', async () => {
      const result = await hook(makeBashInputWithCwd('pnpm build', '/Users/testuser/mcp-servers/connectors/fathom'));
      expect(result).toEqual({});
      expect(observeContribution).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'build_detected',
        connectorName: 'fathom',
        localServerPath: '/Users/testuser/mcp-servers/connectors/fathom',
      }));
    });

    it('prefers command-string extraction when both command and cwd are available (Strategy 1 precedence)', async () => {
      const result = await hook(makeBashInputWithCwd('cd ~/mcp-servers/bar && npm run build', '/tmp'));
      expect(result).toEqual({});
      expect(observeContribution).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'build_detected',
        connectorName: 'bar',
      }));
    });

    it('emits no observation when neither command nor cwd reference mcp-servers', async () => {
      const result = await hook(makeBashInputWithCwd('ls /tmp', '/tmp'));
      expect(result).toEqual({});
      expect(observeContribution).not.toHaveBeenCalled();
    });
  });

  // ─── Stage 3.E (260426): the entire "Stage 4b Fix 4: evidence-only
  //     extend-flow recovery" describe block was deleted. The recovery
  //     hook is structurally unnecessary in Stage 3 because the reducer's
  //     predicate is explicit (`lastReadyRequestedAt + (lastTestPassedAt
  //     OR lastRegisteredAt) + fingerprintMatches`).

  describe('Stage 2 SE task detection wiring in runPromotionSweep', () => {
    function makeSweepContribution(): ConnectorContribution {
      return {
        id: 'contrib-se-sensor',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'sensor-connector',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: path.join(HOME_PATH, 'mcp-servers', 'sensor-connector'),
        turnIndexWindow: {
          sessionId: SESSION_ID,
          startTurn: 2,
          endTurn: null,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    it('prefers active-turn accumulator over persisted events when both are possible', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue(makeSweepContribution());
      const shape = {
        messages: [],
        eventsByTurn: {},
        activeTurnId: 'turn-active',
        isBusy: true,
        lastError: null,
        lastErrorSource: null,
        terminatedTurnIds: new Set<string>(),
      };
      vi.mocked(agentTurnRegistry.getActiveTurnForSession).mockReturnValue('turn-active');
      vi.mocked(agentTurnRegistry.getContextAccumulator).mockReturnValue(shape as any);
      vi.mocked(extractTaskEventsFromConversationShape).mockReturnValue([]);
      vi.mocked(detectSoftwareEngineerTaskCompletion).mockReturnValue({
        found: true,
        taskSubagentTypes: ['software-engineer'],
        observedAt: { sessionId: SESSION_ID, turnIndex: 7 },
      });

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      expect(extractTaskEventsFromConversationShape).toHaveBeenCalledWith(shape);
      expect(extractTaskEventsFromPersistedEvents).not.toHaveBeenCalled();
      const seCalls = vi.mocked(observeContribution).mock.calls
        .map(([arg]) => arg)
        .filter((arg) => arg.kind === 'software_engineer_task_completed');
      expect(seCalls).toHaveLength(1);
      expect(seCalls[0]).toMatchObject({
        kind: 'software_engineer_task_completed',
        contributionId: 'contrib-se-sensor',
        taskSubagentTypes: ['software-engineer'],
        observedAt: { sessionId: SESSION_ID, turnIndex: 7 },
        source: 'post-turn-sweep',
      });
    });

    it('falls back to persisted session events when no active turn accumulator exists', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue(makeSweepContribution());
      vi.mocked(agentTurnRegistry.getActiveTurnForSession).mockReturnValue(undefined);
      vi.mocked(sessionStoreMocks.getSession).mockResolvedValue({
        eventsByTurn: { 'turn-persisted': [] },
      } as any);
      vi.mocked(extractTaskEventsFromPersistedEvents).mockReturnValue([]);
      vi.mocked(detectSoftwareEngineerTaskCompletion).mockReturnValue({
        found: true,
        taskSubagentTypes: ['se-implementer'],
        observedAt: { sessionId: SESSION_ID, turnIndex: 9 },
      });

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      expect(sessionStoreMocks.getSession).toHaveBeenCalledWith(SESSION_ID);
      expect(extractTaskEventsFromConversationShape).not.toHaveBeenCalled();
      expect(extractTaskEventsFromPersistedEvents).toHaveBeenCalledWith({
        'turn-persisted': [],
      });
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'software_engineer_task_completed',
          contributionId: 'contrib-se-sensor',
          taskSubagentTypes: ['se-implementer'],
          observedAt: { sessionId: SESSION_ID, turnIndex: 9 },
        }),
      );
    });
  });

  describe('runPromotionSweep canonical-path gates', () => {
    beforeEach(() => {
      vi.stubEnv('HOME', HOME_PATH);
      vi.stubEnv('USERPROFILE', 'C:\\Users\\testuser');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('Case 1 gate-off: forwards ready_requested with enforceSoftwareEngineerEvidence=false', async () => {
      setSeEvidenceGateEnabled(false);
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'foo');
      vi.mocked(getActiveContributionBySession).mockReturnValue({
        id: 'contrib-case1-gate-off',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'foo',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: fooPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [path.join(fooPath, 'dist', 'index.js')],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      const readyCall = vi.mocked(observeContribution).mock.calls.find(
        ([obs]) => (obs as { kind?: string }).kind === 'ready_requested',
      );
      expect(readyCall?.[1]).toEqual({ enforceSoftwareEngineerEvidence: false });
    });

    it('Case 1 gate-on: missing_se_evidence deferral writes synthetic transition error', async () => {
      setSeEvidenceGateEnabled(true);
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'foo');
      const existing: ConnectorContribution = {
        id: 'contrib-case1-gate-on',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'foo',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: fooPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(getActiveContributionBySession).mockReturnValue(existing);
      vi.mocked(getContributionById).mockReturnValue(existing);
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [path.join(fooPath, 'dist', 'index.js')],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);
      vi.mocked(observeContribution).mockImplementation(async (obs: { kind?: string }) => {
        if (obs.kind === 'ready_requested') {
          return {
            decision: 'deferred',
            reason: 'missing_se_evidence',
            promoted: false,
            fingerprintMismatch: false,
            contributionId: existing.id,
          } as Awaited<ReturnType<typeof observeContribution>>;
        }
        return {
          decision: 'updated',
          reason: 'mocked',
          promoted: false,
          fingerprintMismatch: false,
        } as Awaited<ReturnType<typeof observeContribution>>;
      });

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      const readyCall = vi.mocked(observeContribution).mock.calls.find(
        ([obs]) => (obs as { kind?: string }).kind === 'ready_requested',
      );
      expect(readyCall?.[1]).toEqual({ enforceSoftwareEngineerEvidence: true });
      const syntheticWrite = vi.mocked(updateContribution).mock.calls.find(
        ([id, patch]) =>
          id === existing.id
          && typeof (patch as { lastTransitionError?: unknown }).lastTransitionError === 'string',
      );
      expect(syntheticWrite).toBeDefined();
    });

    it('Case 2 gate-on: auto-created testing record writes synthetic transition error on missing_se_evidence', async () => {
      setSeEvidenceGateEnabled(true);
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'foo');
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
      vi.mocked(getContributionByPath).mockReturnValue(undefined);
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [path.join(fooPath, 'dist', 'index.js')],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);
      vi.spyOn(fs, 'statSync').mockImplementation(
        () => ({ mtimeMs: Date.now() }) as unknown as fs.Stats,
      );
      const created: ConnectorContribution = {
        id: 'contrib-case2-created',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'foo',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: fooPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(createContribution).mockReturnValue(created);
      vi.mocked(getContributionById).mockReturnValue(created);
      vi.mocked(observeContribution).mockImplementation(async (obs: { kind?: string }) => {
        if (obs.kind === 'ready_requested') {
          return {
            decision: 'deferred',
            reason: 'missing_se_evidence',
            promoted: false,
            fingerprintMismatch: false,
            contributionId: created.id,
          } as Awaited<ReturnType<typeof observeContribution>>;
        }
        return {
          decision: 'updated',
          reason: 'mocked',
          promoted: false,
          fingerprintMismatch: false,
        } as Awaited<ReturnType<typeof observeContribution>>;
      });

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      expect(createContribution).toHaveBeenCalledWith(expect.objectContaining({
        status: 'testing',
      }));
      const readyCall = vi.mocked(observeContribution).mock.calls.find(
        ([obs]) => (obs as { kind?: string }).kind === 'ready_requested',
      );
      expect(readyCall?.[1]).toEqual({ enforceSoftwareEngineerEvidence: true });
      const syntheticWrite = vi.mocked(updateContribution).mock.calls.find(
        ([id, patch]) =>
          id === created.id
          && typeof (patch as { lastTransitionError?: unknown }).lastTransitionError === 'string',
      );
      expect(syntheticWrite).toBeDefined();
    });

    it('Case 2 gate-off: ready_requested observation carries enforceSoftwareEngineerEvidence=false', async () => {
      setSeEvidenceGateEnabled(false);
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'foo');
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
      vi.mocked(getContributionByPath).mockReturnValue(undefined);
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [path.join(fooPath, 'dist', 'index.js')],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);
      vi.spyOn(fs, 'statSync').mockImplementation(
        () => ({ mtimeMs: Date.now() }) as unknown as fs.Stats,
      );
      const created: ConnectorContribution = {
        id: 'contrib-case2-gate-off',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'foo',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: fooPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(createContribution).mockReturnValue(created);

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      expect(createContribution).toHaveBeenCalledWith(expect.objectContaining({
        status: 'testing',
      }));
      const readyCall = vi.mocked(observeContribution).mock.calls.find(
        ([obs]) => (obs as { kind?: string }).kind === 'ready_requested',
      );
      expect(readyCall?.[1]).toEqual({ enforceSoftwareEngineerEvidence: false });
    });

    it('flag flip OFF→ON reconciles ready_to_submit records by writing synthetic missing_se_evidence errors', async () => {
      const readyRecord: ConnectorContribution = {
        id: 'contrib-ready-reconcile',
        sessionId: 'other-session',
        linkedSessionIds: ['other-session'],
        connectorName: 'reconcile-me',
        status: 'ready_to_submit',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: path.join(HOME_PATH, 'mcp-servers', 'reconcile-me'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
      vi.mocked(getMcpServerNames).mockResolvedValue([]);
      vi.mocked(getContributionById).mockReturnValue(readyRecord);
      vi.mocked(listContributions).mockReturnValue([readyRecord]);

      setSeEvidenceGateEnabled(false);
      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);
      expect(updateContribution).not.toHaveBeenCalled();

      setSeEvidenceGateEnabled(true);
      await promoteTestingContributionIfRegistered(SESSION_ID);

      const reconcileWrite = vi.mocked(updateContribution).mock.calls.find(
        ([id, patch]) =>
          id === readyRecord.id
          && typeof (patch as { lastTransitionError?: unknown }).lastTransitionError === 'string',
      );
      expect(reconcileWrite).toBeDefined();
    });

    it('Case 1: skips promotion when existing testing record path class is unknown', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue({
        id: 'contrib-case1-unknown',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'relative-connector',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: './relative/path',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      expect(observeContribution).not.toHaveBeenCalled();
      const gateWarn = loggerMocks.warn.mock.calls.find(
        ([entry]) => (entry as { gate?: string } | undefined)?.gate === 'runPromotionSweep-case1',
      );
      expect(gateWarn?.[0]).toMatchObject({
        reason: 'contribution-path-non-canonical',
        gate: 'runPromotionSweep-case1',
        sessionId: SESSION_ID,
        contributionId: 'contrib-case1-unknown',
        classification: 'unknown',
      });
    });

    it('Case 1: exact-name registration with mismatched path does NOT promote', async () => {
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'foo-mcp');
      vi.mocked(getActiveContributionBySession).mockReturnValue({
        id: 'contrib-case1-name-only-mismatch',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'foo-mcp',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: fooPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo-mcp']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [path.join(HOME_PATH, 'mcp-servers', 'bar-mcp', 'server.js')],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      expect(observeContribution).not.toHaveBeenCalled();
      expect(updateContribution).not.toHaveBeenCalled();
    });

    it('Case 1: path match promotes and updates connectorName to the matched registration name', async () => {
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'foo-mcp');
      vi.mocked(getActiveContributionBySession).mockReturnValue({
        id: 'contrib-case1-path-match',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'foo-mcp',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        localServerPath: fooPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo-mcp-clone']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [path.join(fooPath, 'dist', 'index.js')],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      expect(updateContribution).toHaveBeenCalledWith('contrib-case1-path-match', {
        connectorName: 'foo-mcp-clone',
      });
      // Stage 3.E: post-turn-sweep routes through observeContribution.
      expect(observeContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          localServerPath: fooPath,
          source: 'post-turn-sweep',
        }),
      );
    });

    it('Case 1: pathless testing record skips observation gracefully (no path → no observation)', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue({
        id: 'contrib-case1-pathless',
        sessionId: SESSION_ID,
        linkedSessionIds: [SESSION_ID],
        connectorName: 'foo-mcp',
        status: 'testing',
        attributionMode: 'anonymous',
        acknowledgedEvents: [],
        // Intentionally no localServerPath — bridge can create pathless
        // testing records when an early ingress signal arrives without a path.
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo-mcp']);

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      // Stage 3.E: pathless records can't observe (observation requires a
      // path). The sweep recognises the registration but skips
      // observeContribution gracefully — a future report-state with a path
      // will rendezvous via path-first lookup.
      expect(observeContribution).not.toHaveBeenCalled();
      // Canonical-path gate should NOT fire for pathless records.
      const gateWarn = loggerMocks.warn.mock.calls.find(
        ([entry]) => (entry as { gate?: string } | undefined)?.gate === 'runPromotionSweep-case1',
      );
      expect(gateWarn).toBeUndefined();
    });

    it('Case 2: does not auto-create ready_to_submit when classifier marks candidate server path as non-canonical', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
      vi.mocked(getMcpServerNames).mockResolvedValue(['my-connector']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [SCRIPT_PATH],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);
      vi.spyOn(fs, 'statSync').mockImplementation(
        () => ({ mtimeMs: Date.now() }) as unknown as fs.Stats,
      );

      const originalClassify = contributionPathClassifier.classifyContributionPath;
      const classifySpy = vi
        .spyOn(contributionPathClassifier, 'classifyContributionPath')
        .mockImplementation((value) => {
          if (value === CONNECTOR_DIR) return 'non-canonical';
          return originalClassify(value);
        });

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);
      classifySpy.mockRestore();

      expect(createContribution).not.toHaveBeenCalled();
      const gateWarn = loggerMocks.warn.mock.calls.find(
        ([entry]) => (entry as { gate?: string } | undefined)?.gate === 'runPromotionSweep-case2',
      );
      expect(gateWarn?.[0]).toMatchObject({
        reason: 'contribution-path-non-canonical',
        gate: 'runPromotionSweep-case2',
        sessionId: SESSION_ID,
        connectorName: 'my-connector',
        classification: 'non-canonical',
      });
    });

    // ─── Stage 2.D matrix #5 closure ─────────────────────────────

    it('Case 2: processes multiple untracked servers in one sweep (no early break)', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'foo');
      const barPath = path.join(HOME_PATH, 'mcp-servers', 'bar');
      const bazPath = path.join(HOME_PATH, 'mcp-servers', 'baz');
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo', 'bar', 'baz']);
      vi.mocked(readMcpServerDetails).mockImplementation(async (_configPath: string, name: string) => {
        const map: Record<string, string> = { foo: fooPath, bar: barPath, baz: bazPath };
        return { args: [path.join(map[name], 'dist', 'index.js')] } as unknown as Awaited<
          ReturnType<typeof readMcpServerDetails>
        >;
      });
      vi.spyOn(fs, 'statSync').mockImplementation(
        () => ({ mtimeMs: Date.now() }) as unknown as fs.Stats,
      );

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      // All three untracked servers should produce contributions.
      expect(createContribution).toHaveBeenCalledTimes(3);
      const calls = vi.mocked(createContribution).mock.calls.map((c) => c[0].connectorName);
      expect(calls.sort()).toEqual(['bar', 'baz', 'foo']);
    });

    it('Case 2: in-batch dedupe — two servers resolving to the same canonical path produce ONE contribution', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
      // Two MCP-config entries pointing at the same connectorDir but with
      // different connector names. canonicalizeConnectorPath returns the
      // same key for both → second one must be skipped by `seenCanonicalPaths`.
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'foo');
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo-a', 'foo-b']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [path.join(fooPath, 'dist', 'index.js')],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);
      vi.spyOn(fs, 'statSync').mockImplementation(
        () => ({ mtimeMs: Date.now() }) as unknown as fs.Stats,
      );

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      // Only ONE contribution created — second server skipped.
      expect(createContribution).toHaveBeenCalledTimes(1);
    });

    it('Case 2: cross-session — getContributionByPath hit appends to linkedSessionIds (matrix #3 hook)', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'cross-session-foo');
      vi.mocked(getMcpServerNames).mockResolvedValue(['cross-session-foo']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [path.join(fooPath, 'dist', 'index.js')],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);
      vi.spyOn(fs, 'statSync').mockImplementation(
        () => ({ mtimeMs: Date.now() }) as unknown as fs.Stats,
      );
      const existingRecord = {
        id: 'contrib-cross-session',
        sessionId: 'session-original',
        linkedSessionIds: ['session-original'],
        connectorName: 'cross-session-foo',
        status: 'ready_to_submit' as const,
        attributionMode: 'anonymous' as const,
        acknowledgedEvents: [],
        localServerPath: fooPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      vi.mocked(getContributionByPath).mockReturnValue(existingRecord);

      // Case 2 currently does not call addLinkedSession — it just skips
      // creation. This test pins the contract so we don't accidentally
      // start double-creating.
      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      expect(createContribution).not.toHaveBeenCalled();
    });

    it('Case 2: defence-in-depth — getContributionByPath hit during sweep skips creation', async () => {
      vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
      const fooPath = path.join(HOME_PATH, 'mcp-servers', 'foo');
      vi.mocked(getMcpServerNames).mockResolvedValue(['foo']);
      vi.mocked(readMcpServerDetails).mockResolvedValue({
        args: [path.join(fooPath, 'dist', 'index.js')],
      } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);
      vi.spyOn(fs, 'statSync').mockImplementation(
        () => ({ mtimeMs: Date.now() }) as unknown as fs.Stats,
      );
      // Simulate a concurrent ingress that already created a record at this
      // canonical path AFTER `customServers` was built but BEFORE the
      // creation step.
      vi.mocked(getContributionByPath).mockImplementation((p: string) => {
        // canonicalizeConnectorPath in our mock just normalizes slashes/lowercase.
        if (p && p.includes('mcp-servers/foo')) {
          return {
            id: 'contrib-concurrent',
            sessionId: 'other-session',
            linkedSessionIds: ['other-session'],
            connectorName: 'foo',
            status: 'ready_to_submit',
            attributionMode: 'anonymous',
            acknowledgedEvents: [],
            localServerPath: fooPath,
            canonicalConnectorPath: p,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        }
        return undefined;
      });

      const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
      await promoteTestingContributionIfRegistered(SESSION_ID);

      // No contribution created — defence-in-depth check caught the race.
      expect(createContribution).not.toHaveBeenCalled();
    });
  });
});

// ─── Stage 3.E mock-backend integration tests (#23-27) ───────────
//
// These tests cover the four-ingress-routes invariant, dual-claim race
// behaviour, boot-time sweep population, and the subagent-throwaway path.
// They route through the real production callsites (post-tool-bash hook +
// post-turn sweep + add_server) and assert observation-pipeline calls; the
// underlying observeContribution remains mocked so we can assert call shape
// without dragging the full Stage 3 reducer + store into scope.

describe('Stage 3.E mock-backend integration (#23-27)', () => {
  const SESSION_ID_3E = 'session-stage3e';
  const HOME_PATH_3E = '/Users/testuser';
  const CODA_DIR = `${HOME_PATH_3E}/mcp-servers/coda-mcp`;

  let hook: ReturnType<typeof createMcpBuildAutoDetectHook>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSeEvidenceFlagTrackingForTest();
    setSeEvidenceGateEnabled(false);
    vi.stubEnv('HOME', HOME_PATH_3E);
    vi.stubEnv('USERPROFILE', 'C:\\Users\\testuser');
    vi.mocked(getPlatformConfig).mockReturnValue({ homePath: HOME_PATH_3E } as ReturnType<typeof getPlatformConfig>);
    vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
    vi.mocked(getContributionByPath).mockReturnValue(undefined);
    vi.mocked(addLinkedSession).mockImplementation((() => undefined) as never);
    hook = createMcpBuildAutoDetectHook({ sessionId: SESSION_ID_3E });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function makeBashInput(command: string, isError = false) {
    return {
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: { output: 'ok', isError },
      tool_use_id: 'tool-bash-stage3e',
    };
  }

  // #23: four-ingress-routes invariant
  it('#23: fires four observation kinds against the same path; each lands with its source', async () => {
    // Pre-seed registration mocks BEFORE any ingress so all paths see a
    // consistent MCP config view of the connector.
    vi.mocked(getMcpServerNames).mockResolvedValue(['coda-mcp']);
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: [`${CODA_DIR}/dist/index.js`],
    } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);

    // Ingress 1: post-tool-bash build_detected (no record yet).
    await hook(makeBashInput(`cd ~/mcp-servers/coda-mcp && npm run build`));

    // Ingress 2: post-tool-bash test_passed against an existing testing record.
    const existingTesting = {
      id: 'contrib-stage3e',
      sessionId: SESSION_ID_3E,
      linkedSessionIds: [SESSION_ID_3E],
      connectorName: 'coda-mcp',
      status: 'testing' as const,
      attributionMode: 'anonymous' as const,
      acknowledgedEvents: [],
      localServerPath: CODA_DIR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(getContributionByPath).mockReturnValue(existingTesting);
    vi.mocked(getActiveContributionBySession).mockReturnValue(existingTesting);
    await hook(makeBashInput(`cd ~/mcp-servers/coda-mcp && npm test`));

    // Ingress 3: post-tool-add-server server_registered.
    const addServerHookInput = {
      tool_name: 'mcp__super-mcp-router__use_tool',
      tool_input: {
        tool_id: 'RebelMcpConnectors__rebel_mcp_add_server',
        package_id: 'RebelMcpConnectors',
        args: {
          name: 'coda-mcp',
          command: 'node',
          args: [`${CODA_DIR}/dist/index.js`],
        },
      },
      tool_response: { output: '{"success": true}', isError: false },
      tool_use_id: 'tool-add-server-stage3e',
    };
    await hook(addServerHookInput);

    // Ingress 4: post-turn-sweep server_registered.
    const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
    await promoteTestingContributionIfRegistered(SESSION_ID_3E);

    // Assert each kind + source is present (each ingress lands its own
    // observation; deduping is the reducer's responsibility, mocked here).
    const calls = vi.mocked(observeContribution).mock.calls;
    const sources = calls.map(([obs]) => (obs as { source?: string }).source);
    expect(sources).toContain('post-tool-bash'); // build_detected + test_passed
    expect(sources).toContain('post-tool-add-server');
    expect(sources).toContain('post-turn-sweep');

    const kinds = calls.map(([obs]) => (obs as { kind?: string }).kind);
    expect(kinds).toContain('build_detected');
    expect(kinds).toContain('test_passed');
    expect(kinds).toContain('server_registered');
  });

  // #24: dual-claim race — same session, two paths claim same connector name
  it('#24: dual-claim race — same session, two distinct canonical paths produce two distinct observations', async () => {
    // Same session + connector name + two different canonical paths.
    const PATH_A = `${HOME_PATH_3E}/mcp-servers/coda-mcp`;
    const PATH_B = `${HOME_PATH_3E}/dev/fork/connectors/coda-mcp`;
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p) === `${PATH_B}/package.json`;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      name: '@mindstone-engineering/mcp-server-coda-mcp',
    }));

    await hook(makeBashInput(`cd ${PATH_A} && npm run build`));
    await hook(makeBashInput(`cd ${PATH_B} && npm run build`));

    const observedPaths = vi.mocked(observeContribution).mock.calls
      .filter(([obs]) => (obs as { kind?: string }).kind === 'build_detected')
      .map(([obs]) => (obs as { localServerPath?: string }).localServerPath);
    // Two distinct paths fired separately — Stage 2.B canonical path keys
    // distinguish them; the reducer (mocked here) is responsible for
    // owning the dual-claim semantics, but each ingress lands its own
    // observation — no cross-contamination.
    expect(observedPaths).toContain(PATH_A);
    expect(observedPaths).toContain(PATH_B);
  });

  // #25: dual-claim race — two sessions, same path, concurrent ready_requested
  it('#25: dual-claim race — two sessions hit same canonical path concurrently via post-turn-sweep', async () => {
    const existing = {
      id: 'contrib-stage3e-shared',
      sessionId: 'session-A',
      linkedSessionIds: ['session-A'],
      connectorName: 'coda-mcp',
      status: 'testing' as const,
      attributionMode: 'anonymous' as const,
      acknowledgedEvents: [],
      localServerPath: CODA_DIR,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(getActiveContributionBySession).mockReturnValue(existing);
    vi.mocked(getContributionByPath).mockReturnValue(existing);
    vi.mocked(getMcpServerNames).mockResolvedValue(['coda-mcp']);
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: [`${CODA_DIR}/dist/index.js`],
    } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);

    const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
    // Two sessions race on the same path concurrently.
    await Promise.all([
      promoteTestingContributionIfRegistered('session-A'),
      promoteTestingContributionIfRegistered('session-B'),
    ]);

    // Both sessions fired observations against the same canonical path.
    // The reducer (mocked) is responsible for serialising via mutex; the
    // hook layer simply forwards both. No double createContribution.
    const observeCalls = vi.mocked(observeContribution).mock.calls.filter(
      ([obs]) => (obs as { source?: string }).source === 'post-turn-sweep',
    );
    expect(observeCalls.length).toBeGreaterThanOrEqual(1);
    expect(createContribution).not.toHaveBeenCalled();
  });

  // #26: boot-time sweep populates readiness on existing testing records
  // NOTE: this assertion is exercised in `contributionStartupSweep.test.ts`
  // since the boot-sweep is a separate entrypoint. Here we assert the
  // mcpBuildAutoDetectHook does NOT silently fire post-turn-sweep observations
  // for a fresh app boot before any agent activity (record is at testing,
  // but the sweep is the boot-sweep's responsibility, not this hook's).
  it('#26: post-turn sweep does not auto-fire on app start with no agent activity', async () => {
    // Hook is created but no tool input fired — no observations should
    // happen.
    expect(observeContribution).not.toHaveBeenCalled();
    expect(createContribution).not.toHaveBeenCalled();
  });

  // #27: subagent throwaway via post-turn-sweep
  it('#27: subagent throwaway — parent never reports state; post-turn-sweep fires server_registered with source post-turn-sweep', async () => {
    // No active contribution (subagent did the work; parent never saw it).
    vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
    vi.mocked(getContributionByPath).mockReturnValue(undefined);
    // MCP config DOES have an entry (subagent registered it).
    vi.mocked(getMcpServerNames).mockResolvedValue(['coda-mcp']);
    vi.mocked(readMcpServerDetails).mockResolvedValue({
      args: [`${CODA_DIR}/dist/index.js`],
    } as unknown as Awaited<ReturnType<typeof readMcpServerDetails>>);
    // Recency: pretend the file was just modified.
    vi.spyOn(fs, 'statSync').mockImplementation(
      () => ({ mtimeMs: Date.now() }) as unknown as fs.Stats,
    );
    // Allow Case 2 path classifier through.
    vi.spyOn(
      contributionPathClassifier,
      'classifyContributionPath',
    ).mockReturnValue('canonical');

    const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
    await promoteTestingContributionIfRegistered(SESSION_ID_3E);

    // Case 2 path: post-turn sweep creates a testing record first, then
    // routes registration/readiness through observations. Per matrix #1
    // closure, the sweep is the safety net for the subagent-throwaway flow.
    expect(createContribution).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID_3E,
        status: 'testing',
      }),
    );
  });
});

// Stage 0.5 addition: waitForPendingPromotion lets evals/tests synchronize on the
// post-turn sweep, which is fire-and-forget in production (agentTurnExecutor.ts).
describe('waitForPendingPromotion (Stage 0.5)', () => {
  it('resolves immediately when no sweep is in-flight for the session', async () => {
    const { waitForPendingPromotion } = await import('../mcpBuildAutoDetectHook');
    // No promotion has been started — should resolve without hanging.
    await expect(waitForPendingPromotion('unknown-session')).resolves.toBeUndefined();
  });

  it('awaits an in-flight sweep for the given session and clears after settle', async () => {
    const { promoteTestingContributionIfRegistered, waitForPendingPromotion } = await import('../mcpBuildAutoDetectHook');
    // The sweep will try to resolve the MCP config path; with our mocks it will
    // fast-return, but the Promise still has to microtask-settle. waitForPendingPromotion
    // MUST observe the in-flight promise and only resolve once it finishes.
    const sweep = promoteTestingContributionIfRegistered('test-session-wait');
    const waitPromise = waitForPendingPromotion('test-session-wait');
    await sweep;
    await expect(waitPromise).resolves.toBeUndefined();
    // A second wait after settle should be a no-op.
    await expect(waitForPendingPromotion('test-session-wait')).resolves.toBeUndefined();
  });
});

// ─── Self-block follow-on (260427) — Sub-stage C ────────────────────
//
// The post-turn sweep gains a new branch that detects "agent built and
// tested but never registered" records and stamps the one-shot
// `stuckRegistrationNudgeFiredAt` flag. The system-reminder builder
// reads the flag on the next turn and emits a one-line nudge.
// Plan: docs/plans/260427_contribution_flow_followon_self_block_at_registration.md § C

describe('runPromotionSweep stuck-registration backstop (sub-stage C)', () => {
  beforeEach(() => {
    // Reset mocks per-test so call-count assertions are isolated.
    // Mirrors the outer describe's beforeEach (the new describe is a
    // sibling, not nested, so it doesn't inherit the reset).
    vi.clearAllMocks();
    _resetSeEvidenceFlagTrackingForTest();
    setSeEvidenceGateEnabled(false);
    vi.mocked(getPlatformConfig).mockReturnValue({ homePath: HOME_PATH } as ReturnType<typeof getPlatformConfig>);
    vi.mocked(getActiveContributionBySession).mockReturnValue(undefined);
    vi.mocked(getContributionByPath).mockReturnValue(undefined);
    vi.mocked(getContributionsBySession).mockReturnValue([]);
  });

  const STUCK_SESSION = 'session-stuck-c';
  const STUCK_PATH = '/Users/testuser/mcp-servers/quote-api';
  const STUCK_CANONICAL = STUCK_PATH.toLowerCase();

  function makeStuckRecord(overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    return {
      id: 'contrib-stuck-c',
      sessionId: STUCK_SESSION,
      linkedSessionIds: [STUCK_SESSION],
      connectorName: 'quote-api',
      status: 'testing' as const,
      attributionMode: 'anonymous' as const,
      acknowledgedEvents: [],
      localServerPath: STUCK_PATH,
      canonicalConnectorPath: STUCK_CANONICAL,
      lastBuildDetectedAt: now,
      lastTestPassedAt: now,
      // No `lastRegisteredAt` — that's the stuck signal.
      // No `stuckRegistrationNudgeFiredAt` — fresh, awaiting first detection.
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it('predicate satisfied → fires the flag exactly once', async () => {
    vi.mocked(getContributionsBySession).mockReturnValue([
      makeStuckRecord(),
    ] as unknown as ReturnType<typeof getContributionsBySession>);
    vi.mocked(getContributionByPath).mockReturnValue(
      makeStuckRecord() as unknown as ReturnType<typeof getContributionByPath>,
    );

    const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
    await promoteTestingContributionIfRegistered(STUCK_SESSION);

    expect(markStuckRegistrationNudgeFired).toHaveBeenCalledTimes(1);
    expect(markStuckRegistrationNudgeFired).toHaveBeenCalledWith(
      'contrib-stuck-c',
      expect.any(String),
    );
    const breadcrumbWarn = loggerMocks.warn.mock.calls.find(
      ([entry]) =>
        (entry as { breadcrumb?: string } | undefined)?.breadcrumb
          === 'stuck-registration-nudge-fired',
    );
    expect(breadcrumbWarn).toBeTruthy();
  });

  it('idempotency — flag already set → does NOT re-fire on subsequent sweeps', async () => {
    const already = makeStuckRecord({
      stuckRegistrationNudgeFiredAt: new Date().toISOString(),
    });
    vi.mocked(getContributionsBySession).mockReturnValue([
      already,
    ] as unknown as ReturnType<typeof getContributionsBySession>);

    const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
    await promoteTestingContributionIfRegistered(STUCK_SESSION);

    expect(markStuckRegistrationNudgeFired).not.toHaveBeenCalled();
  });

  it('predicate fails — lastTestPassedAt missing → flag NOT set', async () => {
    const partial = makeStuckRecord({ lastTestPassedAt: undefined });
    vi.mocked(getContributionsBySession).mockReturnValue([
      partial,
    ] as unknown as ReturnType<typeof getContributionsBySession>);

    const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
    await promoteTestingContributionIfRegistered(STUCK_SESSION);

    expect(markStuckRegistrationNudgeFired).not.toHaveBeenCalled();
  });

  it('predicate fails — lastRegisteredAt set (already registered) → flag NOT set', async () => {
    const registered = makeStuckRecord({
      lastRegisteredAt: new Date().toISOString(),
    });
    vi.mocked(getContributionsBySession).mockReturnValue([
      registered,
    ] as unknown as ReturnType<typeof getContributionsBySession>);

    const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
    await promoteTestingContributionIfRegistered(STUCK_SESSION);

    expect(markStuckRegistrationNudgeFired).not.toHaveBeenCalled();
  });

  it('cross-session safety — record linked to a different session only → flag NOT set on this session', async () => {
    // The record's `linkedSessionIds` only contains `session-other`; the
    // sweep runs for `STUCK_SESSION`. Even if `getContributionsBySession`
    // somehow returned the record (e.g. via a future relaxed lookup), the
    // hook's predicate must guard against firing.
    const otherSessionRecord = makeStuckRecord({
      linkedSessionIds: ['session-other'],
    });
    vi.mocked(getContributionsBySession).mockReturnValue([
      otherSessionRecord,
    ] as unknown as ReturnType<typeof getContributionsBySession>);

    const { promoteTestingContributionIfRegistered } = await import('../mcpBuildAutoDetectHook');
    await promoteTestingContributionIfRegistered(STUCK_SESSION);

    expect(markStuckRegistrationNudgeFired).not.toHaveBeenCalled();
  });

  it('post-flag-clear semantics — once lastRegisteredAt is set, subsequent reminder is silent', async () => {
    const { buildStuckRegistrationReminder } = await import('../mcpBuildAutoDetectHook');
    // The flag was fired earlier, but this turn the agent registered
    // (lastRegisteredAt set). The reminder builder must NOT inject for
    // this record.
    vi.mocked(getContributionsBySession).mockReturnValue([
      makeStuckRecord({
        stuckRegistrationNudgeFiredAt: new Date().toISOString(),
        lastRegisteredAt: new Date().toISOString(),
      }),
    ] as unknown as ReturnType<typeof getContributionsBySession>);

    const reminder = buildStuckRegistrationReminder(STUCK_SESSION);
    expect(reminder).toBeUndefined();
  });

  it('reminder builder — flag set + not yet registered → emits <system-reminder> with connector name', async () => {
    const { buildStuckRegistrationReminder } = await import('../mcpBuildAutoDetectHook');
    vi.mocked(getContributionsBySession).mockReturnValue([
      makeStuckRecord({
        stuckRegistrationNudgeFiredAt: new Date().toISOString(),
      }),
    ] as unknown as ReturnType<typeof getContributionsBySession>);

    const reminder = buildStuckRegistrationReminder(STUCK_SESSION);
    expect(reminder).toMatch(/^<system-reminder>/);
    expect(reminder).toMatch(/<\/system-reminder>$/);
    expect(reminder).toContain('quote-api');
    expect(reminder).toContain('rebel_mcp_add_server');
    expect(reminder).toContain('skill invocation is consent');
  });
});
