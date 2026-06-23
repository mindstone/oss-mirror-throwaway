/**
 * Tests for systemHealthService.runSystemHealthCheck.
 *
 * Primary goal: ensure every key in the returned `checks` object is populated
 * (not undefined). This catches destructuring mismatches between the
 * Promise.all results array and the checks object — the exact class of bug
 * where a new check is added to Promise.all but forgotten in the destructuring.
 */

import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — stub every external dependency so runSystemHealthCheck can execute
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user-data'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
  },
}));

vi.mock('../../sentry', () => ({
  setHealthContext: vi.fn(),
  setHealthContextUpdater: vi.fn(),
  captureMainException: vi.fn(),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  // `@core/services/settingsStore` exports function-style getters/setters
  // (see src/core/services/settingsStore.ts). conversationHistoryService.ts
  // imports `getSettings` directly, so without the mock entry any transitive
  // import of that module from a health check crashes with "SettingsStoreAdapter
  // not initialized" during test collection.
  getSettings: vi.fn(() => ({}) as unknown as import('@shared/types').AppSettings),
  updateSettings: vi.fn(),
}));

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/mock/user-data',
  getAppVersion: () => '0.0.0-test',
  isPackaged: () => false,
}));

vi.mock('@main/utils/buildChannel', () => ({
  getBuildChannel: () => 'dev',
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerMocks,
}));

vi.mock('../systemSettingsSync', () => ({
  getAppSystemSettingsVersion: () => '1.0.0',
  getSystemSettingsPath: () => '/mock/system-settings-path',
}));

vi.mock('../superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: () => ({ isRunning: false, port: null }),
  },
  findAvailablePort: vi.fn(async () => 3200),
}));

vi.mock('../mcpService', () => ({
  resolveMcpConfigPath: () => null,
}));

// Stub every individual health check to return a passing result.
// The check name is embedded in the id for traceability.
const makePassResult = (id: string) => ({
  id,
  name: id,
  status: 'pass' as const,
  message: `${id} ok`,
});

