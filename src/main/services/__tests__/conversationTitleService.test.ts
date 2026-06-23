import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sanitizeGeneratedTitle,
  isDefaultOrFallbackTitle,
  countCompletedTurns,
  processAutoTitle,
  maybeGenerateSessionTitle,
  DEFAULT_SESSION_TITLES,
} from '../conversationTitleService';
import type { AgentTurnMessage, AppSettings } from '@shared/types';

// Mock the behind-the-scenes client used by generateConversationTitle
vi.mock('@core/services/behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(),
  getEffectiveModelName: vi.fn(() => 'claude-3-haiku'),
}));

vi.mock('@core/utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

const mockCallBehindTheScenes = vi.mocked(
  (await import('@core/services/behindTheScenesClient')).callBehindTheScenesWithAuth,
);

const makeMessage = (
  overrides: Partial<AgentTurnMessage> & { role: AgentTurnMessage['role']; text: string },
): AgentTurnMessage => ({
  id: overrides.id ?? '1',
  turnId: overrides.turnId ?? 't1',
  role: overrides.role,
  text: overrides.text,
  createdAt: overrides.createdAt ?? 1,
});

const mockSettings = {} as AppSettings;
const getSettings = () => mockSettings;

describe('sanitizeGeneratedTitle', () => {
  it('strips code fences and conversational prefixes', () => {
    const raw = `\`\`\`
conversation title:   Ship Design Review Update 2025 Plan   
\`\`\``;
    expect(sanitizeGeneratedTitle(raw)).toBe('Ship Design Review');
  });

  it('limits the title to the first three expressive words', () => {
    const raw = 'title:  Very   long    set   of   words we should not keep entirely';
    expect(sanitizeGeneratedTitle(raw)).toBe('Very long set');
  });

  it('enforces the maximum character budget when words are very long', () => {
    const raw =
      'RapidFailoverHyperparameterizationFramework Diagnostics Playbook Initiative Kickoff';
    const sanitized = sanitizeGeneratedTitle(raw);
    expect(sanitized.length).toBeLessThanOrEqual(48);
    expect(sanitized.startsWith('RapidFailoverHyperparameterizationFramework')).toBe(true);
  });

  it('returns an empty string when no meaningful text remains', () => {
    expect(sanitizeGeneratedTitle('   ')).toBe('');
    expect(sanitizeGeneratedTitle('title: ---')).toBe('');
  });
});

describe('DEFAULT_SESSION_TITLES', () => {
  it('contains expected defaults', () => {
    expect(DEFAULT_SESSION_TITLES.has('New Agent Run')).toBe(true);
    expect(DEFAULT_SESSION_TITLES.has('New conversation')).toBe(true);
  });
});

describe('isDefaultOrFallbackTitle', () => {
  it('returns true for "New Agent Run"', () => {
    expect(isDefaultOrFallbackTitle('New Agent Run', [])).toBe(true);
  });

  it('returns true for "New conversation"', () => {
    expect(isDefaultOrFallbackTitle('New conversation', [])).toBe(true);
  });

  it('returns true for "Conversation 3"', () => {
    expect(isDefaultOrFallbackTitle('Conversation 3', [])).toBe(true);
  });

  it('returns true for "Conversation 123"', () => {
    expect(isDefaultOrFallbackTitle('Conversation 123', [])).toBe(true);
  });

  it('returns false for "Conversation" without number', () => {
    expect(isDefaultOrFallbackTitle('Conversation', [])).toBe(false);
  });

  it('returns true for fallback from first user message', () => {
    const messages = [makeMessage({ role: 'user', text: 'Hello world' })];
    expect(isDefaultOrFallbackTitle('Hello world', messages)).toBe(true);
  });

  it('returns true for truncated fallback title', () => {
    const longText = 'A'.repeat(100);
    const messages = [makeMessage({ role: 'user', text: longText })];
    const expectedFallback = longText.slice(0, 54).trim() + '…';
    expect(isDefaultOrFallbackTitle(expectedFallback, messages)).toBe(true);
  });

  it('returns true for fallback from first non-user message when no user messages', () => {
    const messages = [makeMessage({ role: 'assistant', text: 'I can help you with that' })];
    expect(isDefaultOrFallbackTitle('I can help you with that', messages)).toBe(true);
  });

  it('returns false for a real generated title', () => {
    const messages = [makeMessage({ role: 'user', text: 'Hello world' })];
    expect(isDefaultOrFallbackTitle('Project Setup Discussion', messages)).toBe(false);
  });

  it('returns false for a manually set title', () => {
    const messages = [makeMessage({ role: 'user', text: 'Help me with my project' })];
    expect(isDefaultOrFallbackTitle('My Important Project', messages)).toBe(false);
  });
});

describe('isDefaultOrFallbackTitle — extended detection', () => {
  it('returns true for empty string title', () => {
    expect(isDefaultOrFallbackTitle('', [])).toBe(true);
  });

  it('returns true for whitespace-only title', () => {
    expect(isDefaultOrFallbackTitle('   ', [])).toBe(true);
  });

  it('returns true for title matching first user message exactly', () => {
    const messages = [makeMessage({ role: 'user', text: 'Help me with my budget review' })];
    expect(isDefaultOrFallbackTitle('Help me with my budget review', messages)).toBe(true);
  });

  it('returns true for title that is a long truncation of first message', () => {
    const longMsg = 'This is a really long first message that would be truncated at some point';
    const messages = [makeMessage({ role: 'user', text: longMsg })];
    expect(isDefaultOrFallbackTitle('This is a really long first me', messages)).toBe(true);
  });

  it('returns false for short title even if first message starts with it', () => {
    const messages = [makeMessage({ role: 'user', text: 'Budget review for Q2 planning and analysis' })];
    expect(isDefaultOrFallbackTitle('Budget', messages)).toBe(false);
  });

  it('returns false for LLM-generated title', () => {
    const messages = [makeMessage({ role: 'user', text: 'Can you help me review the Q2 budget?' })];
    expect(isDefaultOrFallbackTitle('Budget Review', messages)).toBe(false);
  });
});

describe('countCompletedTurns', () => {
  it('returns 0 for empty eventsByTurn', () => {
    expect(countCompletedTurns({})).toBe(0);
  });

  it('counts only turns with result events', () => {
    const eventsByTurn = {
      t1: [{ type: 'result', text: 'done', timestamp: 1 }],
      t2: [{ type: 'error', error: 'fail', timestamp: 2 }],
      t3: [{ type: 'result', text: 'done', timestamp: 3 }],
    };
    expect(countCompletedTurns(eventsByTurn as any)).toBe(2);
  });

  it('caps counting at threshold (5)', () => {
    const eventsByTurn: Record<string, any[]> = {};
    for (let i = 0; i < 10; i++) {
      eventsByTurn[`t${i}`] = [{ type: 'result', text: 'done', timestamp: i }];
    }
    expect(countCompletedTurns(eventsByTurn as any)).toBe(5);
  });
});

describe('processAutoTitle', () => {
  const mockGetSettings = () => ({ claude: { apiKey: 'test-key' } } as any);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when title is not default and turn count < 5', async () => {
    const session = {
      title: 'Budget Review',
      messages: [
        makeMessage({ role: 'user', text: 'Help me review the budget' }),
        makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'Sure!' }),
      ],
      eventsByTurn: { t1: [{ type: 'result', text: 'done', timestamp: 1 }] },
    };
    const result = await processAutoTitle(session as any, { getSettings: mockGetSettings });
    expect(result).toBeNull();
  });

  it('returns initial title for default-titled session', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Budget Review' }],
    } as any);

    const session = {
      title: 'New conversation',
      messages: [
        makeMessage({ role: 'user', text: 'Help me review the budget' }),
        makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'Sure!' }),
      ],
      eventsByTurn: { t1: [{ type: 'result', text: 'done', timestamp: 1 }] },
    };
    const result = await processAutoTitle(session as any, { getSettings: mockGetSettings });
    expect(result).toEqual({ title: 'Budget Review', reason: 'initial', turnCount: 1 });
  });

  it('returns retitle when turn count >= 5 and was auto-titled', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Project Planning' }],
    } as any);

    const eventsByTurn: Record<string, any[]> = {};
    for (let i = 0; i < 5; i++) {
      eventsByTurn[`t${i}`] = [{ type: 'result', text: 'done', timestamp: i }];
    }
    const session = {
      title: 'Budget Review',
      messages: [
        makeMessage({ role: 'user', text: 'Help me review the budget' }),
        makeMessage({ id: '2', turnId: 't1', role: 'result', text: 'Here is the budget analysis' }),
        makeMessage({ id: '3', turnId: 't2', role: 'user', text: 'Now help with the project plan' }),
        makeMessage({ id: '4', turnId: 't3', role: 'result', text: 'Here is the project plan' }),
      ],
      eventsByTurn,
      autoTitleGeneratedAt: 1000,
      autoTitleTurnCount: 1,
    };
    const result = await processAutoTitle(session as any, { getSettings: mockGetSettings });
    expect(result).toEqual({ title: 'Project Planning', reason: 'retitle', turnCount: 5 });
  });

  it('returns null for retitle when autoTitleGeneratedAt is not set (manual rename)', async () => {
    const eventsByTurn: Record<string, any[]> = {};
    for (let i = 0; i < 5; i++) {
      eventsByTurn[`t${i}`] = [{ type: 'result', text: 'done', timestamp: i }];
    }
    const session = {
      title: 'My Custom Title',
      messages: [
        makeMessage({ role: 'user', text: 'Hello' }),
        makeMessage({ id: '2', turnId: 't1', role: 'result', text: 'Hi!' }),
      ],
      eventsByTurn,
    };
    const result = await processAutoTitle(session as any, { getSettings: mockGetSettings });
    expect(result).toBeNull();
  });

  it('returns null when already retitled at turn 5+', async () => {
    const eventsByTurn: Record<string, any[]> = {};
    for (let i = 0; i < 6; i++) {
      eventsByTurn[`t${i}`] = [{ type: 'result', text: 'done', timestamp: i }];
    }
    const session = {
      title: 'Project Planning',
      messages: [
        makeMessage({ role: 'user', text: 'Hello' }),
        makeMessage({ id: '2', turnId: 't1', role: 'result', text: 'Hi!' }),
      ],
      eventsByTurn,
      autoTitleGeneratedAt: 2000,
      autoTitleTurnCount: 5,
    };
    const result = await processAutoTitle(session as any, { getSettings: mockGetSettings });
    expect(result).toBeNull();
  });
});

