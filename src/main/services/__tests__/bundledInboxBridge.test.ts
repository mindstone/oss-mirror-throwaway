import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { GetRecentDiagnosticContextOpts } from '@core/services/diagnostics/recentDiagnosticContext';
import type {
  RecentLogsTailOpts,
  RecentLogsTailResult,
} from '../recentLogsTail';
import type {
  LogFilePathsOpts,
  LogFilePathsResult,
} from '../recentLogFilePaths';

const recentContextMock = vi.hoisted(() => ({
  implementation: null as null | ((opts?: GetRecentDiagnosticContextOpts) => Promise<unknown>),
}));

const recentLogsMock = vi.hoisted(() => ({
  implementation: null as null | ((opts?: RecentLogsTailOpts) => Promise<RecentLogsTailResult>),
  resolveLogDir: null as null | (() => string),
}));

const logFilePathsMock = vi.hoisted(() => ({
  implementation: null as null | ((opts?: LogFilePathsOpts) => Promise<LogFilePathsResult>),
  resolveLogDir: null as null | (() => string),
}));

const loggerInfoMock = vi.hoisted(() => vi.fn());
const settingsUpdateInvokeMock = vi.hoisted(() =>
  vi.fn(async (_event: unknown, _payload: unknown) => undefined),
);
const handlerRegistryGetMock = vi.hoisted(() =>
  vi.fn((channel: string) => (channel === 'settings:update' ? settingsUpdateInvokeMock : undefined)),
);
const validateOpenAiKeyMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, message: 'ok' })));
const validateClaudeKeyMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, message: 'ok' })));
const validateElevenLabsKeyMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, message: 'ok' })));

vi.mock('@core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/logger')>();
  return {
    ...actual,
    createScopedLogger: (...args: Parameters<typeof actual.createScopedLogger>) => {
      const logger = actual.createScopedLogger(...args);
      const originalInfo = logger.info.bind(logger) as (...infoArgs: unknown[]) => void;
      const wrappedLogger = logger as typeof logger & { info: (...infoArgs: unknown[]) => void };
      wrappedLogger.info = (...infoArgs: unknown[]) => {
        loggerInfoMock(...infoArgs);
        originalInfo(...infoArgs);
      };
      return wrappedLogger;
    },
  };
});

vi.mock('@core/services/diagnostics/recentDiagnosticContext', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@core/services/diagnostics/recentDiagnosticContext')
  >();
  return {
    ...actual,
    getRecentDiagnosticContext: (opts?: GetRecentDiagnosticContextOpts) => {
      if (recentContextMock.implementation) {
        return recentContextMock.implementation(opts);
      }
      return actual.getRecentDiagnosticContext(opts);
    },
  };
});

vi.mock('../recentLogsTail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../recentLogsTail')>();
  return {
    ...actual,
    tailRecentMainLogs: (opts?: RecentLogsTailOpts) => {
      if (recentLogsMock.implementation) {
        return recentLogsMock.implementation(opts);
      }
      if (recentLogsMock.resolveLogDir) {
        return actual.tailRecentMainLogs({
          ...opts,
          resolveLogDir: recentLogsMock.resolveLogDir,
        });
      }
      return actual.tailRecentMainLogs(opts);
    },
  };
});

vi.mock('../recentLogFilePaths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../recentLogFilePaths')>();
  return {
    ...actual,
    listRecentLogFilePaths: (opts?: LogFilePathsOpts) => {
      if (logFilePathsMock.implementation) {
        return logFilePathsMock.implementation(opts);
      }
      if (logFilePathsMock.resolveLogDir) {
        return actual.listRecentLogFilePaths({
          ...opts,
          resolveLogDir: logFilePathsMock.resolveLogDir,
        });
      }
      return actual.listRecentLogFilePaths(opts);
    },
  };
});

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: vi.fn(),
}));

vi.mock('@core/handlerRegistry', () => ({
  getHandlerRegistry: () => ({ get: handlerRegistryGetMock }),
}));

vi.mock('../apiKeyValidation', () => ({
  validateOpenAiKey: validateOpenAiKeyMock,
  validateClaudeKey: validateClaudeKeyMock,
  validateElevenLabsKey: validateElevenLabsKeyMock,
}));

import {
  startBundledInboxBridge,
  stopBundledInboxBridge,
  setMeetingBotServiceGetter,
  setAutomationSchedulerGetter,
  resetPassThroughRevisitForTests,
} from '../bundledInboxBridge';
import { generateConversationSummary } from '../conversationSummaryService';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerReader,
} from '@core/services/diagnosticEventsLedger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import {
  DIAGNOSTIC_EVENT_SCHEMA_VERSION,
  type DiagnosticEventEntry,
} from '@core/services/diagnostics/manifest';

import type { AutomationScheduler as SchedulerService } from '../automationScheduler';

const mockState = { version: 1, items: [], history: [] };

const mockSpaces = [
  { name: 'Work', path: 'Work', absolutePath: '/mock/workspace/Work', frontmatter: { space_type: 'professional' } },
  { name: 'Personal', path: 'Personal', absolutePath: '/mock/workspace/Personal', frontmatter: { space_type: 'personal' } }
];

const mockSearchResults = [
  { sessionId: 'abc-123', title: 'Test conversation', score: 0.95, createdAt: '2026-01-01', messageCount: 5 }
];

const mockSummary = {
  overview: 'Summary overview',
  keyDecisions: ['Decision one'],
  gotchasAndInsights: ['Insight one'],
  resourcesMentioned: ['Resource one']
};

const mockSession = {
  id: 'abc-123',
  title: 'Test conversation',
  createdAt: Date.parse('2026-01-01T00:00:00Z'),
  updatedAt: Date.parse('2026-01-01T01:00:00Z'),
  messages: [
    {
      id: 'msg-1',
      turnId: 'turn-1',
      role: 'user',
      text: 'Hello',
      createdAt: Date.parse('2026-01-01T00:00:00Z')
    },
    {
      id: 'msg-2',
      turnId: 'turn-1',
      role: 'assistant',
      text: 'Hi there!',
      createdAt: Date.parse('2026-01-01T00:00:10Z')
    }
  ],
  eventsByTurn: {
    'turn-1': [
      {
        type: 'tool',
        toolName: 'compose_workspace_email',
        toolUseId: 'tool-1',
        detail: 'draft created',
        stage: 'end',
        timestamp: Date.parse('2026-01-01T00:00:08Z'),
        mcpAppUiMeta: {
          resourceUri: 'ui://google-workspace/compose-email',
          presentation: 'primary',
          viewSummary: 'Email draft to alice@example.com about the Q2 plan.',
          viewRoleLabel: 'Editable email draft',
          structuredFallback: {
            kind: 'email-draft',
            payload: {
              to: ['alice@example.com', 'bob@example.com'],
              cc: ['charlie@example.com'],
              subject: 'Project update — Q2 plan',
              body: "Hi team — here's the draft for review.",
            },
          },
        },
      },
    ],
  },
  privateMode: false,
  deletedAt: null,
  demoSession: false
};

vi.mock('../conversationSummaryService', () => ({
  generateConversationSummary: vi.fn()
}));

vi.mock('@core/featureGating', () => ({
  isFeatureEnabled: vi.fn(() => true),
}));


vi.mock('../../utils/automationFileValidation', () => ({
  validateAutomationFilePath: vi.fn(),
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
      activationHotkeyVoiceMode: true
    },
    claude: {
      apiKey: null,
      model: 'claude-sonnet-4-5',
      permissionMode: 'bypassPermissions',
      executablePath: null,
      planMode: true,
      extendedContext: true,
      thinkingEffort: 'high'
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    streaming: { enabled: true }
  })),
  updateSettings: vi.fn()
}));

vi.mock('../../settingsStore', () => ({
  updateSettings: vi.fn()
}));

vi.mock('../inboxStore', () => ({
  addInboxItem: vi.fn(() => ({
    accepted: true,
    itemId: 'mock-item-id',
    state: mockState,
  })),
  updateInboxItem: vi.fn(() => mockState),
  removeInboxItem: vi.fn(() => mockState),
  getInboxState: vi.fn(() => mockState),
  getInboxFeedbackExamples: vi.fn(() => [
    {
      id: 'feedback-1',
      title: 'Review captured source update',
      category: 'automation',
      sourceKind: 'automation',
      sourceAutomationId: 'system-source-capture',
      sourceAutomationName: 'source-capture',
      dismissedReasonCategory: 'not_an_action',
      dismissedReason: 'Just a status update.',
      addedAt: Date.parse('2026-01-01T00:00:00Z'),
      dismissedAt: Date.parse('2026-01-02T00:00:00Z'),
    },
  ])
}));

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

vi.mock('@core/services/space/spaceService', () => ({
  validateSpacePath: vi.fn(),
  readSpaceReadmeFrontmatter: vi.fn(),
  updateSpaceFrontmatter: vi.fn(),
  scanSpaces: vi.fn(() => Promise.resolve(mockSpaces)),
  createSpace: vi.fn(() => Promise.resolve({ name: 'NewSpace', path: 'NewSpace', absolutePath: '/mock/workspace/NewSpace', description: 'A new space' })),
  // Stage 5: bundledInboxBridge calls invalidateSpaceScanCache after mutations.
  invalidateSpaceScanCache: vi.fn(),
}));
vi.mock('../spaceService', () => ({
  validateSpacePath: vi.fn(),
  readSpaceReadmeFrontmatter: vi.fn(),
  updateSpaceFrontmatter: vi.fn(),
  scanSpaces: vi.fn(() => Promise.resolve(mockSpaces)),
  createSpace: vi.fn(() => Promise.resolve({ name: 'NewSpace', path: 'NewSpace', absolutePath: '/mock/workspace/NewSpace', description: 'A new space' })),
  invalidateSpaceScanCache: vi.fn(),
}));

