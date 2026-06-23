import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, type Mock } from 'vitest';
import path from 'node:path';
import { configurePromptFileService, _resetForTesting } from '@core/services/promptFileService';

// Use vi.hoisted to ensure the mock logger is available when vi.mock is hoisted
const { mockLoggerMethods } = vi.hoisted(() => ({
  mockLoggerMethods: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

// Mock logger - will use the hoisted mockLoggerMethods
vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => mockLoggerMethods),
}));

// Mock behindTheScenesClient
vi.mock('@core/services/behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(),
}));

// Mock authEnvUtils
vi.mock('@core/utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

// Import after mocks
import {
  formatTranscriptForSummary,
  parseSummaryResponse,
  generateConversationSummary,
} from '../conversationSummaryService';
import { callBehindTheScenesWithAuth } from '@core/services/behindTheScenesClient';
import { hasValidAuth } from '../../utils/authEnvUtils';
import type { AgentSession, AppSettings, AgentTurnMessage } from '@shared/types';

// Get the mocked versions
const mockedCallBehindTheScenesWithAuth = callBehindTheScenesWithAuth as Mock;
const mockedHasValidAuth = hasValidAuth as Mock;

// Helper to create a minimal session with messages
function createMockSession(
  messages: AgentTurnMessage[],
  options: {
    id?: string;
    compactionBoundaries?: AgentSession['compactionBoundaries'];
  } = {}
): AgentSession {
  return {
    id: options.id ?? 'test-session-1',
    title: 'Test Session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages,
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    compactionBoundaries: options.compactionBoundaries,
  };
}

// Helper to create a message
function createMessage(
  role: 'user' | 'assistant' | 'result',
  text: string,
  turnId = 'turn-1'
): AgentTurnMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    turnId,
    role,
    text,
    createdAt: Date.now(),
  };
}

