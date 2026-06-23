import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MEETING_TRIGGER_DETECTED_CHANNEL, type MeetingTriggerDetectedPayload } from '@shared/ipc/channels/meetingTrigger';
import {
  initializeBotQAService,
  processTranscriptSegment,
  setKnowledgeAccess,
  startBotQA,
  startLocalTranscriptBuffer,
  stopBotQA,
} from '../botQAService';

interface FixtureTranscriptSegment {
  speaker?: string;
  text: string;
  timestamp: number;
  isFinal?: boolean;
}

interface FixtureEvent {
  kind: 'question' | 'stop' | 'discard' | 'high-signal';
  extracted?: string;
}

interface Fixture {
  config: {
    triggerPhrase: string | null;
    ownerFirstName: string;
  };
  transcript: FixtureTranscriptSegment[];
  expectedEvents: FixtureEvent[];
}

const FIXTURES_DIR = path.resolve(
  __dirname,
  '../../../../../evals/fixtures/meeting-trigger-detection-corpus',
);

const mocks = vi.hoisted(() => ({
  sendToAllWindows: vi.fn(),
  speakInMeeting: vi.fn(async () => true),
  runHeadlessTurn: vi.fn(async () => undefined),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mocks.sendToAllWindows,
    sendToFocusedWindow: vi.fn(),
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({ meetingBot: {} })),
}));

vi.mock('../botVoiceService', () => ({
  speakInMeeting: mocks.speakInMeeting,
  setAvatarState: vi.fn(),
  stopSpeaking: vi.fn(),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      getCachedAuthConfig: vi.fn(() => null),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      refreshLicenseTier: vi.fn(async () => 'free'),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      getAuthState: vi.fn(() => ({ user: { id: 'user-1' } })),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('../../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(async (_settings: unknown, params: { messages: Array<{ content: string }> }) => {
    const prompt = params.messages[0]?.content ?? '';
    if (prompt.includes('Is this a complete question')) {
      return { content: [{ text: 'complete' }] };
    }
    return { content: [{ text: 'Mock response from transcript.' }] };
  }),
}));

vi.mock('../transcriptStorage', () => ({
  saveLiveTranscript: vi.fn(async () => ({ success: true, filePath: '/tmp/live-transcript.md' })),
  appendToLiveTranscript: vi.fn(async () => ({ success: true, newSegmentsWritten: 1 })),
}));

vi.mock('../pendingTranscriptsStore', () => ({
  updateLiveTranscriptPath: vi.fn(),
  getPendingTranscript: vi.fn(() => null),
}));

vi.mock('../meetingBotService', () => ({
  getActiveBotState: vi.fn(() => null),
}));

vi.mock('../conversationStateService', () => ({
  formatMeetingContext: vi.fn(() => ''),
}));

describe('processTranscriptSegment output modes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_715_204_800_000);
    mocks.sendToAllWindows.mockClear();
    mocks.speakInMeeting.mockClear();
    mocks.runHeadlessTurn.mockClear();

    initializeBotQAService({
      runHeadlessTurn: mocks.runHeadlessTurn,
      getConversationState: vi.fn(() => null),
    });
  });

  afterEach(() => {
    stopBotQA('bot-with-tts');
    stopBotQA('local-companion');
    stopBotQA('local-silent');
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps bot-with-tts mode behavior and does not emit meeting:trigger-detected', async () => {
    startBotQA('bot-with-tts', 'Jordan', 'Spark', true);
    setKnowledgeAccess('bot-with-tts', false);

    processTranscriptSegment('bot-with-tts', 'Jordan', 'hey spark what are the next steps');
    await vi.advanceTimersByTimeAsync(2_500);

    expect(
      mocks.sendToAllWindows.mock.calls.some(([channel]) => channel === MEETING_TRIGGER_DETECTED_CHANNEL),
    ).toBe(false);
  });

  it('emits meeting:trigger-detected in companion-only-question-listening mode', async () => {
    startLocalTranscriptBuffer('local-companion', 'Jordan', {
      outputMode: 'companion-only-question-listening',
      triggerPhrase: 'Spark',
      triggerSessionId: 'local-session-1',
    });

    processTranscriptSegment('local-companion', 'Jordan', 'hey spark what are the next steps');
    await vi.advanceTimersByTimeAsync(2_500);

    const triggerCalls = mocks.sendToAllWindows.mock.calls.filter(
      ([channel]) => channel === MEETING_TRIGGER_DETECTED_CHANNEL,
    );
    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0]?.[1]).toMatchObject({
      sessionId: 'local-session-1',
      extracted: 'what are the next steps',
      triggerSourceSpeaker: 'user',
    } satisfies Partial<MeetingTriggerDetectedPayload>);
    expect(mocks.speakInMeeting).not.toHaveBeenCalled();
    expect(mocks.runHeadlessTurn).not.toHaveBeenCalled();
  });

  it('stays silent in silent mode', async () => {
    startLocalTranscriptBuffer('local-silent', 'Jordan', {
      outputMode: 'silent',
      triggerPhrase: 'Spark',
      triggerSessionId: 'local-session-2',
    });

    processTranscriptSegment('local-silent', 'Jordan', 'hey spark what are the next steps');
    await vi.advanceTimersByTimeAsync(2_500);

    const triggerCalls = mocks.sendToAllWindows.mock.calls.filter(
      ([channel]) => channel === MEETING_TRIGGER_DETECTED_CHANNEL,
    );
    expect(triggerCalls).toHaveLength(0);
    expect(mocks.speakInMeeting).not.toHaveBeenCalled();
    expect(mocks.runHeadlessTurn).not.toHaveBeenCalled();
  });

  it('runs Stage 2a corpus through companion mode and emits trigger events for every expected question', async () => {
    const files = fs.readdirSync(FIXTURES_DIR).filter((file) => file.endsWith('.json')).sort();

    for (const file of files) {
      mocks.sendToAllWindows.mockClear();
      const fixturePath = path.join(FIXTURES_DIR, file);
      const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Fixture;
      const botId = `local-${file}`;
      const triggerSessionId = `session-${file}`;

      startLocalTranscriptBuffer(botId, fixture.config.ownerFirstName, {
        outputMode: 'companion-only-question-listening',
        triggerPhrase: fixture.config.triggerPhrase,
        triggerSessionId,
      });

      for (const segment of fixture.transcript) {
        vi.setSystemTime(segment.timestamp);
        processTranscriptSegment(
          botId,
          segment.speaker ?? 'Unknown',
          segment.text,
          segment.isFinal !== false,
        );
        await vi.runOnlyPendingTimersAsync();
        await Promise.resolve();
      }

      await vi.advanceTimersByTimeAsync(25_000);

      const emittedQuestions = mocks.sendToAllWindows.mock.calls
        .filter(([channel]) => channel === MEETING_TRIGGER_DETECTED_CHANNEL)
        .map(([, payload]) => (payload as MeetingTriggerDetectedPayload).extracted);

      const expectedQuestions = fixture.expectedEvents
        .filter((event) => event.kind === 'question')
        .map((event) => event.extracted ?? '');

      expect(emittedQuestions).toEqual(expectedQuestions);
      stopBotQA(botId);
    }
  });
});