describe('maybeGenerateSessionTitle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for sessions with real titles', async () => {
    const session = {
      title: 'Project Setup Discussion',
      messages: [
        makeMessage({ role: 'user', text: 'Hello' }),
        makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'Hi there' }),
      ],
    };
    const result = await maybeGenerateSessionTitle(session, getSettings);
    expect(result).toBeNull();
    expect(mockCallBehindTheScenes).not.toHaveBeenCalled();
  });

  it('returns null for sessions without user messages', async () => {
    const session = {
      title: 'New conversation',
      messages: [
        makeMessage({ role: 'assistant', text: 'Hi there' }),
      ],
    };
    const result = await maybeGenerateSessionTitle(session, getSettings);
    expect(result).toBeNull();
  });

  it('returns null for sessions without assistant messages', async () => {
    const session = {
      title: 'New Agent Run',
      messages: [
        makeMessage({ role: 'user', text: 'Hello' }),
      ],
    };
    const result = await maybeGenerateSessionTitle(session, getSettings);
    expect(result).toBeNull();
  });

  it('calls generateConversationTitle for eligible sessions', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Setup Discussion' }],
    } as any);

    const session = {
      title: 'New conversation',
      messages: [
        makeMessage({ role: 'user', text: 'Help me set up my project' }),
        makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'I can help with that!' }),
      ],
    };

    const result = await maybeGenerateSessionTitle(session, getSettings);
    expect(result).toBe('Setup Discussion');
    expect(mockCallBehindTheScenes).toHaveBeenCalledTimes(1);
  });

  it('returns null when generateConversationTitle fails', async () => {
    mockCallBehindTheScenes.mockRejectedValueOnce(new Error('API error'));

    const session = {
      title: 'New Agent Run',
      messages: [
        makeMessage({ role: 'user', text: 'Hello' }),
        makeMessage({ id: '2', turnId: 't1', role: 'result', text: 'Done' }),
      ],
    };

    const result = await maybeGenerateSessionTitle(session, getSettings);
    expect(result).toBeNull();
  });

  it('generates title for fallback-titled sessions', async () => {
    mockCallBehindTheScenes.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Project Help' }],
    } as any);

    const session = {
      title: 'Help me set up my project',
      messages: [
        makeMessage({ role: 'user', text: 'Help me set up my project' }),
        makeMessage({ id: '2', turnId: 't1', role: 'assistant', text: 'Sure thing!' }),
      ],
    };

    const result = await maybeGenerateSessionTitle(session, getSettings);
    expect(result).toBe('Project Help');
  });
});