vi.mock('../health', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    safeCheck: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    // Filesystem
    checkUserDataWritable: vi.fn(async () => makePassResult('userDataWritable')),
    checkWorkspaceAccessible: vi.fn(async () => makePassResult('workspaceAccessible')),
    checkDiskSpace: vi.fn(async () => makePassResult('diskSpace')),
    checkSymlinkHealth: vi.fn(async () => makePassResult('symlinkHealth')),
    checkTempDirectoryHealth: vi.fn(async () => makePassResult('tempDirectoryHealth')),
    // MCP
    checkMcpConfigValid: vi.fn(async () => makePassResult('mcpConfigValid')),
    checkSuperMcpHealth: vi.fn(async () => makePassResult('superMcpHealth')),
    checkBundledServers: vi.fn(async () => makePassResult('bundledServers')),
    checkMcpSkippedServers: vi.fn(async () => makePassResult('mcpSkippedServers')),
    // Network
    checkAnthropicReachable: vi.fn(async () => makePassResult('anthropicReachable')),
    // System
    checkNodeBundleHealth: vi.fn(async () => makePassResult('nodeBundleHealth')),
    checkMsvcRuntimeHealth: vi.fn(async () => makePassResult('msvcRuntimeHealth')),
    checkEnvOverrides: vi.fn(async () => makePassResult('envOverrides')),
    checkPortAvailable: vi.fn(async () => makePassResult('portAvailable')),
    checkGitBashHealth: vi.fn(async () => makePassResult('gitBashHealth')),
    checkPowerShellHealth: vi.fn(async () => makePassResult('powerShellHealth')),
    // Sync
    checkRebelSystemPresent: vi.fn(async () => makePassResult('rebelSystemPresent')),
    checkRebelSystemSyncStatus: vi.fn(async () => makePassResult('rebelSystemSyncStatus')),
    // Permissions
    checkMicrophonePermission: vi.fn(async () => makePassResult('microphonePermission')),
    checkScreenRecordingPermission: vi.fn(async () => makePassResult('screenRecordingPermission')),
    checkWorkspacePathIssues: vi.fn(async () => makePassResult('workspacePathIssues')),
    checkFullDiskAccess: vi.fn(async () => makePassResult('fullDiskAccess')),
    // API Keys
    checkClaudeApiKeyValid: vi.fn(async () => makePassResult('claudeApiKeyValid')),
    checkVoiceApiKeyValid: vi.fn(async () => makePassResult('voiceApiKeyValid')),
    // Prompt
    checkSystemPromptRenders: vi.fn(async () => makePassResult('systemPromptRenders')),
    checkSafetyPromptExists: vi.fn(async () => makePassResult('safetyPromptExists')),
    checkMemoryPromptExists: vi.fn(async () => makePassResult('memoryPromptExists')),
    checkSystemPromptCoherence: vi.fn(async () => makePassResult('systemPromptCoherence')),
    // Skills
    checkSkillsConvention: vi.fn(async () => makePassResult('skillsConvention')),
    // Semantic search
    checkEmbeddingServiceReady: vi.fn(async () => makePassResult('embeddingServiceReady')),
    checkSemanticIndexHealth: vi.fn(async () => makePassResult('semanticIndexHealth')),
    // Spaces
    checkSpaceReadmeSizes: vi.fn(async () => makePassResult('spaceReadmeSizes')),
    checkSpaceSharingConfig: vi.fn(async () => makePassResult('spaceSharingConfig')),
    checkBrokenSpaceFrontmatter: vi.fn(async () => makePassResult('brokenSpaceFrontmatter')),
    // Calendar
    checkCalendarCacheHealth: vi.fn(async () => makePassResult('calendarCacheHealth')),
    // Tool index
    checkToolIndexHealth: vi.fn(async () => makePassResult('toolIndexHealth')),
    // Enhancement
    checkEnhancementHealth: vi.fn(async () => makePassResult('enhancementHealth')),
    // Auth
    checkAuthHealth: vi.fn(async () => makePassResult('authHealth')),
    // Auto-update
    checkAutoUpdateHealth: vi.fn(async () => makePassResult('autoUpdateHealth')),
    // Inbox
    checkInboxHealth: vi.fn(async () => makePassResult('inboxHealth')),
    // Conversation index
    checkConversationIndexHealth: vi.fn(async () => makePassResult('conversationIndexHealth')),
    // Profile
    checkUserProfileComplete: vi.fn(async () => makePassResult('userProfileComplete')),
    // Conflicting copies
    checkConflictingCopies: vi.fn(async () => makePassResult('conflictingCopies')),
    // Cloud service
    checkCloudServiceHealth: vi.fn(async () => makePassResult('cloudServiceHealth')),
    // Prompt files
    checkPromptFilesExist: vi.fn(async () => makePassResult('promptFilesExist')),
    checkPromptFilesRender: vi.fn(async () => makePassResult('promptFilesRender')),
  };
});

