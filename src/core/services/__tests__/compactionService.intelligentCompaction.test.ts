import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentTurnMessage } from '@shared/types';
import type { AppSettings } from '@shared/types';

// --- Mocks ---

const { mockCallBts, mockLogger } = vi.hoisted(() => ({
  mockCallBts: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

vi.mock('@core/services/behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBts(...args),
}));

// Must import after mocks
import {
  splitMessagesByWindow,
  compressLongMessage,
  compressOlderMessages,
  generateNarrativeSummary,
  generateIntelligentSummary,
  COMPRESSION_THRESHOLD_CHARS,
  NARRATIVE_COMPRESSION_RATIO,
  SLIDING_WINDOW_TURNS,
  DEPTH_2_WINDOW_TURNS,
  DEPTH_3_WINDOW_TURNS,
} from '../compactionService';

// --- Helpers ---

const mockSettings = {
  claude: { model: 'claude-sonnet-4-20250514' },
} as unknown as AppSettings;

let msgCounter = 0;

function makeMessage(
  overrides: Partial<AgentTurnMessage> & { turnId: string; role: AgentTurnMessage['role'] }
): AgentTurnMessage {
  msgCounter++;
  return {
    id: `msg-${msgCounter}`,
    text: overrides.text ?? `Message ${msgCounter}`,
    createdAt: Date.now() + msgCounter,
    ...overrides,
  };
}

function makeMessages(
  specs: Array<{ turnId: string; role: AgentTurnMessage['role']; text?: string }>
): AgentTurnMessage[] {
  return specs.map((s) => makeMessage(s));
}

// --- Tests ---

describe('splitMessagesByWindow', () => {
  beforeEach(() => {
    msgCounter = 0;
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.debug.mockReset();
  });

  it('returns empty older and recent for empty messages', () => {
    const result = splitMessagesByWindow([], 3);
    expect(result).toEqual({ older: [], recent: [] });
  });

  it('puts all messages in recent when fewer turns than window', () => {
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user' },
      { turnId: 'turn-1', role: 'assistant' },
      { turnId: 'turn-2', role: 'user' },
      { turnId: 'turn-2', role: 'assistant' },
    ]);

    const result = splitMessagesByWindow(messages, 3);
    expect(result.older).toHaveLength(0);
    expect(result.recent).toHaveLength(4);
  });

  it('correctly splits by turnId boundaries with 3-turn window', () => {
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user' },
      { turnId: 'turn-1', role: 'assistant' },
      { turnId: 'turn-2', role: 'user' },
      { turnId: 'turn-2', role: 'assistant' },
      { turnId: 'turn-3', role: 'user' },
      { turnId: 'turn-3', role: 'assistant' },
      { turnId: 'turn-4', role: 'user' },
      { turnId: 'turn-4', role: 'assistant' },
      { turnId: 'turn-5', role: 'user' },
      { turnId: 'turn-5', role: 'assistant' },
    ]);

    const result = splitMessagesByWindow(messages, 3);

    // Older: turns 1-2 (4 messages)
    expect(result.older).toHaveLength(4);
    expect(result.older.every((m) => ['turn-1', 'turn-2'].includes(m.turnId))).toBe(true);

    // Recent: turns 3-5 (6 messages)
    expect(result.recent).toHaveLength(6);
    expect(result.recent.every((m) => ['turn-3', 'turn-4', 'turn-5'].includes(m.turnId))).toBe(true);
  });

  it('keeps messages with same turnId together', () => {
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user' },
      { turnId: 'turn-1', role: 'assistant' },
      { turnId: 'turn-1', role: 'result' },
      { turnId: 'turn-2', role: 'user' },
      { turnId: 'turn-2', role: 'assistant' },
    ]);

    const result = splitMessagesByWindow(messages, 1);

    // Older: turn-1 (3 messages)
    expect(result.older).toHaveLength(3);
    expect(result.older.every((m) => m.turnId === 'turn-1')).toBe(true);

    // Recent: turn-2 (2 messages)
    expect(result.recent).toHaveLength(2);
    expect(result.recent.every((m) => m.turnId === 'turn-2')).toBe(true);
  });

  it('handles window of 1 (depth-2 fallback)', () => {
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user' },
      { turnId: 'turn-1', role: 'assistant' },
      { turnId: 'turn-2', role: 'user' },
      { turnId: 'turn-2', role: 'assistant' },
      { turnId: 'turn-3', role: 'user' },
      { turnId: 'turn-3', role: 'assistant' },
    ]);

    const result = splitMessagesByWindow(messages, 1);

    // Older: turns 1-2 (4 messages)
    expect(result.older).toHaveLength(4);

    // Recent: turn-3 only (2 messages)
    expect(result.recent).toHaveLength(2);
    expect(result.recent.every((m) => m.turnId === 'turn-3')).toBe(true);
  });

  it('treats windowTurns <= 0 as summarizing all messages', () => {
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user' },
      { turnId: 'turn-2', role: 'user' },
    ]);

    const result = splitMessagesByWindow(messages, 0);
    expect(result.older).toHaveLength(2);
    expect(result.recent).toHaveLength(0);
  });

  it('preserves message content across split', () => {
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'Hello' },
      { turnId: 'turn-2', role: 'assistant', text: 'World' },
    ]);

    const result = splitMessagesByWindow(messages, 1);
    expect(result.older[0].text).toBe('Hello');
    expect(result.recent[0].text).toBe('World');
  });
});