vi.mock('../conversationIndexService', () => ({
  searchConversations: vi.fn(() => Promise.resolve(mockSearchResults)),
  searchConversationsWithStatus: vi.fn(() =>
    Promise.resolve({ status: 'ok', results: mockSearchResults })
  ),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(() => ({
    getSession: vi.fn((id: string) => {
      if (id === 'abc-123') return Promise.resolve(mockSession);
      if (id === 'deleted-123') return Promise.resolve({ ...mockSession, id: 'deleted-123', deletedAt: '2026-01-02' });
      return Promise.resolve(null);
    })
  }))
}));

vi.mock('../demoModeService', () => ({
  isDemoModeActive: vi.fn(() => false)
}));

vi.mock('../../utils/logRedaction', () => ({
  redactObjectDeep: vi.fn((obj) => ({ ...obj, 'claude.apiKey': '[REDACTED]' }))
}));

const mockMeetingHistoryEntries = [
  {
    id: 'google:event1:2026-01-15T10:00:00Z',
    calendarEventId: 'event1',
    calendarSource: 'google',
    title: 'Team Standup',
    startTime: '2026-01-15T10:00:00Z',
    endTime: '2026-01-15T10:30:00Z',
    meetingUrl: 'https://meet.google.com/abc-def-ghi',
    participants: ['alice@example.com', 'bob@example.com'],
    transcriptStatus: 'captured',
    transcriptPath: 'memory/sources/2026/01-Jan/15/team-standup.md',
    botScheduled: true,
  },
  {
    id: 'google:event2:2026-01-15T14:00:00Z',
    calendarEventId: 'event2',
    calendarSource: 'google',
    title: 'Client Call',
    startTime: '2026-01-15T14:00:00Z',
    endTime: '2026-01-15T15:00:00Z',
    meetingUrl: 'https://zoom.us/j/123456',
    participants: ['client@example.com'],
    transcriptStatus: 'missed',
    botScheduled: false,
  }
];

vi.mock('../meetingHistoryStore', () => ({
  getMeetingsInRange: vi.fn(() => mockMeetingHistoryEntries),
  getMissedMeetings: vi.fn(() => [mockMeetingHistoryEntries[1]]),
}));

const mockSendBot = vi.fn(() => Promise.resolve({ success: true, botId: 'bot_123' }));

vi.mock('../meetingBot/meetingBotService', () => ({
  // Type export only, no runtime mock needed
}));

vi.mock('../mcpService', () => ({
  resolveMcpConfigPath: vi.fn(() => '/mock/mcp-config.json'),
  restartSuperMcpForConfigChangeAndAwaitExecution: vi.fn(() => Promise.resolve()),
  reloadSuperMcpNowForChatPackageMaterialization: vi.fn(() => Promise.resolve()),
}));

const mockSendToAllWindows = vi.fn();
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: mockSendToAllWindows, sendToFocusedWindow: vi.fn() }),
}));

import {
  addInboxItem,
  getInboxFeedbackExamples,
  updateInboxItem,
  removeInboxItem
} from '../inboxStore';

import {
  scanSpaces,
  createSpace,
  validateSpacePath,
  readSpaceReadmeFrontmatter,
  updateSpaceFrontmatter,
} from '@core/services/space/spaceService';
import { searchConversationsWithStatus } from '../conversationIndexService';
import { getMeetingsInRange, getMissedMeetings } from '../meetingHistoryStore';
import { updateSettings } from '../../settingsStore';

function findRawLogAuditCall(message: string): unknown[] | undefined {
  return loggerInfoMock.mock.calls.find(
    (args: unknown[]) => args[1] === message,
  );
}