vi.mock('../health/authHealthCheckRegistry', () => ({
  getAuthHealthCheck: () => vi.fn(async () => makePassResult('authHealth')),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
const {
  runSystemHealthCheck,
  updateSentryHealthContext,
  extractSafeCheckDetails,
  SAFE_CHECK_DETAIL_FIELDS,
} = await import('../systemHealthService');
const { safeCheck } = await import('../health');
const { setHealthContext } = await import('../../sentry');
const {
  SYSTEM_PROMPT_COHERENCE_TIMEOUT_MS,
  SYSTEM_PROMPT_COHERENCE_LLM_TIMEOUT_MS,
  SYSTEM_PROMPT_COHERENCE_HEADROOM_MS,
} = await import('../health/checks/prompt');
const {
  WORKSPACE_ACCESS_CHECK_TIMEOUT_MS,
  WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS,
  computeHealthWorkspaceWorstCaseMs,
} = await import('../health/checks/filesystem');
const { FS_TIMEOUT_CLOUD_MS } = await import('@core/utils/cloudStorageUtils');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_SETTINGS: AppSettings = {
  coreDirectory: '/mock/workspace',
  mcpConfigFile: null,
} as AppSettings;

// All keys that SystemHealthReport.checks must contain
const EXPECTED_CHECK_KEYS = [
  'userDataWritable',
  'workspaceAccessible',
  'rebelSystemPresent',
  'systemPromptRenders',
  'systemPromptCoherence',
  'safetyPromptExists',
  'memoryPromptExists',
  'claudeApiKeyValid',
  'nodeBundleHealth',
  'msvcRuntimeHealth',
  'mcpConfigValid',
  'bundledServers',
  'superMcpHealth',
  'microphonePermission',
  'screenRecordingPermission',
  'workspacePathIssues',
  'envOverrides',
  'symlinkHealth',
  'diskSpace',
  'portAvailable',
  'voiceApiKeyValid',
  'anthropicReachable',
  'rebelSystemSyncStatus',
  'tempDirectoryHealth',
  'gitBashHealth',
  'powerShellHealth',
  'skillsConvention',
  'embeddingServiceReady',
  'semanticIndexHealth',
  'spaceReadmeSizes',
  'spaceSharingConfig',
  'brokenSpaceFrontmatter',
  'calendarCacheHealth',
  'toolIndexHealth',
  'enhancementHealth',
  'mcpSkippedServers',
  'authHealth',
  'autoUpdateHealth',
  'inboxHealth',
  'conversationIndexHealth',
  'userProfileComplete',
  'conflictingCopies',
  'fullDiskAccess',
  'cloudServiceHealth',
  'promptFilesExist',
  'promptFilesRender',
  'apiCooldownHealth',
  'oauthRefreshHealth',
  'mcpRuntimeHealth',
  'toolAdvisoryHealth',
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSystemHealthCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a defined CheckResult for every expected key in checks', async () => {
    const report = await runSystemHealthCheck(MINIMAL_SETTINGS);

    for (const key of EXPECTED_CHECK_KEYS) {
      const check = report.checks[key];
      expect(check, `checks.${key} should be defined`).toBeDefined();
      expect(check.id, `checks.${key}.id should be a string`).toBeTypeOf('string');
      expect(check.status, `checks.${key}.status should be a valid status`).toMatch(
        /^(pass|warn|fail|skip)$/,
      );
    }
  });

  it('has no extra undefined values in the checks object', async () => {
    const report = await runSystemHealthCheck(MINIMAL_SETTINGS);

    const undefinedKeys = Object.entries(report.checks)
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);

    expect(undefinedKeys, 'No check key should have an undefined value').toEqual([]);
  });

  it('reports healthy status when all checks pass', async () => {
    const report = await runSystemHealthCheck(MINIMAL_SETTINGS);
    expect(report.status).toBe('healthy');
    expect(report.recommendations).toEqual([]);
  });

  it('includes correct top-level metadata', async () => {
    const report = await runSystemHealthCheck(MINIMAL_SETTINGS);
    expect(report.platform).toBe(process.platform);
    expect(report.appVersion).toBe('0.0.0-test');
    expect(report.isPackaged).toBe(false);
    expect(report.timestamp).toBeTypeOf('number');
  });

  it('calls safeCheck for systemPromptCoherence with explicit timeout override and maintains timeout invariant', async () => {
    expect(SYSTEM_PROMPT_COHERENCE_HEADROOM_MS).toBeGreaterThanOrEqual(5_000);
    expect(SYSTEM_PROMPT_COHERENCE_TIMEOUT_MS).toBe(
      SYSTEM_PROMPT_COHERENCE_LLM_TIMEOUT_MS + SYSTEM_PROMPT_COHERENCE_HEADROOM_MS
    );

    await runSystemHealthCheck(MINIMAL_SETTINGS);

    expect(safeCheck).toHaveBeenCalledWith(
      expect.any(Function),
      'systemPromptCoherence',
      'System Prompt Coherence',
      { timeoutMs: SYSTEM_PROMPT_COHERENCE_TIMEOUT_MS }
    );
  });

  it('wires workspaceAccessible with an explicit bounded timeout that covers its retry budget (Bug C — no wrapper/retry race)', async () => {
    // The wrapper timeout must be EXPLICIT (not the default 5s) and must exceed
    // the per-attempt local budget so safeCheck does not kill the check while its
    // own bounded retry policy is still legitimately running.
    expect(WORKSPACE_ACCESS_HEALTH_MAX_ATTEMPTS).toBeLessThan(3);
    expect(WORKSPACE_ACCESS_CHECK_TIMEOUT_MS).toBeGreaterThan(5_000);

    await runSystemHealthCheck(MINIMAL_SETTINGS);

    expect(safeCheck).toHaveBeenCalledWith(
      expect.any(Function),
      'workspaceAccessible',
      'Workspace Access',
      { timeoutMs: WORKSPACE_ACCESS_CHECK_TIMEOUT_MS }
    );
  });

  it('F1 budget invariant: the whole-call health budget (incl. cleanup) sits strictly inside the wrapper and covers a full cloud attempt', async () => {
    // The whole `probeWorkspaceAccess` HEALTH call — all attempts + backoffs + the
    // final cleanup — is structurally bounded by computeHealthWorkspaceWorstCaseMs.
    // The wrapper must STRICTLY exceed that bound (so the call always settles
    // before the safeCheck wrapper fires), and the bound must STRICTLY exceed a
    // single full cloud attempt (so a legit 15s cloud probe + cleanup completes).
    const worst = computeHealthWorkspaceWorstCaseMs();
    expect(worst).toBeLessThan(WORKSPACE_ACCESS_CHECK_TIMEOUT_MS);
    expect(worst).toBeGreaterThan(FS_TIMEOUT_CLOUD_MS);
    // And the wrapper still strictly exceeds the largest per-attempt budget.
    expect(WORKSPACE_ACCESS_CHECK_TIMEOUT_MS).toBeGreaterThan(FS_TIMEOUT_CLOUD_MS);
  });
});

