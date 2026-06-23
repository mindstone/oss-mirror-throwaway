import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '@shared/types';
import type { MeetingAnalysisDeps } from '../meetingAnalysisService';
import { initializeMeetingAnalysisService, triggerMeetingAnalysis } from '../meetingAnalysisService';

const runMeetingAnalysisFromTranscriptMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
  },
  readFile: vi.fn(),
}));

vi.mock('@core/utils/portablePath', () => ({
  relativePortablePath: vi.fn((_root: string, target: string) => target.replace('/workspace/', '')),
}));

vi.mock('@core/services/meeting/analysis', () => ({
  createMeetingAnalysisSessionId: vi.fn(() => 'meeting-analysis-test'),
  runMeetingAnalysisFromTranscript: (...args: unknown[]) => runMeetingAnalysisFromTranscriptMock(...args),
}));

vi.mock('../pendingTranscriptsStore', () => ({
  markAnalysisTriggered: vi.fn(),
  markAnalysisCompleted: vi.fn(),
}));

vi.mock('../transcriptStorage', () => ({
  findPrepForTranscript: vi.fn(async () => null),
}));

const makeSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  coreDirectory: '/workspace',
  activeProvider: 'codex',
  behindTheScenesModel: undefined,
  behindTheScenesOverrides: {},
  models: { model: 'gpt-5.5' },
  localModel: { profiles: [] },
  ...overrides,
} as AppSettings);

describe('meeting analysis auxiliary turn config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMeetingAnalysisFromTranscriptMock.mockImplementation(async (args) => {
      await args.execute({
        sessionId: args.sessionId,
        resetConversation: args.resetConversation,
        prompt: 'Analyze the transcript.',
        attachments: [{ type: 'text', text: 'Transcript' }],
        onEvent: args.onEvent,
      });
    });
  });

  it('declares a single-model turn from the active working model and suppresses planning', async () => {
    const runHeadlessTurn = vi.fn<MeetingAnalysisDeps['runHeadlessTurn']>(async () => undefined);

    initializeMeetingAnalysisService({
      runHeadlessTurn,
      getSettings: () => makeSettings(),
    });

    const result = await triggerMeetingAnalysis('bot-1', '/workspace/transcripts/today.md');
    const firstCall = runHeadlessTurn.mock.calls[0];

    expect(result).toEqual({ ran: true });
    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
    expect(firstCall?.[0].options).toMatchObject({
      sessionType: 'automation',
      persistMode: { kind: 'none' },
      sessionId: 'meeting-analysis-test',
      resetConversation: true,
      modelOverride: 'gpt-5.5',
      workingProfileOverrideId: '',
      thinkingModelOverride: '',
    });
  });

  it('declares a single-model active working profile turn and suppresses planning', async () => {
    const runHeadlessTurn = vi.fn<MeetingAnalysisDeps['runHeadlessTurn']>(async () => undefined);

    initializeMeetingAnalysisService({
      runHeadlessTurn,
      getSettings: () => makeSettings({
        models: { model: 'gpt-5.5', workingProfileId: 'codex-working' },
        localModel: {
          profiles: [
            { id: 'codex-working', name: 'Codex', providerType: 'codex', model: 'gpt-5.5' },
          ],
        },
      } as unknown as Partial<AppSettings>),
    });

    const result = await triggerMeetingAnalysis('bot-1', '/workspace/transcripts/today.md');
    const firstCall = runHeadlessTurn.mock.calls[0];

    expect(result).toEqual({ ran: true });
    expect(firstCall?.[0].options).toMatchObject({
      sessionType: 'automation',
      sessionId: 'meeting-analysis-test',
      modelOverride: undefined,
      workingProfileOverrideId: 'codex-working',
      thinkingModelOverride: '',
    });
  });
});