describe('compressLongMessage', () => {
  beforeEach(() => {
    mockCallBts.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.debug.mockReset();
  });

  it('returns BTS compressed text on success', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'Compressed version of the message' }],
      model: 'claude-haiku-4-5',
    });

    const result = await compressLongMessage('A very long message text', 'Summarize emails', mockSettings);

    expect(result).toBe('Compressed version of the message');
    expect(mockCallBts).toHaveBeenCalledTimes(1);
  });

  it('falls back to truncation when BTS throws', async () => {
    mockCallBts.mockRejectedValue(new Error('BTS timeout'));

    const longText = 'x'.repeat(5000);
    const result = await compressLongMessage(longText, 'task context', mockSettings);

    expect(result).toContain('x'.repeat(2000));
    expect(result).toContain('[...compressed...]');
  });

  it('falls back to truncation when BTS returns empty content', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: '' }],
      model: 'claude-haiku-4-5',
    });

    const longText = 'y'.repeat(5000);
    const result = await compressLongMessage(longText, 'task context', mockSettings);

    expect(result).toContain('y'.repeat(2000));
    expect(result).toContain('[...compressed...]');
  });

  it('falls back to truncation when BTS returns no text blocks', async () => {
    mockCallBts.mockResolvedValue({
      content: [],
      model: 'claude-haiku-4-5',
    });

    const longText = 'z'.repeat(3000);
    const result = await compressLongMessage(longText, 'task context', mockSettings);

    expect(result).toContain('[...compressed...]');
  });

  it('passes task context to BTS for informed compression', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'compressed' }],
      model: 'test',
    });

    await compressLongMessage('original text', 'Write a quarterly report', mockSettings);

    const callArgs = mockCallBts.mock.calls[0];
    const requestOptions = callArgs[1];
    expect(requestOptions.messages[0].content).toContain('Write a quarterly report');
  });
});

