import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type BotQAModule = typeof import('../botQAService');

interface FixtureTranscriptSegment {
  speaker?: string;
  text: string;
  timestamp: number;
  isFinal?: boolean;
}

interface FixtureEvent {
  kind: 'question' | 'stop' | 'discard' | 'high-signal';
  extracted?: string;
  type?: string;
  timestamp?: number;
}

interface Fixture {
  name: string;
  category: string;
  description: string;
  config: {
    triggerPhrase: string | null;
    ownerFirstName: string;
  };
  transcript: FixtureTranscriptSegment[];
  expectedEvents: FixtureEvent[];
}

const FIXTURES_DIR = path.resolve(__dirname, '../../../../../evals/fixtures/meeting-trigger-detection-corpus');

let capturedEvents: FixtureEvent[] = [];
let currentFixtureTime = 0;

async function loadBotQAModule(): Promise<BotQAModule> {
  vi.doMock('@core/logger', () => {
    const actualLogger = {
      debug: vi.fn(),
      info: vi.fn((meta, msg) => {
        if (msg === 'Discard trigger detected') {
          capturedEvents.push({ kind: 'discard', timestamp: currentFixtureTime });
        } else if (msg === 'Stop trigger detected') {
          capturedEvents.push({ kind: 'stop', timestamp: currentFixtureTime });
        }
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };
    return { createScopedLogger: () => actualLogger };
  });

  vi.doMock('@core/services/settingsStore', () => ({
    setSettingsStoreAdapter: vi.fn(),
    getSettings: vi.fn(() => ({ meetingBot: {} })),
  }));

  vi.doMock('../botVoiceService', () => ({
    speakInMeeting: vi.fn(async () => true),
    setAvatarState: vi.fn((botId: string, state: string) => {}),
    stopSpeaking: vi.fn(() => {
      capturedEvents.push({ kind: 'stop', timestamp: currentFixtureTime });
    }),
  }));

  vi.doMock('../../authService', () => ({
    getAuthState: vi.fn(() => ({ user: { id: 'user-1' } })),
  }));

  vi.doMock('../../behindTheScenesClient', () => ({
    callBehindTheScenesWithAuth: vi.fn(async (settings, params) => {
      const prompt = params.messages[0].content;
      if (prompt.includes('Is this a complete question')) {
        const textMatch = prompt.match(/Text: "(.*)"/);
        const text = textMatch ? textMatch[1] : '';
        const words = text.trim().split(/\s+/).filter((w: string) => w.length > 0);
        if (words.length < 3) {
          return { content: [{ text: 'incomplete' }] };
        }
        return { content: [{ text: 'complete' }] };
      }
      return { content: [{ text: 'mock answer' }] };
    }),
  }));

  vi.doMock('../transcriptStorage', () => ({
    saveLiveTranscript: vi.fn(async () => ({ success: true, filePath: '/tmp/live-transcript.md' })),
    appendToLiveTranscript: vi.fn(async () => ({ success: true, newSegmentsWritten: 1 })),
  }));

  vi.doMock('../pendingTranscriptsStore', () => ({
    updateLiveTranscriptPath: vi.fn(),
    getPendingTranscript: vi.fn(() => ({})),
  }));

  vi.doMock('../meetingBotService', () => ({
    getActiveBotState: vi.fn(() => null),
  }));

  vi.doMock('../conversationStateService', () => ({
    formatMeetingContext: vi.fn(() => ''),
  }));

  return import('../botQAService');
}

describe('botQAService Characterisation (Stage 2a)', () => {
  let botQA: BotQAModule;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    botQA = await loadBotQAModule();
    capturedEvents = [];
    currentFixtureTime = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const files = fs.existsSync(FIXTURES_DIR) ? fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json')) : [];
  
  if (files.length === 0) {
    it('dummy test to prevent vitest failure when no fixtures exist', () => {
      expect(true).toBe(true);
    });
  }

  for (const file of files) {
    it(`satisfies fixture: ${file}`, async () => {
      const fixturePath = path.join(FIXTURES_DIR, file);
      const fixture: Fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

      botQA.initializeBotQAService({
        runHeadlessTurn: vi.fn(async (params) => {
          const match = params.prompt.match(/\*\*QUESTION:\*\*\s*(.*)/);
          const extracted = match ? match[1].trim() : '';
          capturedEvents.push({ kind: 'question', extracted, timestamp: currentFixtureTime });
        }),
        getConversationState: vi.fn(() => null),
        onHighSignalUtterance: vi.fn((botId, type, text) => {
          capturedEvents.push({ kind: 'high-signal', type, extracted: text, timestamp: currentFixtureTime });
        })
      });

      botQA.startBotQA('bot-1', fixture.config.ownerFirstName, fixture.config.triggerPhrase, false);
      botQA.setKnowledgeAccess('bot-1', true);

      for (const segment of fixture.transcript) {
        currentFixtureTime = segment.timestamp;
        botQA.processTranscriptSegment(
          'bot-1', 
          segment.speaker || 'Unknown', 
          segment.text, 
          segment.isFinal !== false
        );

        await vi.runOnlyPendingTimersAsync();
        await Promise.resolve();
      }

      await vi.advanceTimersByTimeAsync(25000);

      if (process.env.CAPTURE === '1') {
        fixture.expectedEvents = capturedEvents;
        fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');
      } else {
        expect(capturedEvents).toEqual(fixture.expectedEvents);
      }
    });
  }
});
