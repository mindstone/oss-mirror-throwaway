 
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';

const {
  registeredHandlers,
  readContentMock,
  recordFailureMock,
} = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  readContentMock: vi.fn(),
  recordFailureMock: vi.fn(),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => {
    registeredHandlers.set(channel, handler);
  },
}));

vi.mock('@core/contentStore', () => ({
  getContentStore: () => ({
    readContent: (...args: unknown[]) => readContentMock(...args),
  }),
}));

vi.mock('@core/services/contentResolutionFailureRecorder', () => ({
  recordContentResolutionFailure: (...args: unknown[]) => recordFailureMock(...args),
}));

vi.mock('../../services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    listSessions: vi.fn(() => []),
    getSession: vi.fn(async () => null),
    upsertSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    updateSession: vi.fn(async () => false),
  }),
}));

vi.mock('../../services/conversationIndexService', () => ({
  onSessionsSaved: vi.fn(async (_sessions: AgentSession[]) => undefined),
}));

vi.mock('../../services/toolSafetyService', () => ({
  cleanupSessionPendingApprovals: vi.fn(),
}));

vi.mock('../../services/mcpAppModelContextStore', () => ({
  mcpAppModelContextStore: {
    cleanupConversation: vi.fn(),
  },
}));

vi.mock('../../services/mcpAppsTrust', () => ({
  cleanupConversation: vi.fn(),
  invalidateForConversation: vi.fn(),
  invalidateForSession: vi.fn(),
}));

vi.mock('../../services/diagnosticContextService', () => ({
  getDiagnosticSummary: vi.fn(async () => null),
}));

vi.mock('../../services/conversationSummaryService', () => ({
  generateConversationSummary: vi.fn(async () => null),
}));

vi.mock('@core/services/narrativeAnalysisService', () => ({
  generateNarrativeAnalysis: vi.fn(async () => null),
}));

vi.mock('../../services/conversationLogExportService', () => ({
  exportConversationLogs: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../settingsStore', () => ({
  getSettings: vi.fn(() => ({ coreDirectory: '/workspace' })),
}));

vi.mock('@core/logger', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { registerSessionsHandlers } from '../sessionsHandlers';

describe('sessionsHandlers content read channels', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    readContentMock.mockReset();
    recordFailureMock.mockReset();
    registerSessionsHandlers({
      loadAgentSessions: vi.fn(() => []),
      saveAgentSessions: vi.fn(),
      upsertAgentSession: vi.fn(async () => ({ outcome: 'persisted' as const, persistedSessionIds: [], droppedTombstonedSessionIds: [] })),
      sessionLockManager: {
        acquirePerSession: vi.fn(),
        acquireGlobalIndex: vi.fn(),
        acquirePerSessionSync: vi.fn(),
        acquireGlobalIndexSync: vi.fn(),
      },
      sessionLockOwnerKind: 'desktop',
    });
  });

  it('registers both sessions:read-content and content:read channels', () => {
    expect(registeredHandlers.has('sessions:read-content')).toBe(true);
    expect(registeredHandlers.has('content:read')).toBe(true);
  });

  it('returns base64 bytes for ok reads', async () => {
    readContentMock.mockResolvedValue({
      reason: 'ok',
      bytes: Buffer.from('hello', 'utf8'),
      mimeType: 'text/plain',
      byteSize: 5,
    });
    const handler = registeredHandlers.get('sessions:read-content');
    const result = await handler?.({}, { sessionId: 'sess-1', contentId: 'cid-1' });
    expect(result).toEqual({
      reason: 'ok',
      bytesBase64: Buffer.from('hello', 'utf8').toString('base64'),
      mimeType: 'text/plain',
    });
  });

  it('maps not-found to missing for content:read alias', async () => {
    readContentMock.mockResolvedValue({ reason: 'not-found' });
    const handler = registeredHandlers.get('content:read');
    const result = await handler?.({}, { sessionId: 'sess-2', contentId: 'cid-2' });
    expect(result).toEqual({ reason: 'missing' });
  });

  it('maps thrown errors to unknown and records failure', async () => {
    readContentMock.mockRejectedValue(new Error('boom'));
    const handler = registeredHandlers.get('sessions:read-content');
    const result = await handler?.({}, { sessionId: 'sess-3', contentId: 'cid-3' });
    expect(result).toEqual({ reason: 'unknown' });
    expect(recordFailureMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-3',
      contentId: 'cid-3',
      reason: 'unknown',
    }));
  });
});