function bearerHashPrefix(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

describe('bundledInboxBridge', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await stopBundledInboxBridge();
    resetPassThroughRevisitForTests();
    resetDiagnosticEventsLedgerForTests();
    recentContextMock.implementation = null;
    recentLogsMock.implementation = null;
    recentLogsMock.resolveLogDir = null;
    logFilePathsMock.implementation = null;
    logFilePathsMock.resolveLogDir = null;
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    vi.clearAllMocks();
  });

  it('rejects unauthorized requests', async () => {
    const { port } = await startBundledInboxBridge();
    const res = await fetch(`http://127.0.0.1:${port}/inbox/add`, {
      method: 'POST',
      body: JSON.stringify({ title: 'test' })
    });
    expect(res.status).toBe(401);
  });

  it('accepts authorized add requests', async () => {
    const { port, token } = await startBundledInboxBridge();
    const res = await fetch(`http://127.0.0.1:${port}/inbox/add`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'demo' })
    });
    expect(res.status).toBe(200);
    expect(addInboxItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'demo' }));
  });

  it('returns scoped dismissed feedback examples', async () => {
    const { port, token } = await startBundledInboxBridge();
    const res = await fetch(`http://127.0.0.1:${port}/inbox/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        automationId: 'system-source-capture',
        automationName: 'source-capture',
        limit: 5,
      })
    });
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(getInboxFeedbackExamples).toHaveBeenCalledWith(expect.objectContaining({
      automationId: 'system-source-capture',
      automationName: 'source-capture',
      limit: 5,
    }));
    expect(payload.examples).toHaveLength(1);
    expect(payload.examples[0].dismissedReasonCategory).toBe('not_an_action');
  });

  describe('GET /diagnostics/recent-events', () => {
    it('rejects requests without Authorization', async () => {
      const { port } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-events`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    });

    it('returns empty markdown when no diagnostic-events reader is registered', async () => {
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-events`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        eventCount: 0,
        readerAvailable: false,
      });
      expect(payload.markdown).toContain('All quiet. Nothing notable in the last 24h.');
    });

    it('returns structured markdown when the reader has diagnostic events', async () => {
      installDiagnosticEventsReader([
        cooldownEnter(Date.now() - 3_000),
        abortEvent(Date.now() - 2_000),
        knownCondition(Date.now() - 1_000),
      ]);
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-events`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(payload.eventCount).toBe(3);
      expect(payload.markdown).toContain('### Per-kind counts');
      expect(payload.markdown).toContain('#### abort_event (1 in window)');
      expect(payload.markdown).toContain('#### cooldown_enter (1 in window)');
      expect(payload.markdown).toContain('#### known_condition (1 in window)');
    });

    it('emits a known condition and returns 500 when recent-events assembly fails', async () => {
      recentContextMock.implementation = async () => {
        throw new Error('recent events failed');
      };
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-events`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(500);
      expect(payload).toEqual({
        success: false,
        error: 'Failed to read diagnostic events.',
      });
      expect(captureKnownCondition).toHaveBeenCalledWith(
        'bridge_recent_events_failure',
        { endpoint: '/diagnostics/recent-events' },
        expect.any(Error),
      );
    });

    it('clamps query string limit to 20 entries per kind', async () => {
      const nowMs = Date.now();
      installDiagnosticEventsReader(
        Array.from({ length: 25 }, (_value, index) => cooldownEnter(nowMs - (25 - index) * 1000)),
      );
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-events?limit=99`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload.markdown).toContain('### Last 20 entries per kind');
      expect(payload.markdown.match(/surface=desktop/g)).toHaveLength(20);
    });

    it('treats empty and non-finite query params as defaults rather than min-clamps', async () => {
      const optsRecord: Array<GetRecentDiagnosticContextOpts | undefined> = [];
      recentContextMock.implementation = async (opts) => {
        optsRecord.push(opts);
        return {
          windowHours: opts?.windowHours ?? 24,
          limit: opts?.limit ?? 5,
          nowMs: 1_700_000_000_000,
          counts: null,
          lastTimes: null,
          entriesByKind: {},
          totalEvents: 0,
          readerAvailable: true,
        };
      };
      const { port, token } = await startBundledInboxBridge();

      const cases = [
        '/diagnostics/recent-events?limit=&windowHours=',
        '/diagnostics/recent-events?limit=foo&windowHours=bar',
        '/diagnostics/recent-events?limit=  &windowHours=  ',
      ];

      for (const path of cases) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
      }

      for (const captured of optsRecord) {
        expect(captured?.limit).toBeUndefined();
        expect(captured?.windowHours).toBeUndefined();
      }
    });
  });

  describe('GET /diagnostics/recent-logs', () => {
    it('rejects requests without Authorization', async () => {
      const { port } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    });

    it('returns an empty result when the log directory is empty', async () => {
      const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-recent-logs-empty-'));
      tempDirs.push(logDir);
      recentLogsMock.resolveLogDir = () => logDir;
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        content: '',
        lines: 0,
        bytesReturned: 0,
        bytesAvailable: 0,
        truncated: false,
        filesRead: [],
        errors: [],
      });
    });

    it('returns content from a fixture log directory', async () => {
      const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-recent-logs-fixture-'));
      tempDirs.push(logDir);
      recentLogsMock.resolveLogDir = () => logDir;
      await fs.writeFile(path.join(logDir, 'mindstone-rebel.log'), 'hello\nfrom logs\n', 'utf8');
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload.content).toBe('hello\nfrom logs');
      expect(payload.lines).toBe(2);
      expect(payload.filesRead).toEqual([
        { basename: 'mindstone-rebel.log', bytesRead: 'hello\nfrom logs\n'.length },
      ]);
    });

    it('emits an info-level audit log on /diagnostics/recent-logs success', async () => {
      recentLogsMock.implementation = async () => ({
        content: 'raw log content that must not be audited',
        lines: 2,
        bytesReturned: 41,
        bytesAvailable: 128,
        truncated: true,
        filesRead: [{ path: '/very/secret/path/mindstone-rebel.log', bytesRead: 41 }],
        errors: [{ path: '/very/secret/path/mindstone-rebel.1.log', reason: 'ENOENT' }],
      });
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const auditCall = findRawLogAuditCall('Raw-log read access');
      expect(auditCall).toEqual([
        {
          endpoint: '/diagnostics/recent-logs',
          status: 200,
          lines: 2,
          bytesReturned: 41,
          bytesAvailable: 128,
          truncated: true,
          bearerHashPrefix: bearerHashPrefix(token),
          filesReadCount: 1,
          errorsCount: 1,
        },
        'Raw-log read access',
      ]);
      expect(auditCall?.[0]).not.toHaveProperty('content');
      expect(auditCall?.[0]).not.toHaveProperty('filesRead');
      expect(JSON.stringify(auditCall?.[0])).not.toContain('raw log content');
      expect(JSON.stringify(auditCall?.[0])).not.toContain('/very/secret/path');
    });

    it('passes maxBytes and maxLines query params to the helper', async () => {
      const optsRecord: Array<RecentLogsTailOpts | undefined> = [];
      recentLogsMock.implementation = async (opts) => {
        optsRecord.push(opts);
        return emptyRecentLogsResult();
      };
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs?maxBytes=1024&maxLines=10`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      expect(optsRecord).toEqual([{ maxBytes: 1024, maxLines: 10 }]);
    });

    it('emits a known condition and returns 500 when recent-log tailing fails unexpectedly', async () => {
      recentLogsMock.implementation = async () => {
        throw new Error('recent logs failed');
      };
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(500);
      expect(payload).toEqual({
        success: false,
        error: 'Failed to read recent log lines.',
      });
      expect(captureKnownCondition).toHaveBeenCalledWith(
        'bridge_recent_logs_failure',
        { endpoint: '/diagnostics/recent-logs' },
        expect.any(Error),
      );
    });

    it('emits an info-level audit log on /diagnostics/recent-logs failure', async () => {
      recentLogsMock.implementation = async () => {
        throw new Error('recent logs failed');
      };
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(500);
      expect(findRawLogAuditCall('Raw-log read access (failed)')).toEqual([
        {
          endpoint: '/diagnostics/recent-logs',
          status: 500,
          bearerHashPrefix: bearerHashPrefix(token),
        },
        'Raw-log read access (failed)',
      ]);
    });


    it('emits the raw pass-through policy known condition once per process', async () => {
      recentLogsMock.implementation = async () => emptyRecentLogsResult();
      const { port, token } = await startBundledInboxBridge();
      const headers = { Authorization: `Bearer ${token}` };

      const first = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs`, {
        method: 'GET',
        headers,
      });
      const second = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs`, {
        method: 'GET',
        headers,
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const policyCalls = vi.mocked(captureKnownCondition).mock.calls.filter(
        ([condition]) => condition === 'pass_through_redaction_policy',
      );
      expect(policyCalls).toEqual([
        [
          'pass_through_redaction_policy',
          { policy: 'raw-pass-through', userOverride: true, revisitTrigger: 'secret-leak-incident' },
        ],
      ]);
    });

    it('returns basename-only file metadata', async () => {
      recentLogsMock.implementation = async () => ({
        content: 'metadata',
        lines: 1,
        bytesReturned: 8,
        bytesAvailable: 8,
        truncated: false,
        filesRead: [{ path: '/very/secret/path/mindstone-rebel.log.1', bytesRead: 8 }],
        errors: [{ path: '/very/secret/path/mindstone-rebel.log.2', reason: 'ENOENT' }],
      });
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/recent-logs`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload.filesRead).toEqual([{ basename: 'mindstone-rebel.log.1', bytesRead: 8 }]);
      expect(payload.errors).toEqual([{ basename: 'mindstone-rebel.log.2', reason: 'ENOENT' }]);
      expect(JSON.stringify(payload.filesRead)).not.toContain('/very/secret/path');
      expect(JSON.stringify(payload.errors)).not.toContain('/very/secret/path');
    });
  });

  describe('GET /diagnostics/log-file-paths', () => {
    it('rejects requests without Authorization', async () => {
      const { port } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/log-file-paths`, {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    });

    it('returns an empty result when the log directory is empty', async () => {
      const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-log-file-paths-empty-'));
      tempDirs.push(logDir);
      logFilePathsMock.resolveLogDir = () => logDir;
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/log-file-paths`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload).toEqual({
        success: true,
        logDir,
        files: [],
        totalBytes: 0,
        errors: [],
      });
    });

    it('returns basename-only file metadata for matching log files', async () => {
      const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-log-file-paths-fixture-'));
      tempDirs.push(logDir);
      logFilePathsMock.resolveLogDir = () => logDir;
      const filePath = path.join(logDir, 'mindstone-rebel.log');
      await fs.writeFile(filePath, 'hello metadata', 'utf8');
      await setTestMtime(filePath, 1);
      const stats = await fs.stat(filePath);
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/log-file-paths`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload.files).toEqual([
        {
          basename: 'mindstone-rebel.log',
          size: Buffer.byteLength('hello metadata', 'utf8'),
          mtimeMs: stats.mtimeMs,
          mtimeIso: new Date(stats.mtimeMs).toISOString(),
        },
      ]);
      expect(JSON.stringify(payload.files)).not.toContain(logDir);
    });

    it('returns files newest-first by mtimeMs', async () => {
      const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-log-file-paths-order-'));
      tempDirs.push(logDir);
      logFilePathsMock.resolveLogDir = () => logDir;
      const olderPath = path.join(logDir, 'mindstone-rebel.1.log');
      const newerPath = path.join(logDir, 'mindstone-rebel.log');
      await fs.writeFile(olderPath, 'older', 'utf8');
      await fs.writeFile(newerPath, 'newer', 'utf8');
      await setTestMtime(olderPath, 1);
      await setTestMtime(newerPath, 2);
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/log-file-paths`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload.files.map((file: { basename: string }) => file.basename)).toEqual([
        'mindstone-rebel.log',
        'mindstone-rebel.1.log',
      ]);
      expect(payload.files[0].mtimeMs).toBeGreaterThan(payload.files[1].mtimeMs);
    });

    it('includes the resolved absolute logDir path', async () => {
      const logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-log-file-paths-logdir-'));
      tempDirs.push(logDir);
      logFilePathsMock.resolveLogDir = () => logDir;
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/log-file-paths`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload.logDir).toBe(logDir);
      expect(path.isAbsolute(payload.logDir)).toBe(true);
    });

    it('emits a known condition and returns 500 when log-file metadata listing fails unexpectedly', async () => {
      logFilePathsMock.implementation = async () => {
        throw new Error('log file paths failed');
      };
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/log-file-paths`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await res.json();

      expect(res.status).toBe(500);
      expect(payload).toEqual({
        success: false,
        error: 'Failed to read log file metadata.',
      });
      expect(captureKnownCondition).toHaveBeenCalledWith(
        'bridge_log_file_paths_failure',
        { endpoint: '/diagnostics/log-file-paths' },
        expect.any(Error),
      );
    });

    it('emits an info-level audit log on /diagnostics/log-file-paths success', async () => {
      logFilePathsMock.implementation = async () => ({
        logDir: '/very/secret/path',
        files: [
          {
            path: '/very/secret/path/mindstone-rebel.log',
            basename: 'mindstone-rebel.log',
            size: 41,
            mtimeMs: 1_700_000_000_000,
            mtimeIso: '2023-11-14T22:13:20.000Z',
          },
        ],
        totalBytes: 41,
        errors: [{ path: '/very/secret/path/mindstone-rebel.1.log', reason: 'ENOENT' }],
      });
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/log-file-paths`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      expect(findRawLogAuditCall('Log-file-paths read access')).toEqual([
        {
          endpoint: '/diagnostics/log-file-paths',
          status: 200,
          filesCount: 1,
          totalBytes: 41,
          errorsCount: 1,
          bearerHashPrefix: bearerHashPrefix(token),
        },
        'Log-file-paths read access',
      ]);
    });

    it('emits an info-level audit log on /diagnostics/log-file-paths failure', async () => {
      logFilePathsMock.implementation = async () => {
        throw new Error('log file paths failed');
      };
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/diagnostics/log-file-paths`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(500);
      expect(findRawLogAuditCall('Log-file-paths read access (failed)')).toEqual([
        {
          endpoint: '/diagnostics/log-file-paths',
          status: 500,
          bearerHashPrefix: bearerHashPrefix(token),
        },
        'Log-file-paths read access (failed)',
      ]);
    });
  });

  it('sets global model settings for quality tiers and rejects invalid tiers', async () => {
    const { port, token } = await startBundledInboxBridge();
    const updateSettingsMock = vi.mocked(updateSettings);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const tierCases = [
      {
        tier: 'quick',
        model: 'claude-haiku-4-5',
        thinkingModel: 'claude-haiku-4-5',
        thinkingEffort: 'low',
      },
      {
        tier: 'balanced',
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-sonnet-4-6',
        thinkingEffort: 'high',
      },
      {
        tier: 'thorough',
        model: 'claude-sonnet-4-6',
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'high',
      },
      {
        tier: 'maximum',
        model: 'claude-opus-4-8',
        thinkingModel: 'claude-opus-4-8',
        thinkingEffort: 'xhigh',
      },
      // The 'frontier' (Fable) tier was removed while Fable access is withdrawn
      // (2026-06); it is now an INVALID tier (asserted in the rejection check
      // below). Restore this case when Fable returns and the tier is re-added.
    ];

    for (const tierCase of tierCases) {
      updateSettingsMock.mockClear();
      const res = await fetch(`http://127.0.0.1:${port}/settings/set-quality-tier`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tier: tierCase.tier }),
      });

      expect(res.status).toBe(200);
      expect(updateSettingsMock).toHaveBeenCalledTimes(1);
      const [settingsUpdate] = updateSettingsMock.mock.calls[0];
      expect(settingsUpdate).toEqual(expect.objectContaining({
        models: expect.objectContaining({
          model: tierCase.model,
          thinkingModel: tierCase.thinkingModel,
          thinkingEffort: tierCase.thinkingEffort,
          workingProfileId: undefined,
          thinkingProfileId: undefined,
        }),
        localModel: expect.objectContaining({
          profiles: [],
          activeProfileId: null,
        }),
      }));
    }

    // 'unknown' is a bogus tier; 'frontier' is the removed (withdrawn-Fable) tier
    // — both must be rejected without mutating settings.
    for (const invalidTier of ['unknown', 'frontier']) {
      updateSettingsMock.mockClear();
      const invalidRes = await fetch(`http://127.0.0.1:${port}/settings/set-quality-tier`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tier: invalidTier }),
      });

      expect(invalidRes.status).toBe(400);
      expect(updateSettingsMock).not.toHaveBeenCalled();
    }
  });

  it('forwards update errors as 404', async () => {
    vi.mocked(updateInboxItem).mockImplementationOnce(() => {
      throw new Error('Item not found');
    });
    const { port, token } = await startBundledInboxBridge();
    const res = await fetch(`http://127.0.0.1:${port}/inbox/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'missing' })
    });
    expect(res.status).toBe(404);
    const payload = await res.json();
    expect(payload.error).toBe('Item not found');
  });

  it('removes items when authorized', async () => {
    const { port, token } = await startBundledInboxBridge();
    const res = await fetch(`http://127.0.0.1:${port}/inbox/remove`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'abc' })
    });
    expect(res.status).toBe(200);
    expect(removeInboxItem).toHaveBeenCalledWith('abc');
  });

  describe('automations/run-now endpoint', () => {
    it('responds immediately (does not await full automation completion)', async () => {
      const runNow = vi.fn(() => new Promise<unknown>(() => undefined));
      setAutomationSchedulerGetter(
        () =>
          ({
            getState: () => ({ definitions: [{ id: 'abc' }], runs: [] }),
            runNow,
          }) as unknown as SchedulerService
      );

      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/automations/run-now`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'abc' }),
      });
      expect(res.status).toBe(202);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.started).toBe(true);
      expect(runNow).toHaveBeenCalledWith('abc', 'manual');
    });
  });

  describe('automations/upsert endpoint', () => {
    it('accepts schedule-omitting update patches', async () => {
      const existingDefinition = {
        id: 'auto-1',
        name: 'Existing Automation',
        filePath: 'existing.md',
        schedule: { type: 'daily', time: '09:00' },
        enabled: true,
      };
      const upsertDefinition = vi.fn((patch) => ({ ...existingDefinition, ...patch }));

      setAutomationSchedulerGetter(
        () =>
          ({
            getState: () => ({ definitions: [existingDefinition], runs: [] }),
            upsertDefinition,
          }) as unknown as SchedulerService,
      );

      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/automations/upsert`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'auto-1', enabled: false }),
      });

      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(upsertDefinition).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'auto-1',
          enabled: false,
        }),
      );
      expect(upsertDefinition.mock.calls[0]?.[0]).not.toHaveProperty('schedule');
    });

    // BLOCKER 1 (R6 Stage 2 refinement): MCP repair shapes must reach
    // fromUntrusted before the strict AutomationScheduleSchema runs. These
    // tests pin the bridge's parse-then-repair → repair-then-parse flow.
    describe('MCP repair shapes (BLOCKER 1)', () => {
      const setupBridgeForUpsert = (upsertFn = vi.fn((patch) => ({ id: 'new-id', ...patch }))) => {
        setAutomationSchedulerGetter(
          () =>
            ({
              getState: () => ({ definitions: [], runs: [] }),
              upsertDefinition: upsertFn,
            }) as unknown as SchedulerService,
        );
        return upsertFn;
      };

      it('normalises event_type (snake_case canonical) → eventType', async () => {
        const upsertDefinition = setupBridgeForUpsert();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/upsert`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Event Auto',
            filePath: 'auto.md',
            schedule: { type: 'event', event_type: 'transcript-ready' },
          }),
        });
        expect(res.status).toBe(200);
        expect(upsertDefinition).toHaveBeenCalledTimes(1);
        const passed = upsertDefinition.mock.calls[0]?.[0];
        expect(passed.schedule).toEqual({ type: 'event', eventType: 'transcript-ready' });
      });

      it('normalises legacy `trigger` alias → eventType', async () => {
        const upsertDefinition = setupBridgeForUpsert();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/upsert`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Legacy Trigger Auto',
            filePath: 'auto.md',
            schedule: { type: 'event', trigger: 'transcript-ready' },
          }),
        });
        expect(res.status).toBe(200);
        const passed = upsertDefinition.mock.calls[0]?.[0];
        expect(passed.schedule).toEqual({ type: 'event', eventType: 'transcript-ready' });
      });

      it('backfills missing anchorDate on every_n_days from now', async () => {
        const upsertDefinition = setupBridgeForUpsert();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/upsert`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Every 3 Days',
            filePath: 'auto.md',
            schedule: { type: 'every_n_days', intervalDays: 3, time: '09:00' },
          }),
        });
        expect(res.status).toBe(200);
        const passed = upsertDefinition.mock.calls[0]?.[0];
        expect(passed.schedule.type).toBe('every_n_days');
        expect(passed.schedule.intervalDays).toBe(3);
        expect(passed.schedule.time).toBe('09:00');
        expect(typeof passed.schedule.anchorDate).toBe('string');
        expect(passed.schedule.anchorDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      it('returns 400 with structured errorKind when event schedule missing eventType', async () => {
        const upsertDefinition = setupBridgeForUpsert();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/upsert`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Bad Event',
            filePath: 'auto.md',
            schedule: { type: 'event' },
          }),
        });
        expect(res.status).toBe(400);
        const payload = await res.json();
        expect(payload.success).toBe(false);
        expect(payload.errorKind).toBe('missing-field');
        expect(upsertDefinition).not.toHaveBeenCalled();
      });

      it('returns 400 with structured errorKind on unknown schedule type', async () => {
        const upsertDefinition = setupBridgeForUpsert();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/upsert`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Bad Type',
            filePath: 'auto.md',
            schedule: { type: 'unknown' },
          }),
        });
        expect(res.status).toBe(400);
        const payload = await res.json();
        expect(payload.success).toBe(false);
        expect(payload.errorKind).toBe('unknown-type');
        expect(upsertDefinition).not.toHaveBeenCalled();
      });
    });
  });

  describe('automations/tool-grants endpoints', () => {
    const grantFixture = { id: 'grant-1', toolId: 'gmail:send_message', createdAt: 1000, createdFrom: 'manual' as const };
    const defWithGrants = { id: 'auto-1', name: 'Test Automation', schedule: { type: 'daily', time: '09:00' }, toolApprovalGrants: [grantFixture] };
    const defWithoutGrants = { id: 'auto-2', name: 'No Grants', schedule: { type: 'daily', time: '10:00' } };

    const setupScheduler = (upsertFn = vi.fn()) => {
      setAutomationSchedulerGetter(
        () =>
          ({
            getState: () => ({ definitions: [defWithGrants, defWithoutGrants], runs: [] }),
            upsertDefinition: upsertFn,
          }) as unknown as SchedulerService
      );
    };

    describe('GET /automations/tool-grants', () => {
      it('returns grants for an automation', async () => {
        setupScheduler();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/tool-grants?id=auto-1`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const payload = await res.json();
        expect(payload.success).toBe(true);
        expect(payload.automationId).toBe('auto-1');
        expect(payload.grants).toHaveLength(1);
        expect(payload.grants[0].toolId).toBe('gmail:send_message');
      });

      it('returns empty array for automation without grants', async () => {
        setupScheduler();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/tool-grants?id=auto-2`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        const payload = await res.json();
        expect(payload.grants).toHaveLength(0);
      });

      it('returns 404 for unknown automation id', async () => {
        setupScheduler();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/tool-grants?id=nonexistent`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(404);
      });

      it('returns 400 when id is missing', async () => {
        setupScheduler();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/tool-grants`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(400);
      });
    });

    describe('POST /automations/tool-grants/add', () => {
      it('adds a new tool grant', async () => {
        const upsert = vi.fn();
        setupScheduler(upsert);
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/tool-grants/add`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'auto-1', toolId: 'calendar:list_events' }),
        });
        expect(res.status).toBe(200);
        const payload = await res.json();
        expect(payload.success).toBe(true);
        expect(payload.grant.toolId).toBe('calendar:list_events');
        expect(upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 'auto-1',
            toolApprovalGrants: expect.arrayContaining([
              grantFixture,
              expect.objectContaining({ toolId: 'calendar:list_events' }),
            ]),
          })
        );
      });

      it('returns duplicate:true for existing toolId', async () => {
        setupScheduler();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/tool-grants/add`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'auto-1', toolId: 'gmail:send_message' }),
        });
        expect(res.status).toBe(200);
        const payload = await res.json();
        expect(payload.duplicate).toBe(true);
      });

      it('returns 404 for unknown automation id', async () => {
        setupScheduler();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/tool-grants/add`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'nonexistent', toolId: 'anything' }),
        });
        expect(res.status).toBe(404);
      });
    });

    describe('POST /automations/tool-grants/remove', () => {
      it('removes an existing grant', async () => {
        const upsert = vi.fn();
        setupScheduler(upsert);
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/tool-grants/remove`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'auto-1', grantId: 'grant-1' }),
        });
        expect(res.status).toBe(200);
        const payload = await res.json();
        expect(payload.success).toBe(true);
        expect(upsert).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'auto-1', toolApprovalGrants: [] })
        );
      });

      it('returns 404 for unknown grant id', async () => {
        setupScheduler();
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/automations/tool-grants/remove`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'auto-1', grantId: 'nonexistent' }),
        });
        expect(res.status).toBe(404);
      });
    });
  });

  describe('space/update-config endpoint', () => {
    it.each([
      ['canonical organisation_name', { organisation_name: 'Mindstone' }, 'organisation_name'],
      ['trailing-space bypass', { 'organisation_name ': 'Mindstone' }, 'organisation_name '],
      ['case-variation bypass', { Organisation_Name: 'Mindstone' }, 'Organisation_Name'],
      ['zero-width-char bypass', { 'organisation_name\u200B': 'Mindstone' }, 'organisation_name\u200B'],
    ])('rejects %s updates from the agent-facing config tool', async (_label, updates, rejectedField) => {
      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/space/update-config`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spacePath: 'Work',
          updates,
        }),
      });
      const payload = await res.json();

      expect(res.status).toBe(400);
      expect(payload).toEqual({
        success: false,
        error: `Cannot update fields via this tool: ${rejectedField}. Use Settings > Spaces instead.`,
      });
      expect(updateSpaceFrontmatter).not.toHaveBeenCalled();
    });

    it('allows only the literal rebel_space_description and emails keys', async () => {
      vi.mocked(validateSpacePath).mockReturnValue('/mock/workspace/Work');
      vi.mocked(readSpaceReadmeFrontmatter).mockResolvedValue({
        rebel_space_description: 'Existing description',
      });
      vi.mocked(updateSpaceFrontmatter).mockResolvedValue({ success: true });

      const { port, token } = await startBundledInboxBridge();

      const res = await fetch(`http://127.0.0.1:${port}/space/update-config`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spacePath: 'Work',
          updates: {
            rebel_space_description: 'Updated description',
            emails: [' owner@example.com ', 'owner@example.com', 'team@example.com'],
          },
        }),
      });
      const payload = await res.json();

      expect(res.status).toBe(200);
      expect(payload).toEqual({
        success: true,
        spacePath: 'Work',
        updated: ['rebel_space_description', 'emails'],
      });
      expect(updateSpaceFrontmatter).toHaveBeenCalledWith('/mock/workspace/Work', {
        rebel_space_description: 'Updated description',
        emails: ['owner@example.com', 'team@example.com'],
      });
    });
  });

  // ==========================================================================
  // New MCP Tools Batch Tests (2026-01-11)
  // ==========================================================================

  describe('spaces/list endpoint', () => {
    it('returns list of spaces', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/spaces/list`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.spaces).toHaveLength(2);
      expect(payload.spaces[0].name).toBe('Work');
      expect(scanSpaces).toHaveBeenCalled();
    });
  });

  describe('settings/get endpoint', () => {
    it('returns redacted settings', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/settings/get`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.settings).toBeDefined();
      // Check that redaction was applied
      expect(payload.settings['claude.apiKey']).toBe('[REDACTED]');
    });
  });

  describe('conversations/search endpoint', () => {
    it('returns search results with rebel:// URLs', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test query', limit: 5 })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0].url).toBe('rebel://conversation/abc-123');
      // Explicit user-driven tool search opts into the F1 lexical-exemption keep-rule.
      expect(searchConversationsWithStatus).toHaveBeenCalledWith('test query', { limit: 5, lexicalExemption: true });
    });

    it('rejects missing query', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 5 })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('query is required');
    });

    it('rejects empty query', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '   ' })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('query is required');
    });

    // FOX-3003: when the search backend is unavailable (embedding service down,
    // index still starting, or an unexpected error), searchConversationsWithStatus
    // returns a non-`ok` status. The bridge must surface this as
    // 200 { success:false, error } — NOT a thrown error, and NOT success:true+[]
    // (which would make the MCP tool lie "No conversations found").
    it.each(['embedding_unavailable', 'index_not_ready', 'error'] as const)(
      'returns 200 { success:false, error } when search status is %s (not a misleading empty success)',
      async (status) => {
        vi.mocked(searchConversationsWithStatus).mockResolvedValueOnce({ status, results: [] });
        const { port, token } = await startBundledInboxBridge();
        const res = await fetch(`http://127.0.0.1:${port}/conversations/search`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'test query', limit: 5 })
        });
        // 200 (not non-2xx) so the MCP server's bridgeRequest does not throw and
        // instead renders the clean "Search failed: …" path.
        expect(res.status).toBe(200);
        const payload = await res.json();
        expect(payload.success).toBe(false);
        expect(payload.results).toBeUndefined();
        expect(typeof payload.error).toBe('string');
        expect(payload.error).toMatch(/temporarily unavailable/i);
      },
    );

    // NOTE: the MCP server (resources/mcp/rebel-search-and-conversations/server.cjs
    // ~:532-538) renders `!result.success` as `Search failed: ${result.error}`.
    // That cjs server is a separate stdio process and is not stood up in this
    // harness, so we assert the bridge contract (200 + success:false + error)
    // that the cjs server consumes, rather than the rendered MCP text.
  });

  describe('conversations/get-summary endpoint', () => {
    it('returns summary by ID', async () => {
      vi.mocked(generateConversationSummary).mockResolvedValueOnce(mockSummary);
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/get-summary`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'abc-123' })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.summary).toEqual(mockSummary);
      expect(payload.fallbackUsed).toBe(false);
      expect(payload.url).toBe('rebel://conversation/abc-123');
    });

    it('parses rebel:// URL', async () => {
      vi.mocked(generateConversationSummary).mockResolvedValueOnce(mockSummary);
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/get-summary`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'rebel://conversation/abc-123' })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.summary).toEqual(mockSummary);
    });

    it('returns 404 for missing session', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/get-summary`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'nonexistent' })
      });
      expect(res.status).toBe(404);
    });
  });

  describe('conversations/export-full endpoint', () => {
    it('writes export to temp file and returns path', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/export-full`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'abc-123' })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.filePath).toBeDefined();
      expect(payload.filePath).toContain('rebel-conversation-');
      expect(payload.filename).toContain('rebel-conversation-');
      expect(payload.messageCount).toBe(2);

      const { readFile } = await import('node:fs/promises');
      const content = await readFile(payload.filePath, 'utf-8');
      expect(content).toContain('Conversation Export');
      expect(content).toContain('Hello');
      expect(content).toContain('Hi there!');
      expect(content).toContain('Email draft to alice@example.com about the Q2 plan.');
      expect(content).toContain('> [Editable email draft]');
      expect(content).toContain('> To: alice@example.com, bob@example.com');
      expect(content).toContain('> Cc: charlie@example.com');
      expect(content).toContain('> Subject: Project update — Q2 plan');
      expect(content).toContain("> Hi team — here's the draft for review.");
    });

    it('returns 404 for deleted session', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/export-full`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'deleted-123' })
      });
      expect(res.status).toBe(404);
    });
  });

  describe('spaces/create endpoint', () => {
    it('creates a new space', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/spaces/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'NewSpace', description: 'A test space' })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.space.name).toBe('NewSpace');
      expect(createSpace).toHaveBeenCalled();
    });

    it('rejects missing name', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/spaces/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'No name' })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('name is required');
    });
  });

  describe('settings/set-api-key endpoint', () => {
    it('routes openai and google key writes through settings:update IPC handler', async () => {
      settingsUpdateInvokeMock.mockClear();
      handlerRegistryGetMock.mockClear();
      validateOpenAiKeyMock.mockClear();

      const { port, token } = await startBundledInboxBridge();
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

      const openAiRes = await fetch(`http://127.0.0.1:${port}/settings/set-api-key`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-fake-openai-key-abc12345' }),
      });
      expect(openAiRes.status).toBe(200);

      const googleRes = await fetch(`http://127.0.0.1:${port}/settings/set-api-key`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ provider: 'google', apiKey: 'AIza-test-abc123' }),
      });
      expect(googleRes.status).toBe(200);

      expect(handlerRegistryGetMock).toHaveBeenCalledWith('settings:update');
      expect(settingsUpdateInvokeMock).toHaveBeenCalledTimes(2);
      const [openAiCall, googleCall] = settingsUpdateInvokeMock.mock.calls;
      expect(openAiCall?.[0]).toBeNull();
      expect(openAiCall?.[1]).toEqual(
        expect.objectContaining({
          providerKeys: expect.objectContaining({ openai: 'sk-fake-openai-key-abc12345' }),
        }),
      );
      expect(googleCall?.[0]).toBeNull();
      expect(googleCall?.[1]).toEqual(
        expect.objectContaining({
          providerKeys: expect.objectContaining({ google: 'AIza-test-abc123' }),
        }),
      );
      expect(validateOpenAiKeyMock).toHaveBeenCalledWith('sk-fake-openai-key-abc12345');
    });

    it('returns 500 with explicit error when settings:update handler is not registered', async () => {
      settingsUpdateInvokeMock.mockClear();
      handlerRegistryGetMock.mockClear();
      handlerRegistryGetMock.mockReturnValueOnce(undefined);

      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/settings/set-api-key`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'together', apiKey: 'together-test-key-12345' }),
      });

      expect(res.status).toBe(500);
      const payload = await res.json();
      expect(payload.success).toBe(false);
      expect(payload.error).toBe('settings:update handler is unavailable');
      expect(handlerRegistryGetMock).toHaveBeenCalledWith('settings:update');
      expect(settingsUpdateInvokeMock).not.toHaveBeenCalled();
    });
  });

  describe('settings/update endpoint', () => {
    it('updates allowed settings', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/settings/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { theme: 'dark' } })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.updated).toContain('theme');
    });

    it('rejects blocked settings', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/settings/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { toolSafetyLevel: 'disabled' } })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('Cannot update');
      expect(payload.error).toContain('toolSafetyLevel');
    });

    it('rejects invalid theme value', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/settings/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { theme: 'rainbow' } })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('theme must be');
    });

    it('rejects non-boolean indexingEnabled', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/settings/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { indexingEnabled: 'yes' } })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('indexingEnabled must be a boolean');
    });

    it('handles streaming.enabled update', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/settings/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { streaming: { enabled: false } } })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
    });

    it('rejects streaming with invalid subfields', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/settings/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: { streaming: { enabled: true, speed: 'fast' } } })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('streaming can only contain');
    });
  });

  describe('vocabulary endpoints', () => {
    it('GET /vocabulary returns empty array when no vocabulary configured', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/vocabulary`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.vocabulary).toEqual([]);
    });

    it('POST /vocabulary/update rejects missing action', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/vocabulary/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ terms: ['Test'] })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('action is required');
    });

    it('POST /vocabulary/update rejects invalid action', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/vocabulary/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'invalid', terms: ['Test'] })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('action is required');
    });

    it('POST /vocabulary/update rejects non-array terms', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/vocabulary/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', terms: 'not-an-array' })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('terms must be an array');
    });

    it('POST /vocabulary/update rejects non-string terms', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/vocabulary/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', terms: [123, 'valid'] })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('All terms must be strings');
    });

    it('POST /vocabulary/update rejects terms exceeding max length', async () => {
      const { port, token } = await startBundledInboxBridge();
      const longTerm = 'a'.repeat(101);
      const res = await fetch(`http://127.0.0.1:${port}/vocabulary/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', terms: [longTerm] })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('exceeds maximum length');
    });

    it('POST /vocabulary/update with action=add adds terms successfully', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/vocabulary/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', terms: ['Anthropic', 'Claude', 'Mindstone'] })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.added).toEqual(['Anthropic', 'Claude', 'Mindstone']);
      expect(payload.removed).toEqual([]);
      expect(payload.after).toEqual(['Anthropic', 'Claude', 'Mindstone']);
    });

    it('POST /vocabulary/update skips empty strings', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/vocabulary/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', terms: ['Valid', '', '  ', 'AlsoValid'] })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.added).toEqual(['Valid', 'AlsoValid']);
    });

    it('POST /vocabulary/update with action=replace replaces all terms', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/vocabulary/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'replace', terms: ['NewTerm1', 'NewTerm2'] })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.after).toEqual(['NewTerm1', 'NewTerm2']);
    });
  });

  // ==========================================================================
  // Meeting History Endpoints (Stage 6)
  // ==========================================================================

  describe('meetings/history endpoint', () => {
    it('returns meetings in date range with default ±7 days', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/history`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.meetings).toHaveLength(2);
      expect(payload.meetings[0].title).toBe('Team Standup');
      expect(payload.meetings[0].transcriptStatus).toBe('captured');
      expect(payload.count).toBe(2);
      expect(payload.range).toBeDefined();
      expect(getMeetingsInRange).toHaveBeenCalled();
    });

    it('accepts custom date range', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/history`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: '2026-01-10T00:00:00Z',
          endDate: '2026-01-20T00:00:00Z'
        })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(getMeetingsInRange).toHaveBeenCalledWith(
        new Date('2026-01-10T00:00:00Z'),
        new Date('2026-01-20T00:00:00Z')
      );
    });

    it('rejects invalid date format', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/history`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: 'not-a-date' })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('Invalid date format');
    });
  });

  describe('meetings/missed endpoint', () => {
    it('returns missed meetings with default 7 days', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/missed`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.meetings).toHaveLength(1);
      expect(payload.meetings[0].title).toBe('Client Call');
      expect(payload.meetings[0].transcriptStatus).toBe('missed');
      expect(payload.count).toBe(1);
      expect(payload.since).toBeDefined();
      expect(getMissedMeetings).toHaveBeenCalled();
    });

    it('accepts custom since date', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/missed`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ since: '2026-01-01T00:00:00Z' })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(getMissedMeetings).toHaveBeenCalledWith(new Date('2026-01-01T00:00:00Z'));
    });

    it('rejects invalid date format', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/missed`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ since: 'invalid' })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('Invalid date format');
    });
  });

  describe('meetings/schedule-bot endpoint', () => {
    it('returns 503 when meeting bot service not available', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/schedule-bot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingUrl: 'https://zoom.us/j/123' })
      });
      expect(res.status).toBe(503);
      const payload = await res.json();
      expect(payload.error).toContain('not available');
    });

    it('schedules bot when service is available', async () => {
      setMeetingBotServiceGetter(() => ({
        sendBot: mockSendBot,
      } as any));

      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/schedule-bot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingUrl: 'https://zoom.us/j/123456',
          meetingTitle: 'Test Meeting',
        })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.botId).toBe('bot_123');
      expect(mockSendBot).toHaveBeenCalledWith({
        meetingUrl: 'https://zoom.us/j/123456',
        meetingTitle: 'Test Meeting',
        scheduledFor: undefined,
      });
    });

    it('rejects missing meetingUrl', async () => {
      setMeetingBotServiceGetter(() => ({
        sendBot: mockSendBot,
      } as any));

      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/schedule-bot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingTitle: 'No URL' })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('meetingUrl is required');
    });

    it('returns error when sendBot fails', async () => {
      setMeetingBotServiceGetter(() => ({
        sendBot: vi.fn(() => Promise.resolve({ success: false, error: 'Not authenticated' })),
      } as any));

      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/schedule-bot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingUrl: 'https://zoom.us/j/123' })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.success).toBe(false);
      expect(payload.error).toBe('Not authenticated');
    });

    it('rejects invalid scheduledFor date', async () => {
      setMeetingBotServiceGetter(() => ({
        sendBot: mockSendBot,
      } as any));

      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/meetings/schedule-bot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingUrl: 'https://zoom.us/j/123',
          scheduledFor: 'not-a-date'
        })
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('valid ISO 8601 date');
    });
  });

  describe('POST /conversations/start', () => {
    it('broadcasts conversations:start-requested with correct payload', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello from MCP' })
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.sessionId).toBeDefined();
      expect(payload.url).toMatch(/^rebel:\/\/conversation\//);
      expect(mockSendToAllWindows).toHaveBeenCalledWith(
        'conversations:start-requested',
        expect.objectContaining({
          sessionId: payload.sessionId,
          text: 'Hello from MCP',
          sendMessage: true,
          switchToConversation: false
        })
      );
    });

    it('respects sendMessage=false and switchToConversation=true', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Draft only', sendMessage: false, switchToConversation: true })
      });
      expect(res.status).toBe(200);
      expect(mockSendToAllWindows).toHaveBeenCalledWith(
        'conversations:start-requested',
        expect.objectContaining({
          text: 'Draft only',
          sendMessage: false,
          switchToConversation: true
        })
      );
    });

    it('rejects missing text', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.error).toContain('text is required');
    });

    it('rejects empty text', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '   ' })
      });
      expect(res.status).toBe(400);
    });

    it('trims text before broadcasting', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await fetch(`http://127.0.0.1:${port}/conversations/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '  padded text  ' })
      });
      expect(res.status).toBe(200);
      expect(mockSendToAllWindows).toHaveBeenCalledWith(
        'conversations:start-requested',
        expect.objectContaining({
          text: 'padded text'
        })
      );
    });
  });

  describe('POST /contribution/report-state — Stage 2.5 evidence gate', () => {
    // The gate prevents the bridge from minting a ready_to_submit contribution
    // on path-presence alone when no prior testing record exists. At least one
    // real-world evidence signal (test-pass / add-server-observer /
    // auto-check-success) must be present in the signal registry for the
    // session+path; pure agent-tool-call intent (which the /report-state call
    // itself is) does NOT satisfy the gate.

    const DIRECT_CREATE_PATH = `${os.homedir()}/mcp-servers/gate-test-connector`;
    const NON_CANONICAL_PATH = `${os.homedir()}/Documents/Rebel/Chief-of-Staff/scripts/fibonacci-mcp`;

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

    beforeEach(async () => {
      const { _resetStore } = await import('@core/services/contributionStore');
      const { _resetMutexesForTest } = await import(
        '@core/services/contributionObservationService'
      );
      _resetStore();
      _resetMutexesForTest();
    });

    it('create at draft with no prior record → 200, created at draft (gate does not apply)', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-1',
        connectorName: 'gate-test-1',
        status: 'draft',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      expect(payload.status).toBe('draft');
      expect(payload.created).toBe(true);
      expect(payload.promotionDecision).toBeUndefined();

      const { getContributionBySession } = await import(
        '@core/services/contributionStore'
      );
      const record = getContributionBySession('session-gate-1');
      expect(record?.status).toBe('draft');
      expect(record?.lastTransitionError).toBeUndefined();
    });

    it('create at ready_to_submit with no signals → 202, created at draft with structured lastTransitionError', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-2',
        connectorName: 'gate-test-2',
        status: 'ready_to_submit',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(res.status).toBe(202);
      const payload = await res.json();
      expect(payload.success).toBe(true);
      // Stage 3.E (260426): direct-create at ready_to_submit creates `draft`
      // (not `testing`) per matrix #22 realignment.
      expect(payload.status).toBe('draft');
      expect(payload.created).toBe(true);
      expect(payload.promotionDecision).toBe('deferred');
      expect(payload.promotionReason).toBe('evidence-insufficient');
      expect(typeof payload.guidance).toBe('string');

      const { getContributionBySession } = await import(
        '@core/services/contributionStore'
      );
      const record = getContributionBySession('session-gate-2');
      expect(record?.status).toBe('draft');
      expect(record?.lastTransitionError).toBeDefined();
      const parsed = JSON.parse(record!.lastTransitionError!);
      expect(parsed.reason).toBe('evidence-insufficient');
      expect(parsed.requestedStatus).toBe('ready_to_submit');
    });

    it('Stage 3.E: direct-create at ready_to_submit always defers to draft (gate is gone)', async () => {
      // Stage 3.E (260426): the legacy "evidence gate" is replaced by the
      // reducer's `lastReadyRequestedAt + (lastTestPassedAt OR
      // lastRegisteredAt) + fingerprint` predicate. The bridge stamps
      // lastReadyRequestedAt durably; subsequent test-pass / add-server
      // observations satisfy the predicate.
      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-3',
        connectorName: 'gate-test-3',
        status: 'ready_to_submit',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(res.status).toBe(202);
      const payload = await res.json();
      expect(payload.status).toBe('draft');
      expect(payload.created).toBe(true);

      const { getContributionBySession } = await import(
        '@core/services/contributionStore'
      );
      const record = getContributionBySession('session-gate-3');
      expect(record?.status).toBe('draft');
      // The bridge fired `ready_requested` so lastReadyRequestedAt is set.
      expect(record?.lastReadyRequestedAt).toBeDefined();
    });

    it('Stage 3.E: pre-seeded testing record with full evidence promotes via observation', async () => {
      const {
        createContribution,
        setLastTestPassedAt,
        setLastRegisteredAt,
      } = await import('@core/services/contributionStore');
      const created = createContribution({
        sessionId: 'session-gate-4',
        connectorName: 'gate-test-4',
        status: 'testing',
        attributionMode: 'anonymous',
        localServerPath: DIRECT_CREATE_PATH,
      });
      setLastTestPassedAt(created.id, '2026-04-26T11:00:00.000Z');
      setLastRegisteredAt(created.id, '2026-04-26T10:30:00.000Z');

      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-4',
        connectorName: 'gate-test-4',
        status: 'ready_to_submit',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.status).toBe('ready_to_submit');
    });

    it('Stage 3.E: direct-create at ready_to_submit stamps durable lastReadyRequestedAt', async () => {
      const { port, token } = await startBundledInboxBridge();
      // First request — defers to draft, stamps lastReadyRequestedAt.
      const first = await postReportState(port, token, {
        sessionId: 'session-gate-5',
        connectorName: 'gate-test-5',
        status: 'ready_to_submit',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(first.status).toBe(202);
      const firstPayload = await first.json();

      // Stage 3 invariant: lastReadyRequestedAt persists durably so a
      // future test_passed observation can satisfy the predicate
      // without the agent needing to re-issue ready_to_submit.
      const { getContributionById } = await import(
        '@core/services/contributionStore'
      );
      const record = getContributionById(firstPayload.contributionId);
      expect(record?.status).toBe('draft');
      expect(record?.lastReadyRequestedAt).toBeDefined();
    });

    it('existing testing record + ready_to_submit report with full evidence pre-seeded → promotes via observeContribution', async () => {
      const {
        createContribution,
        setLastTestPassedAt,
      } = await import('@core/services/contributionStore');
      const existing = createContribution({
        sessionId: 'session-gate-6',
        connectorName: 'gate-test-6',
        status: 'testing',
        attributionMode: 'anonymous',
        localServerPath: DIRECT_CREATE_PATH,
      });
      // Pre-seed evidence so the predicate fires.
      setLastTestPassedAt(existing.id, '2026-04-26T11:00:00.000Z');

      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-6',
        connectorName: 'gate-test-6',
        status: 'ready_to_submit',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.status).toBe('ready_to_submit');
      expect(payload.created).toBe(false);
      expect(payload.promotionDecision).toBe('updated');

      const { getContributionById } = await import(
        '@core/services/contributionStore'
      );
      expect(getContributionById(existing.id)!.status).toBe('ready_to_submit');
    });

    it('existing testing record + ready_to_submit + non-canonical path → 202 deferred with structured non-canonical error', async () => {
      const { createContribution, getContributionById } = await import(
        '@core/services/contributionStore'
      );
      const existing = createContribution({
        sessionId: 'session-gate-6b',
        connectorName: 'gate-test-6b',
        status: 'testing',
        attributionMode: 'anonymous',
        localServerPath: NON_CANONICAL_PATH,
      });

      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-6b',
        connectorName: 'gate-test-6b',
        status: 'ready_to_submit',
        localServerPath: NON_CANONICAL_PATH,
      });

      expect(res.status).toBe(202);
      const payload = await res.json();
      expect(payload.status).toBe('testing');
      expect(payload.created).toBe(false);
      expect(payload.promotionDecision).toBe('deferred');
      expect(payload.promotionReason).toBe('non-canonical-path');
      expect(typeof payload.guidance).toBe('string');

      const updated = getContributionById(existing.id)!;
      expect(updated.status).toBe('testing');
      const parsed = JSON.parse(updated.lastTransitionError ?? '{}');
      expect(parsed.reason).toBe('non-canonical-path');
      expect(parsed.observedPath).toBe(NON_CANONICAL_PATH);
    });

    it('new create + ready_to_submit + non-canonical path → 202 deferred with non-canonical error', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-6c',
        connectorName: 'gate-test-6c',
        status: 'ready_to_submit',
        localServerPath: NON_CANONICAL_PATH,
      });

      expect(res.status).toBe(202);
      const payload = await res.json();
      // Stage 3.E: direct-create at ready_to_submit creates `draft`.
      expect(payload.status).toBe('draft');
      expect(payload.created).toBe(true);
      expect(payload.promotionDecision).toBe('deferred');
      expect(payload.promotionReason).toBe('non-canonical-path');

      const { getContributionBySession } = await import(
        '@core/services/contributionStore'
      );
      const record = getContributionBySession('session-gate-6c');
      expect(record?.status).toBe('draft');
      const parsed = JSON.parse(record?.lastTransitionError ?? '{}');
      expect(parsed.reason).toBe('non-canonical-path');
      expect(parsed.observedPath).toBe(NON_CANONICAL_PATH);
    });

    it('new create + ready_to_submit + relative localServerPath → 202 deferred via canonical-path gate', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-6c-relative',
        connectorName: 'gate-test-6c-relative',
        status: 'ready_to_submit',
        localServerPath: './relative/path',
      });

      expect(res.status).toBe(202);
      const payload = await res.json();
      // Stage 3.E: direct-create at ready_to_submit creates `draft`.
      expect(payload.status).toBe('draft');
      expect(payload.created).toBe(true);
      expect(payload.promotionDecision).toBe('deferred');
      expect(payload.promotionReason).toBe('non-canonical-path');
    });

    it('rejects empty localServerPath with 400', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-empty-path',
        connectorName: 'gate-test-empty-path',
        status: 'ready_to_submit',
        localServerPath: '',
      });

      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload.success).toBe(false);
      expect(payload.error).toContain('localServerPath');
    });

    it('new create + testing + non-canonical path passes through as testing', async () => {
      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-6d',
        connectorName: 'gate-test-6d',
        status: 'testing',
        localServerPath: NON_CANONICAL_PATH,
      });

      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.status).toBe('testing');
      expect(payload.created).toBe(true);

      const { getContributionBySession } = await import(
        '@core/services/contributionStore'
      );
      const record = getContributionBySession('session-gate-6d');
      expect(record?.status).toBe('testing');
      expect(record?.lastTransitionError).toBeUndefined();
    });

    it('existing testing record + ci_pass report → direct-update path (non-promotion status, gate does not apply)', async () => {
      // Set up via: testing → ready_to_submit → submitted → ci_pass path is
      // not valid; instead use the more realistic existing testing → ci_fail
      // path which IS valid per VALID_STATE_TRANSITIONS? It isn't. Testing
      // only transitions to ready_to_submit. To exercise a non-promotion
      // direct-update we seed an already-submitted record and transition to
      // ci_pass.
      const { createContribution } = await import(
        '@core/services/contributionStore'
      );
      const existing = createContribution({
        sessionId: 'session-gate-7',
        connectorName: 'gate-test-7',
        status: 'submitted',
        attributionMode: 'anonymous',
        localServerPath: DIRECT_CREATE_PATH,
      });

      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-7',
        connectorName: 'gate-test-7',
        status: 'ci_pass',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.status).toBe('ci_pass');
      expect(payload.created).toBe(false);

      const { getContributionById } = await import(
        '@core/services/contributionStore'
      );
      expect(getContributionById(existing.id)!.status).toBe('ci_pass');
    });

    it('clears stale non-canonical-path error when existing testing record is corrected to canonical path', async () => {
      const { createContribution, updateContribution, getContributionById } = await import(
        '@core/services/contributionStore'
      );
      const existing = createContribution({
        sessionId: 'session-gate-clear-testing',
        connectorName: 'gate-test-clear-testing',
        status: 'testing',
        attributionMode: 'anonymous',
        localServerPath: NON_CANONICAL_PATH,
      });
      updateContribution(existing.id, {
        lastTransitionError: JSON.stringify({
          reason: 'non-canonical-path',
          observedPath: NON_CANONICAL_PATH,
        }),
      });

      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-clear-testing',
        connectorName: 'gate-test-clear-testing',
        status: 'ready_to_submit',
        localServerPath: DIRECT_CREATE_PATH,
      });

      expect(res.status).toBe(200);
      const updated = getContributionById(existing.id)!;
      expect(updated.localServerPath).toBe(DIRECT_CREATE_PATH);
      expect(updated.lastTransitionError).toBeUndefined();
    });

    it('clears stale non-canonical-path error on non-ready direct-update when path is corrected to canonical', async () => {
      const { createContribution, updateContribution, getContributionById } = await import(
        '@core/services/contributionStore'
      );
      const existing = createContribution({
        sessionId: 'session-gate-clear-direct',
        connectorName: 'gate-test-clear-direct',
        status: 'submitted',
        attributionMode: 'anonymous',
        localServerPath: NON_CANONICAL_PATH,
      });
      updateContribution(existing.id, {
        lastTransitionError: JSON.stringify({
          reason: 'non-canonical-path',
          observedPath: NON_CANONICAL_PATH,
        }),
      });

      const { port, token } = await startBundledInboxBridge();
      const res = await postReportState(port, token, {
        sessionId: 'session-gate-clear-direct',
        connectorName: 'gate-test-clear-direct',
        status: 'submitted',
        localServerPath: DIRECT_CREATE_PATH,
      });

      expect(res.status).toBe(200);
      const updated = getContributionById(existing.id)!;
      expect(updated.status).toBe('submitted');
      expect(updated.localServerPath).toBe(DIRECT_CREATE_PATH);
      expect(updated.lastTransitionError).toBeUndefined();
    });

    it('Stage 3.E eventually-consistent: ready_requested defers, then a test_passed observation flips the predicate', async () => {
      const { port, token } = await startBundledInboxBridge();

      // First call: defers to draft (no evidence yet), but stamps
      // `lastReadyRequestedAt` durably.
      const res1 = await postReportState(port, token, {
        sessionId: 'session-gate-8',
        connectorName: 'gate-test-8',
        status: 'ready_to_submit',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(res1.status).toBe(202);
      const payload1 = await res1.json();
      const contributionId = payload1.contributionId;

      const { getContributionById, setLastTestPassedAt } = await import(
        '@core/services/contributionStore'
      );
      expect(getContributionById(contributionId)!.status).toBe('draft');

      // Stage 3.E: emit a `test_passed` observation by stamping the field
      // directly + re-firing ready_requested via the bridge. The reducer's
      // predicate now satisfies (lastReadyRequestedAt + lastTestPassedAt
      // + fingerprint fail-open).
      setLastTestPassedAt(contributionId, '2026-04-26T11:00:00.000Z');

      // Re-issue ready_requested so the predicate evaluates.
      // Stage 3.E: ready_requested observation only fires on existing
      // `testing` records. The previous request created `draft`, so we
      // must promote draft→testing first via the `testing` status path
      // (or rely on the fact that the reducer accepts ready_requested
      // from `draft` per state-machine rules). Actually checking the
      // reducer: ready_requested allows status testing/draft/ready_to_submit,
      // and the bridge's mapping creates a fresh ready_requested
      // observation for `isReadyToSubmitReport` only (existing.status ===
      // testing). So we need to bump the record to testing first.
      // For simplicity, transition draft → testing via direct status update
      // path.
      const transitionRes = await postReportState(port, token, {
        sessionId: 'session-gate-8',
        connectorName: 'gate-test-8',
        status: 'testing',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(transitionRes.status).toBe(200);

      // Now the record is at testing. Fire ready_requested.
      const res2 = await postReportState(port, token, {
        sessionId: 'session-gate-8',
        connectorName: 'gate-test-8',
        status: 'ready_to_submit',
        localServerPath: DIRECT_CREATE_PATH,
      });
      expect(res2.status).toBe(200);
      expect(getContributionById(contributionId)!.status).toBe('ready_to_submit');
    });

    // ─── Stage 2.D path-first / cross-session linking ────────────

    it('Stage 2.D: cross-session report-state at same canonical path links the new session and operates on the original record', async () => {
      const SHARED_PATH = `${os.homedir()}/mcp-servers/cross-session-bridge`;
      const { port, token } = await startBundledInboxBridge();

      // Session A creates the record at draft.
      const resA = await postReportState(port, token, {
        sessionId: 'session-cross-A',
        connectorName: 'cross-session-bridge',
        status: 'draft',
        localServerPath: SHARED_PATH,
      });
      expect(resA.status).toBe(200);
      const payloadA = await resA.json();
      expect(payloadA.created).toBe(true);
      const idA = payloadA.contributionId;

      // Session B reports at the same path: path-first lookup must match
      // record-A and append session-B to linkedSessionIds. NO new record.
      const resB = await postReportState(port, token, {
        sessionId: 'session-cross-B',
        connectorName: 'cross-session-bridge',
        status: 'draft',
        localServerPath: SHARED_PATH,
      });
      expect(resB.status).toBe(200);
      const payloadB = await resB.json();
      // Same record id — no double-create.
      expect(payloadB.contributionId).toBe(idA);
      // The path-first / re-read by id contract means the response reflects
      // the original record's state (still draft, not "created").
      expect(payloadB.status).toBe('draft');

      // The store record now contains both sessions in linkedSessionIds.
      const { getContributionById } = await import(
        '@core/services/contributionStore'
      );
      const record = getContributionById(idA);
      expect(record?.linkedSessionIds).toContain('session-cross-A');
      expect(record?.linkedSessionIds).toContain('session-cross-B');
    });
  });

});

