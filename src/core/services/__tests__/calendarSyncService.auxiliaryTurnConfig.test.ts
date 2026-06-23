import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '@shared/types';
import type { CalendarSyncDeps } from '../calendarSyncService';
import { initializeCalendarSyncService, syncCalendarCache } from '../calendarSyncService';

vi.mock('@core/services/promptFileService', () => ({
  PROMPT_IDS: { INTELLIGENCE_CALENDAR_SYNC: 'intelligence-calendar-sync' },
  getPrompt: vi.fn(() => 'Sync the calendar cache.'),
}));

vi.mock('../meetingCacheStore', () => ({
  recordSyncError: vi.fn(),
}));

const makeSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
  coreDirectory: '/tmp/rebel-core',
  behindTheScenesModel: 'gpt-5.4-mini',
  behindTheScenesOverrides: {},
  activeProvider: 'codex',
  models: { model: 'gpt-5.5' },
  localModel: { profiles: [] },
  ...overrides,
} as AppSettings);

describe('calendar sync auxiliary turn config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('declares a single-model turn from the active working model and suppresses planning', async () => {
    const runHeadlessTurn = vi.fn<CalendarSyncDeps['runHeadlessTurn']>(async () => undefined);

    initializeCalendarSyncService({
      runHeadlessTurn,
      getSettings: () => makeSettings(),
    });

    const result = await syncCalendarCache();
    const firstCall = runHeadlessTurn.mock.calls[0];

    expect(result.success).toBe(true);
    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0].options).toMatchObject({
      sessionType: 'automation',
      sessionId: 'automation-calendar-sync',
      modelOverride: 'gpt-5.5',
      workingProfileOverrideId: '',
      thinkingModelOverride: '',
    });
  });

  it('declares a single-model active working profile turn and still suppresses planning', async () => {
    const runHeadlessTurn = vi.fn<CalendarSyncDeps['runHeadlessTurn']>(async () => undefined);

    initializeCalendarSyncService({
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

    const result = await syncCalendarCache();
    const firstCall = runHeadlessTurn.mock.calls[0];

    expect(result.success).toBe(true);
    expect(firstCall).toBeDefined();
    expect(firstCall?.[0].options).toMatchObject({
      sessionType: 'automation',
      sessionId: 'automation-calendar-sync',
      modelOverride: undefined,
      workingProfileOverrideId: 'codex-working',
      thinkingModelOverride: '',
    });
  });
});