// ---------------------------------------------------------------------------
// extractSafeCheckDetails
// ---------------------------------------------------------------------------

describe('extractSafeCheckDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts only allowlisted fields for a known check', () => {
    const details = {
      toolCount: 42,
      byServer: { GoogleWorkspace: 12, Slack: 5 },
      isInitialized: true,
      lastRefreshAt: '2026-03-27T00:00:00.000Z',
      etag: 'some-etag', // NOT in allowlist
    };
    const safe = extractSafeCheckDetails('toolIndexHealth', details);
    expect(safe).toEqual({
      toolCount: 42,
      byServer: { GoogleWorkspace: 12, Slack: 5 },
      isInitialized: true,
      lastRefreshAt: '2026-03-27T00:00:00.000Z',
    });
    // etag should NOT be included
    expect(safe).not.toHaveProperty('etag');
  });

  it('returns undefined for an unknown check (not in allowlist)', () => {
    const details = { userEmail: 'alice@example.com', isValid: true };
    expect(extractSafeCheckDetails('authHealth', details)).toBeUndefined();
  });

  it('returns undefined for checks that contain PII (profile, apiKeys)', () => {
    expect(extractSafeCheckDetails('userProfileComplete', { userFirstName: 'Alice' })).toBeUndefined();
    expect(extractSafeCheckDetails('claudeApiKeyValid', { keyPrefix: 'sk-...' })).toBeUndefined();
  });

  it('returns undefined when no allowlisted fields are present in details', () => {
    const details = { someOtherField: 'value' };
    expect(extractSafeCheckDetails('toolIndexHealth', details)).toBeUndefined();
  });

  it('extracts fields for bundledServers check', () => {
    const details = {
      present: ['RebelMeetings', 'RebelSettings'],
      missing: ['RebelInbox'],
      diagnostics: true,
      configPath: '/Users/alice/.config/mcp.json', // NOT in allowlist
    };
    const safe = extractSafeCheckDetails('bundledServers', details);
    expect(safe).toEqual({
      present: ['RebelMeetings', 'RebelSettings'],
      missing: ['RebelInbox'],
      diagnostics: true,
    });
    expect(safe).not.toHaveProperty('configPath');
  });

  it('extracts fields for mcpSkippedServers check', () => {
    const details = { skippedCount: 2, skippedList: ['BadServer1', 'BadServer2'] };
    const safe = extractSafeCheckDetails('mcpSkippedServers', details);
    expect(safe).toEqual({ skippedCount: 2 });
    expect(safe).not.toHaveProperty('skippedList');
  });

  it('extracts fields for apiCooldownHealth check', () => {
    const details = { scope: 'api', remainingMs: 60_000, untilMs: Date.now() + 60_000 };
    const safe = extractSafeCheckDetails('apiCooldownHealth', details);
    expect(safe).toEqual({ scope: 'api', remainingMs: 60_000 });
    expect(safe).not.toHaveProperty('untilMs');
  });

  it('extracts only consecutiveFailures for mcpRuntimeHealth check', () => {
    const details = { consecutiveFailures: 3, lastFailureMs: Date.now(), rawError: 'boom' };
    const safe = extractSafeCheckDetails('mcpRuntimeHealth', details);
    expect(safe).toEqual({ consecutiveFailures: 3 });
    expect(safe).not.toHaveProperty('lastFailureMs');
    expect(safe).not.toHaveProperty('rawError');
  });

  it('extracts only advisoryKindCounts for toolAdvisoryHealth check', () => {
    const details = {
      advisoryKindCounts: { hard_budget: 2, soft_budget: 1 },
      rawEvents: ['not safe'],
    };
    const safe = extractSafeCheckDetails('toolAdvisoryHealth', details);
    expect(safe).toEqual({ advisoryKindCounts: { hard_budget: 2, soft_budget: 1 } });
    expect(safe).not.toHaveProperty('rawEvents');
  });

  it('drops and logs advisoryKindCounts when advisory keys are outside the closed set', () => {
    expect(extractSafeCheckDetails('toolAdvisoryHealth', {
      advisoryKindCounts: { hard_budget: 2, user_supplied_kind: 1 },
    })).toBeUndefined();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        checkId: 'toolAdvisoryHealth',
        field: 'advisoryKindCounts',
        reason: 'all keys must be in the closed set',
      },
      'Dropped unsafe health check detail field from Sentry context',
    );
  });

  it('handles empty details object', () => {
    expect(extractSafeCheckDetails('toolIndexHealth', {})).toBeUndefined();
  });

  it('drops and logs non-conforming allowlisted values instead of passing them to Sentry', () => {
    const safe = extractSafeCheckDetails('bundledServers', {
      present: ['RebelInbox', 'alice@example.com'],
      missing: ['RebelMeetings'],
      diagnostics: true,
    });

    expect(safe).toEqual({
      missing: ['RebelMeetings'],
      diagnostics: true,
    });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      {
        checkId: 'bundledServers',
        field: 'present',
        reason: 'all values must be in the closed set',
      },
      'Dropped unsafe health check detail field from Sentry context',
    );
  });

  it.each([
    ['toolIndexHealth', { lastRefreshAt: 'alice@example.com' }, 'lastRefreshAt'],
    ['mcpSkippedServers', { skippedCount: '2' }, 'skippedCount'],
    ['apiCooldownHealth', { scope: 'alice@example.com', remainingMs: 60_000 }, 'scope'],
    [
      'oauthRefreshHealth',
      { connectorServerNames: ['GoogleWorkspace-alice-example-com'], providerCount: 1 },
      'connectorServerNames',
    ],
    ['mcpRuntimeHealth', { consecutiveFailures: '3' }, 'consecutiveFailures'],
    ['toolAdvisoryHealth', { advisoryKindCounts: { hard_budget: '2' } }, 'advisoryKindCounts'],
  ])('drops invalid safe-detail fields for %s', (checkId, details, invalidField) => {
    const safe = extractSafeCheckDetails(checkId, details);
    if (safe) {
      expect(safe).not.toHaveProperty(invalidField);
    } else {
      expect(safe).toBeUndefined();
    }
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ checkId, field: invalidField }),
      'Dropped unsafe health check detail field from Sentry context',
    );
  });

  it.each([
    ['toolIndexHealth', { lastRefreshAt: 'alice@example.com' }],
    ['mcpSkippedServers', { skippedCount: '2' }],
    ['mcpRuntimeHealth', { consecutiveFailures: '3' }],
    ['toolAdvisoryHealth', { advisoryKindCounts: { hard_budget: '2' } }],
  ])('returns undefined when every allowlisted field is invalid for %s', (checkId, details) => {
    expect(extractSafeCheckDetails(checkId, details)).toBeUndefined();
  });

  it('scrubs keyed-count keys only at the Sentry extraction chokepoint', () => {
    const details = {
      toolCount: 2,
      byServer: {
        'GoogleWorkspace-alice-example-com': 1,
        'bob@example.com': 1,
      },
    };

    const safe = extractSafeCheckDetails('toolIndexHealth', details);

    expect(details.byServer).toEqual({
      'GoogleWorkspace-alice-example-com': 1,
      'bob@example.com': 1,
    });
    expect(safe).toEqual({
      toolCount: 2,
      byServer: {
        'GoogleWorkspace-[account]': 1,
        '[email]': 1,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// updateSentryHealthContext
// ---------------------------------------------------------------------------

describe('updateSentryHealthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes the sibling toolIndexByServer Sentry field through the same key scrubber', async () => {
    const report = await runSystemHealthCheck(MINIMAL_SETTINGS);
    report.checks.toolIndexHealth = {
      id: 'toolIndexHealth',
      name: 'Tool Index',
      status: 'pass',
      message: 'ok',
      details: {
        toolCount: 2,
        byServer: {
          'GoogleWorkspace-alice-example-com': 1,
          'bob@example.com': 1,
        },
      },
    };

    updateSentryHealthContext(report);

    expect(setHealthContext).toHaveBeenCalledWith(
      expect.objectContaining({
        toolIndexByServer: {
          'GoogleWorkspace-[account]': 1,
          '[email]': 1,
        },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Sentry details-feed classification harness
// ---------------------------------------------------------------------------

describe('health-check detail Sentry-route harness', () => {
  it('classifies all direct systemHealthService details feeds as in-contract or exempt', async () => {
    const source = await readFile(new URL('../systemHealthService.ts', import.meta.url), 'utf8');

    expect(source).toContain('buildSafeCheckDetails(checks)');
    expect(source).toContain("extractSafeCheckDetails('toolIndexHealth'");
    expect(source).toContain('extractMsvcRuntimeDetailsForSentry(msvcRuntimeResult.details)');

    // Exempt-with-reason rows from PLAN.md Stage 1: local diagnostic log and renderer summary.
    expect(source).toContain('details: gitBashResult.details');
    expect(source).toContain('envOverrides: envOverrides.details?.overrides');
  });

  it('pins the current allowlisted producers to typed safe-detail builders', async () => {
    const producerFiles = [
      'health/checks/toolIndex.ts',
      'health/checks/mcp.ts',
      'health/checks/oauthRefresh.ts',
      'health/checks/mcpRuntime.ts',
      '../../core/services/health/checks/apiCooldown.ts',
      '../../core/services/health/checks/toolAdvisory.ts',
    ];

    for (const relativePath of producerFiles) {
      const source = await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
      expect(source, relativePath).toContain('defineSafeCheckDetails(');
    }
  });
});

// ---------------------------------------------------------------------------
// SAFE_CHECK_DETAIL_FIELDS allowlist coverage
// ---------------------------------------------------------------------------

describe('SAFE_CHECK_DETAIL_FIELDS', () => {
  it('does not include checks known to contain PII', () => {
    const piiChecks = [
      'authHealth',
      'userProfileComplete',
      'claudeApiKeyValid',
      'voiceApiKeyValid',
      'conflictingCopies',
      'spaceSharingConfig',
    ];
    for (const checkId of piiChecks) {
      expect(
        SAFE_CHECK_DETAIL_FIELDS[checkId as keyof typeof SAFE_CHECK_DETAIL_FIELDS],
        `${checkId} should NOT be in SAFE_CHECK_DETAIL_FIELDS`,
      ).toBeUndefined();
    }
  });

  it('only contains expected check IDs', () => {
    const expectedCheckIds = [
      'toolIndexHealth',
      'bundledServers',
      'mcpSkippedServers',
      'apiCooldownHealth',
      'oauthRefreshHealth',
      'mcpRuntimeHealth',
      'toolAdvisoryHealth',
    ];
    expect(Object.keys(SAFE_CHECK_DETAIL_FIELDS).sort()).toEqual(expectedCheckIds.sort());
  });
});