function installDiagnosticEventsReader(events: DiagnosticEventEntry[]): void {
  setDiagnosticEventsLedgerReader({
    readRecent: vi.fn(async () => events),
  });
}

function emptyRecentLogsResult(): RecentLogsTailResult {
  return {
    content: '',
    lines: 0,
    bytesReturned: 0,
    bytesAvailable: 0,
    truncated: false,
    filesRead: [],
    errors: [],
  };
}

async function setTestMtime(filePath: string, order: number): Promise<void> {
  const date = new Date(1_700_000_000_000 + order * 1000);
  await fs.utimes(filePath, date, date);
}

function cooldownEnter(ts: number): DiagnosticEventEntry {
  return {
    ...baseDiagnosticEvent(ts),
    kind: 'cooldown_enter',
    data: {
      scope: 'api',
      untilMs: ts + 1000,
      retryAfterProvided: false,
      durationMs: 1000,
    },
  };
}

function abortEvent(ts: number): DiagnosticEventEntry {
  return {
    ...baseDiagnosticEvent(ts),
    kind: 'abort_event',
    data: {
      reason: 'user_cancel',
      durationBucketMs: 1_000,
    },
  };
}

function knownCondition(ts: number): DiagnosticEventEntry {
  return {
    ...baseDiagnosticEvent(ts),
    kind: 'known_condition',
    data: {
      condition: 'model_error',
      level: 'warning',
    },
  };
}

function baseDiagnosticEvent(ts: number) {
  return {
    v: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
    ts,
    surface: 'desktop' as const,
    tid: 'turn_1',
    sid: 'session_1',
  };
}