describe('compressOlderMessages', () => {
  beforeEach(() => {
    mockCallBts.mockReset();
    msgCounter = 0;
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.debug.mockReset();
  });

  it('returns unchanged messages when all are below threshold', async () => {
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'Short message' },
      { turnId: 'turn-1', role: 'assistant', text: 'Short reply' },
    ]);

    const result = await compressOlderMessages(messages, 'task', mockSettings);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Short message');
    expect(result[1].text).toBe('Short reply');
    expect(mockCallBts).not.toHaveBeenCalled();
  });

  it('compresses only messages above threshold', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'BTS compressed' }],
      model: 'test',
    });

    const longText = 'x'.repeat(COMPRESSION_THRESHOLD_CHARS + 1);
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'Short message' },
      { turnId: 'turn-1', role: 'assistant', text: longText },
    ]);

    const result = await compressOlderMessages(messages, 'task', mockSettings);

    expect(result[0].text).toBe('Short message'); // unchanged
    expect(result[1].text).toBe('BTS compressed'); // compressed
    expect(mockCallBts).toHaveBeenCalledTimes(1);
  });

  it('handles partial BTS failures gracefully', async () => {
    let callIndex = 0;
    mockCallBts.mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return Promise.resolve({
          content: [{ type: 'text', text: 'Compressed first' }],
          model: 'test',
        });
      }
      return Promise.reject(new Error('BTS failed'));
    });

    const longText1 = 'a'.repeat(COMPRESSION_THRESHOLD_CHARS + 1);
    const longText2 = 'b'.repeat(COMPRESSION_THRESHOLD_CHARS + 1);
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: longText1 },
      { turnId: 'turn-2', role: 'assistant', text: longText2 },
    ]);

    const result = await compressOlderMessages(messages, 'task', mockSettings);

    expect(result[0].text).toBe('Compressed first');
    // Second message falls back to truncation inside compressLongMessage
    expect(result[1].text).toContain('[...compressed...]');
  });

  it('returns empty array for empty input', async () => {
    const result = await compressOlderMessages([], 'task', mockSettings);
    expect(result).toEqual([]);
    expect(mockCallBts).not.toHaveBeenCalled();
  });

  it('preserves message metadata (id, turnId, role, createdAt)', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'compressed' }],
      model: 'test',
    });

    const longText = 'x'.repeat(COMPRESSION_THRESHOLD_CHARS + 1);
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'assistant', text: longText },
    ]);
    const original = messages[0];

    const result = await compressOlderMessages(messages, 'task', mockSettings);

    expect(result[0].id).toBe(original.id);
    expect(result[0].turnId).toBe(original.turnId);
    expect(result[0].role).toBe(original.role);
    expect(result[0].createdAt).toBe(original.createdAt);
    expect(result[0].text).toBe('compressed');
  });
});

describe('generateNarrativeSummary', () => {
  beforeEach(() => {
    mockCallBts.mockReset();
    msgCounter = 0;
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.debug.mockReset();
  });

  it('calls BTS and returns narrative summary text', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'Narrative summary from BTS' }],
      model: 'test',
    });

    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'Need a launch plan.' },
      { turnId: 'turn-1', role: 'assistant', text: 'We agreed to launch next Tuesday.' },
    ]);

    const result = await generateNarrativeSummary(messages, 'launch planning', mockSettings);

    expect(result).toBe('Narrative summary from BTS');
    expect(mockCallBts).toHaveBeenCalledTimes(1);
    const request = mockCallBts.mock.calls[0][1];
    expect(request.messages[0].content).toContain('--- OLDER CONVERSATION ---');
    expect(request.messages[0].content).toContain('[User]: Need a launch plan.');
  });

  it('falls back to formatted older messages when BTS fails', async () => {
    mockCallBts.mockRejectedValue(new Error('BTS unavailable'));

    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'User note' },
      { turnId: 'turn-1', role: 'assistant', text: 'Assistant note' },
    ]);

    const result = await generateNarrativeSummary(messages, 'task context', mockSettings);

    expect(result).toBe('[User]: User note\n\n[Assistant]: Assistant note');
    expect(mockLogger.warn).toHaveBeenCalled();
    const warnCall = mockLogger.warn.mock.calls[0];
    expect(warnCall[0]).toMatchObject({
      olderCount: 2,
      compressibleCount: 0,
      error: 'BTS unavailable',
    });
    expect(warnCall[1]).toContain('Narrative summary generation failed');
  });
});