// Helper to create mock settings
function createMockSettings(hasApiKey = true): AppSettings {
  return {
    claude: hasApiKey ? { apiKey: 'test-mock-key-for-unit-tests' } : undefined,
  } as AppSettings;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('conversationSummaryService', () => {
  beforeAll(() => {
    const promptsDir = path.resolve(__dirname, '../../../../rebel-system/prompts');
    configurePromptFileService(promptsDir);
  });

  afterAll(() => {
    _resetForTesting();
  });

  describe('parseSummaryResponse', () => {
    it('returns valid ConversationSummary for valid JSON', () => {
      const validJson = JSON.stringify({
        overview: 'This is a test conversation about project planning.',
        keyDecisions: ['Decision 1', 'Decision 2'],
        gotchasAndInsights: ['Watch out for X'],
        resourcesMentioned: ['file.ts', 'https://example.com'],
      });

      const result = parseSummaryResponse(validJson);

      expect(result).toEqual({
        overview: 'This is a test conversation about project planning.',
        keyDecisions: ['Decision 1', 'Decision 2'],
        gotchasAndInsights: ['Watch out for X'],
        resourcesMentioned: ['file.ts', 'https://example.com'],
      });
    });

    it('returns null for invalid JSON', () => {
      const invalidJson = 'not valid json {';

      const result = parseSummaryResponse(invalidJson);

      expect(result).toBeNull();
      expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Failed to parse summary JSON'
      );
    });

    it('returns null for valid JSON but malformed structure (missing required fields)', () => {
      const malformedJson = JSON.stringify({
        overview: 'This is a test.',
        // Missing keyDecisions, gotchasAndInsights, resourcesMentioned
      });

      const result = parseSummaryResponse(malformedJson);

      expect(result).toBeNull();
      expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
        expect.objectContaining({ errors: expect.any(Array) }),
        'Summary response validation failed'
      );
    });

    it('returns null for wrong types in structure', () => {
      const wrongTypesJson = JSON.stringify({
        overview: 123, // should be string
        keyDecisions: 'not an array', // should be array
        gotchasAndInsights: [],
        resourcesMentioned: [],
      });

      const result = parseSummaryResponse(wrongTypesJson);

      expect(result).toBeNull();
      expect(mockLoggerMethods.warn).toHaveBeenCalled();
    });

    it('accepts empty arrays for optional array fields', () => {
      const validEmptyArrays = JSON.stringify({
        overview: 'Simple conversation.',
        keyDecisions: [],
        gotchasAndInsights: [],
        resourcesMentioned: [],
      });

      const result = parseSummaryResponse(validEmptyArrays);

      expect(result).toEqual({
        overview: 'Simple conversation.',
        keyDecisions: [],
        gotchasAndInsights: [],
        resourcesMentioned: [],
      });
    });
  });

  describe('formatTranscriptForSummary', () => {
    it('formats messages correctly with turn numbers and labels', () => {
      const session = createMockSession([
        createMessage('user', 'Hello, I need help with a task.'),
        createMessage('assistant', 'Sure, I can help you with that!'),
        createMessage('user', 'Great, please proceed.'),
      ]);

      const transcript = formatTranscriptForSummary(session);

      expect(transcript).toContain('## Full Conversation');
      expect(transcript).toContain('[Turn 1] User:\nHello, I need help with a task.');
      expect(transcript).toContain('[Turn 2] Assistant:\nSure, I can help you with that!');
      expect(transcript).toContain('[Turn 3] User:\nGreat, please proceed.');
    });

    it('filters out result role messages', () => {
      const session = createMockSession([
        createMessage('user', 'Run a command'),
        createMessage('result', 'Command output: success'),
        createMessage('assistant', 'The command succeeded.'),
      ]);

      const transcript = formatTranscriptForSummary(session);

      expect(transcript).not.toContain('result');
      expect(transcript).not.toContain('Command output: success');
      expect(transcript).toContain('[Turn 1] User:');
      expect(transcript).toContain('[Turn 2] Assistant:');
    });

    it('includes compaction boundaries when present', () => {
      const session = createMockSession(
        [createMessage('user', 'Recent question'), createMessage('assistant', 'Recent answer')],
        {
          compactionBoundaries: [
            {
              afterMessageIndex: 5,
              summary: 'Earlier, we discussed project setup and configuration.',
              timestamp: Date.now(),
              depth: 1,
            },
          ],
        }
      );

      const transcript = formatTranscriptForSummary(session);

      expect(transcript).toContain('## Earlier Context (Previously Summarized)');
      expect(transcript).toContain('Earlier, we discussed project setup and configuration.');
      expect(transcript).toContain('---');
      expect(transcript).toContain('## Full Conversation');
    });

    it('handles multiple compaction boundaries', () => {
      const session = createMockSession([createMessage('user', 'Latest message')], {
        compactionBoundaries: [
          {
            afterMessageIndex: 2,
            summary: 'First compaction summary.',
            timestamp: Date.now() - 10000,
            depth: 1,
          },
          {
            afterMessageIndex: 5,
            summary: 'Second compaction summary.',
            timestamp: Date.now(),
            depth: 2,
          },
        ],
      });

      const transcript = formatTranscriptForSummary(session);

      expect(transcript).toContain('First compaction summary.');
      expect(transcript).toContain('Second compaction summary.');
    });

    it('uses tail-biased truncation at 350k chars and logs warning', () => {
      // Create a session with very long messages that exceeds 350k chars
      // Use distinct patterns at start, middle, and end to verify tail-biased truncation
      const startText = 'START_MARKER_' + 'A'.repeat(50_000);
      const middleText = 'MIDDLE_MARKER_' + 'B'.repeat(300_000);
      const endText = 'C'.repeat(50_000) + '_END_MARKER';
      const session = createMockSession([
        createMessage('user', startText),
        createMessage('assistant', middleText),
        createMessage('user', endText),
      ]);

      const transcript = formatTranscriptForSummary(session);

      // Should be truncated with head + tail approach
      expect(transcript.length).toBeLessThanOrEqual(360_000);
      expect(transcript).toContain('[...middle of conversation truncated...]');
      
      // Should keep start (first 100k chars) and end (last 250k chars)
      expect(transcript).toContain('START_MARKER_');
      expect(transcript).toContain('_END_MARKER');
      
      expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          originalLength: expect.any(Number),
        }),
        'Conversation exceeds 350k chars, using tail-biased truncation'
      );
    });

    it('does not truncate when under limit', () => {
      const session = createMockSession([
        createMessage('user', 'Short message'),
        createMessage('assistant', 'Short response'),
      ]);

      const transcript = formatTranscriptForSummary(session);

      expect(transcript).not.toContain('[...middle of conversation truncated...]');
      expect(mockLoggerMethods.warn).not.toHaveBeenCalled();
    });

    it('handles empty messages array', () => {
      const session = createMockSession([]);

      const transcript = formatTranscriptForSummary(session);

      expect(transcript).toContain('## Full Conversation');
      // Should not crash, just have the header
    });
  });

  describe('generateConversationSummary', () => {
    it('returns null when no valid auth available', async () => {
      // Mock hasValidAuth to return false for this test
      mockedHasValidAuth.mockReturnValueOnce(false);
      
      const settings = createMockSettings(false);
      const session = createMockSession([
        createMessage('user', 'Test message'),
        createMessage('assistant', 'Test response'),
      ]);

      const result = await generateConversationSummary(settings, session);

      expect(result).toBeNull();
      expect(mockedCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
      expect(mockLoggerMethods.debug).toHaveBeenCalledWith(
        'No valid auth available for summary generation, skipping'
      );
    });

    it('returns null for empty session (no messages)', async () => {
      const settings = createMockSettings(true);
      const session = createMockSession([]);

      const result = await generateConversationSummary(settings, session);

      expect(result).toBeNull();
      expect(mockedCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
      expect(mockLoggerMethods.debug).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id }),
        'Session has no messages, skipping summary generation'
      );
    });

    it('calls callBehindTheScenes with correct parameters for full conversation', async () => {
      const settings = createMockSettings(true);
      const session = createMockSession([
        createMessage('user', 'What is the capital of France?'),
        createMessage('assistant', 'The capital of France is Paris.'),
      ]);

      mockedCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              overview: 'User asked about French geography.',
              keyDecisions: [],
              gotchasAndInsights: [],
              resourcesMentioned: [],
            }),
          },
        ],
      });

      await generateConversationSummary(settings, session);

      expect(mockedCallBehindTheScenesWithAuth).toHaveBeenCalledWith(
        settings,
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.stringContaining('What is the capital of France?'),
            }),
          ]),
          system: expect.stringContaining('comprehensive summary'),
          maxTokens: 4096,
          timeout: 30_000,
          outputFormat: expect.objectContaining({
            type: 'json_schema',
          }),
        }),
        { category: 'metadata', outcomePolicy: 'turn_bearing' }
      );
    });

    it('returns parsed summary on successful API response', async () => {
      const settings = createMockSettings(true);
      const session = createMockSession([
        createMessage('user', 'Help me build an app'),
        createMessage('assistant', 'I will help you create a React app.'),
      ]);

      const expectedSummary = {
        overview: 'User wanted help building an app.',
        keyDecisions: ['Use React framework', 'Start with create-react-app'],
        gotchasAndInsights: ['Check Node.js version compatibility'],
        resourcesMentioned: ['https://reactjs.org', 'package.json'],
      };

      mockedCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(expectedSummary) }],
      });

      const result = await generateConversationSummary(settings, session);

      expect(result).toEqual(expectedSummary);
    });

    it('returns null on API timeout (AbortError)', async () => {
      const settings = createMockSettings(true);
      const session = createMockSession([createMessage('user', 'Test')]);

      const abortError = new Error('Timeout');
      abortError.name = 'AbortError';
      mockedCallBehindTheScenesWithAuth.mockRejectedValue(abortError);

      const result = await generateConversationSummary(settings, session);

      expect(result).toBeNull();
      expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id }),
        'Conversation summary generation timed out'
      );
    });

    it('returns null on API error', async () => {
      const settings = createMockSettings(true);
      const session = createMockSession([createMessage('user', 'Test')]);

      mockedCallBehindTheScenesWithAuth.mockRejectedValue(new Error('API rate limit exceeded'));

      const result = await generateConversationSummary(settings, session);

      expect(result).toBeNull();
      expect(mockLoggerMethods.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          sessionId: session.id,
        }),
        'Failed to generate conversation summary'
      );
    });

    it('returns null when API returns invalid JSON', async () => {
      const settings = createMockSettings(true);
      const session = createMockSession([createMessage('user', 'Test')]);

      mockedCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: 'not valid json' }],
      });

      const result = await generateConversationSummary(settings, session);

      expect(result).toBeNull();
    });

    it('returns null when API returns empty response', async () => {
      const settings = createMockSettings(true);
      const session = createMockSession([createMessage('user', 'Test')]);

      mockedCallBehindTheScenesWithAuth.mockResolvedValue({ content: [] });

      const result = await generateConversationSummary(settings, session);

      expect(result).toBeNull();
      expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
        expect.objectContaining({ response: expect.any(Object) }),
        'Haiku returned empty or invalid summary response'
      );
    });

    it('includes full conversation in transcript (not truncated unless over limit)', async () => {
      const settings = createMockSettings(true);
      // Create a conversation with multiple messages that's under the 350k limit
      const messages = Array.from({ length: 20 }, (_, i) =>
        createMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i + 1}: `.padEnd(1000, 'x'))
      );
      const session = createMockSession(messages);

      mockedCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              overview: 'Test',
              keyDecisions: [],
              gotchasAndInsights: [],
              resourcesMentioned: [],
            }),
          },
        ],
      });

      await generateConversationSummary(settings, session);

      // Verify the transcript sent to API contains all messages
      const callArgs = mockedCallBehindTheScenesWithAuth.mock.calls[0];
      const sentContent = callArgs[1].messages[0].content;

      // Should contain all 20 turns (10 user, 10 assistant after filtering)
      expect(sentContent).toContain('[Turn 1]');
      expect(sentContent).toContain('[Turn 20]');
      expect(sentContent).not.toContain('[...truncated]');
    });
  });
});