describe('generateIntelligentSummary', () => {
  beforeEach(() => {
    mockCallBts.mockReset();
    msgCounter = 0;
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.debug.mockReset();
  });

  it('returns empty results for empty messages', async () => {
    const result = await generateIntelligentSummary([], {
      settings: mockSettings,
      taskContext: 'test task',
    });

    expect(result.olderSummary).toBe('');
    expect(result.recentMessages).toEqual([]);
  });

  it('returns all messages as recent with empty summary when all fit in window', async () => {
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'Hello' },
      { turnId: 'turn-1', role: 'assistant', text: 'Hi there' },
      { turnId: 'turn-2', role: 'user', text: 'How are you' },
    ]);

    const result = await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'greeting',
    });

    expect(result.olderSummary).toBe('');
    expect(result.recentMessages).toHaveLength(3);
    expect(mockCallBts).not.toHaveBeenCalled();
  });

  it('splits and compresses when messages exceed window', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'compressed content' }],
      model: 'test',
    });

    const longText = 'x'.repeat(COMPRESSION_THRESHOLD_CHARS + 1);
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: longText },
      { turnId: 'turn-1', role: 'assistant', text: 'Response 1' },
      { turnId: 'turn-2', role: 'user', text: 'Question 2' },
      { turnId: 'turn-2', role: 'assistant', text: 'Response 2' },
      { turnId: 'turn-3', role: 'user', text: 'Question 3' },
      { turnId: 'turn-3', role: 'assistant', text: 'Response 3' },
      { turnId: 'turn-4', role: 'user', text: 'Question 4' },
      { turnId: 'turn-4', role: 'assistant', text: 'Response 4' },
    ]);

    const result = await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'research',
    });

    // Recent should be last 3 turns (turns 2-4 = 6 messages)
    expect(result.recentMessages).toHaveLength(6);

    // Older summary should contain compressed content
    expect(result.olderSummary).toBeTruthy();

    // BTS should have been called for the long message in older portion
    expect(mockCallBts).toHaveBeenCalled();
  });

  it('uses smaller window at depth 2', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'compressed' }],
      model: 'test',
    });

    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'Old 1' },
      { turnId: 'turn-2', role: 'user', text: 'Old 2' },
      { turnId: 'turn-3', role: 'user', text: 'Recent' },
    ]);

    const result = await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'test',
      depth: 2,
    });

    // DEPTH_2_WINDOW_TURNS = 1, so only last turn in recent
    expect(result.recentMessages).toHaveLength(1);
    expect(result.recentMessages[0].text).toBe('Recent');

    // olderSummary should have content from turns 1-2
    expect(result.olderSummary).toBeTruthy();
  });

  it('uses fully summarized context at depth 3', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'fully summarized context' }],
      model: 'test',
    });

    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'Old 1' },
      { turnId: 'turn-2', role: 'user', text: 'Old 2' },
      { turnId: 'turn-3', role: 'user', text: 'Latest' },
    ]);

    const result = await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'test',
      depth: 3,
    });

    expect(DEPTH_3_WINDOW_TURNS).toBe(0);
    expect(result.recentMessages).toHaveLength(0);
    expect(result.olderSummary).toBe('fully summarized context');
  });

  it('defaults to depth 1 when not specified', async () => {
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'Msg 1' },
      { turnId: 'turn-2', role: 'user', text: 'Msg 2' },
      { turnId: 'turn-3', role: 'user', text: 'Msg 3' },
    ]);

    const result = await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'test',
    });

    // SLIDING_WINDOW_TURNS = 3, 3 turns fit in window
    expect(result.olderSummary).toBe('');
    expect(result.recentMessages).toHaveLength(3);
  });

  it('formats older messages into summary with role labels', async () => {
    // No BTS call needed (messages are short)
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'User question' },
      { turnId: 'turn-1', role: 'assistant', text: 'Assistant answer' },
      { turnId: 'turn-2', role: 'user', text: 'Follow up' },
      { turnId: 'turn-2', role: 'assistant', text: 'Reply' },
      { turnId: 'turn-3', role: 'user', text: 'Third' },
      { turnId: 'turn-3', role: 'assistant', text: 'Third reply' },
      { turnId: 'turn-4', role: 'user', text: 'Latest' },
    ]);

    const result = await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'test',
    });

    // Older = turn-1 (2 messages), Recent = turns 2-4
    expect(result.olderSummary).toContain('[User]: User question');
    expect(result.olderSummary).toContain('[Assistant]: Assistant answer');
  });

  it('uses narrative summary path when compression ratio is below threshold', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'Narrative summary output' }],
      model: 'test',
    });

    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: 'Older short one' },
      { turnId: 'turn-2', role: 'assistant', text: 'Older short two' },
      { turnId: 'turn-3', role: 'user', text: 'Recent one' },
      { turnId: 'turn-4', role: 'assistant', text: 'Recent two' },
      { turnId: 'turn-5', role: 'user', text: 'Recent three' },
    ]);
    const older = messages.slice(0, 2);
    const compressibleCount = older.filter((m) => m.text.length > COMPRESSION_THRESHOLD_CHARS).length;
    expect(compressibleCount / older.length).toBeLessThan(NARRATIVE_COMPRESSION_RATIO);

    const result = await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'narrative path test',
    });

    expect(result.olderSummary).toBe('Narrative summary output');
    expect(mockCallBts).toHaveBeenCalledTimes(1);
    const narrativeRequest = mockCallBts.mock.calls[0][1];
    expect(narrativeRequest.messages[0].content).toContain('Summarize these older conversation messages');
  });

  it('uses per-message compression path when compression ratio is effective', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'BTS compressed older message' }],
      model: 'test',
    });

    const longOlder = 'L'.repeat(COMPRESSION_THRESHOLD_CHARS + 20);
    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: longOlder },
      { turnId: 'turn-2', role: 'assistant', text: 'Short older note' },
      { turnId: 'turn-3', role: 'user', text: 'Recent A' },
      { turnId: 'turn-4', role: 'assistant', text: 'Recent B' },
      { turnId: 'turn-5', role: 'user', text: 'Recent C' },
    ]);

    const result = await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'per-message path test',
    });

    expect(result.olderSummary).toContain('[User]: BTS compressed older message');
    expect(result.olderSummary).toContain('[Assistant]: Short older note');
    expect(mockCallBts).toHaveBeenCalledTimes(1);
    const compressionRequest = mockCallBts.mock.calls[0][1];
    expect(compressionRequest.messages[0].content).toContain('Compress the following message');
  });

  it('preprocesses compaction artifact messages before splitting and summary generation', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'Narrative summary after unwrapping' }],
      model: 'test',
    });

    const artifact = [
      '[COMPACTION_DEPTH:1]',
      '=== CONVERSATION CONTEXT ===',
      'Older context',
      '=== CONTINUE WITH REQUEST ===',
      'actual request payload'
    ].join('\n');

    const messages = makeMessages([
      { turnId: 'turn-1', role: 'user', text: artifact },
      { turnId: 'turn-2', role: 'assistant', text: 'Most recent turn' },
    ]);

    await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'artifact preprocessing',
      depth: 2,
    });

    expect(mockCallBts).toHaveBeenCalledTimes(1);
    const request = mockCallBts.mock.calls[0][1];
    expect(request.messages[0].content).toContain('actual request payload');
    expect(request.messages[0].content).not.toContain('[COMPACTION_DEPTH:1]');
  });

  it('produces smaller compacted output for many short messages plus a compaction artifact', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'Concise narrative summary' }],
      model: 'test',
    });

    const largeArtifact = [
      '[COMPACTION_DEPTH:1]',
      '<conversation_history>',
      'HISTORY BLOCK '.repeat(1200),
      '</conversation_history>',
      '=== CONTINUE WITH REQUEST ===',
      'actual request to continue'
    ].join('\n');

    const messages: AgentTurnMessage[] = [];
    for (let i = 1; i <= 22; i++) {
      messages.push(makeMessage({
        turnId: `turn-${i}`,
        role: i % 2 === 0 ? 'assistant' : 'user',
        text: i === 1 ? largeArtifact : `Short message ${i}`,
      }));
    }

    const inputSize = messages.reduce((sum, m) => sum + m.text.length, 0);

    const result = await generateIntelligentSummary(messages, {
      settings: mockSettings,
      taskContext: 'regression sizing check',
    });

    const outputSize = result.olderSummary.length
      + result.recentMessages.reduce((sum, m) => sum + m.text.length, 0);

    expect(outputSize).toBeLessThan(inputSize);
  });
});

describe('exported constants', () => {
  it('SLIDING_WINDOW_TURNS is 3', () => {
    expect(SLIDING_WINDOW_TURNS).toBe(3);
  });

  it('DEPTH_2_WINDOW_TURNS is 1', () => {
    expect(DEPTH_2_WINDOW_TURNS).toBe(1);
  });

  it('COMPRESSION_THRESHOLD_CHARS is 5000', () => {
    expect(COMPRESSION_THRESHOLD_CHARS).toBe(5000);
  });
});
