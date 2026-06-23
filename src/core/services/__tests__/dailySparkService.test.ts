import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';

const callMock = vi.fn();

vi.mock('@core/services/behindTheScenesClient', () => {
  class CodexDisconnectedBtsError extends Error {
    constructor() {
      super('Codex disconnected');
      this.name = 'CodexDisconnectedBtsError';
    }
  }
  return {
    callWithModelAuthAware: (...args: unknown[]) => callMock(...args),
    CodexDisconnectedBtsError,
  };
});

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: () => ({ isConnected: () => true }),
}));

vi.mock('@core/services/heroChoiceContextAssembler', () => ({
  assembleHeroChoiceContext: vi.fn(async () => 'mock-context'),
}));

vi.mock('@core/services/promptFileService', () => ({
  getPrompt: vi.fn(() => 'system-prompt'),
  PROMPT_IDS: { INTELLIGENCE_DAILY_SPARK: 'intelligence/daily-spark' },
}));

import {
  applyGentleToneSubstitutions,
  generateDailySparkBatch,
  validateDailySparkBatch,
  type DailySparkServiceDeps,
} from '../dailySparkService';

const baseDeps: DailySparkServiceDeps = {
  listSessionSummaries: () => [],
  loadSession: async () => null,
  getPersonalGoals: async () => null,
  getSkillSummaries: async () => [],
  getUseCases: () => [],
  getUpcomingEvents: () => [],
  getPastCandidates: () => [],
  timeZone: 'UTC',
  getFormatFeedback: () => ({}),
};

function makeSettings(): AppSettings {
  return { dailySparkMode: 'on' } as AppSettings;
}

function makeValidSparkPayload(weekStartIso = '2026-05-11'): unknown {
  const days = ['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-16', '2026-05-17'];
  // 7 sparks, no consecutive repeats, no caps exceeded.
  const formats = [
    'haiku',
    'dry_one_liner',
    'personal_proverb',
    'sommelier_note',
    'mock_weather_report',
    'faux_news_headline',
    'telegram_style',
  ];
  return {
    toneGauge: 'normal',
    weekStartIso,
    sparks: days.map((dayIso, i) => ({
      dayIso,
      format: formats[i],
      layout: 'single',
      body: `body line ${i}`,
    })),
  };
}

function mockResponse(payload: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    model: 'claude-haiku-4-5',
  };
}

describe('validateDailySparkBatch', () => {
  it('returns ok with empty sparks when toneGauge is silent', () => {
    const result = validateDailySparkBatch([], 'silent', '2026-05-11');
    expect(result.ok).toBe(true);
    expect(result.sparks).toEqual([]);
  });

  it('flags wrong_count when silent has nonzero sparks', () => {
    const result = validateDailySparkBatch(
      [{ dayIso: '2026-05-11', format: 'haiku', layout: 'poem', body: 'x' }],
      'silent',
      '2026-05-11',
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toContain('wrong_count');
  });

  it('flags wrong_count when not exactly 7 sparks for non-silent tone', () => {
    const result = validateDailySparkBatch(
      [{ dayIso: '2026-05-11', format: 'haiku', layout: 'poem', body: 'x' }],
      'normal',
      '2026-05-11',
    );
    expect(result.violations).toContain('wrong_count');
  });

  it('flags consecutive_format violations', () => {
    const sparks = ['haiku', 'haiku', 'dry_one_liner', 'sommelier_note', 'personal_proverb', 'mock_weather_report', 'faux_news_headline'].map(
      (f, i) => ({ dayIso: `2026-05-${11 + i}`, format: f, layout: 'single', body: `b${i}` }),
    );
    const result = validateDailySparkBatch(sparks, 'normal', '2026-05-11');
    expect(result.violations).toContain('consecutive_format');
  });

  it('flags limerick cap violations (>1 per week)', () => {
    const sparks = [
      { dayIso: '2026-05-11', format: 'limerick', layout: 'poem', body: 'a' },
      { dayIso: '2026-05-12', format: 'haiku', layout: 'poem', body: 'b' },
      { dayIso: '2026-05-13', format: 'limerick', layout: 'poem', body: 'c' },
      { dayIso: '2026-05-14', format: 'sommelier_note', layout: 'single', body: 'd' },
      { dayIso: '2026-05-15', format: 'dry_one_liner', layout: 'single', body: 'e' },
      { dayIso: '2026-05-16', format: 'faux_news_headline', layout: 'single', body: 'f' },
      { dayIso: '2026-05-17', format: 'personal_proverb', layout: 'single', body: 'g' },
    ];
    const result = validateDailySparkBatch(sparks, 'normal', '2026-05-11');
    expect(result.violations).toContain('format_cap_exceeded');
  });

  it('flags faux_shakespearean_aside cap violations (>1 per week)', () => {
    const sparks = [
      { dayIso: '2026-05-11', format: 'faux_shakespearean_aside', layout: 'poem', body: 'a' },
      { dayIso: '2026-05-12', format: 'haiku', layout: 'poem', body: 'b' },
      { dayIso: '2026-05-13', format: 'faux_shakespearean_aside', layout: 'poem', body: 'c' },
      { dayIso: '2026-05-14', format: 'sommelier_note', layout: 'single', body: 'd' },
      { dayIso: '2026-05-15', format: 'dry_one_liner', layout: 'single', body: 'e' },
      { dayIso: '2026-05-16', format: 'faux_news_headline', layout: 'single', body: 'f' },
      { dayIso: '2026-05-17', format: 'personal_proverb', layout: 'single', body: 'g' },
    ];
    const result = validateDailySparkBatch(sparks, 'normal', '2026-05-11');
    expect(result.violations).toContain('format_cap_exceeded');
  });

  it('flags generic per-format cap violations (>2 per week)', () => {
    const sparks = [
      { dayIso: '2026-05-11', format: 'haiku', layout: 'poem', body: 'a' },
      { dayIso: '2026-05-12', format: 'dry_one_liner', layout: 'single', body: 'b' },
      { dayIso: '2026-05-13', format: 'haiku', layout: 'poem', body: 'c' },
      { dayIso: '2026-05-14', format: 'sommelier_note', layout: 'single', body: 'd' },
      { dayIso: '2026-05-15', format: 'haiku', layout: 'poem', body: 'e' },
      { dayIso: '2026-05-16', format: 'faux_news_headline', layout: 'single', body: 'f' },
      { dayIso: '2026-05-17', format: 'personal_proverb', layout: 'single', body: 'g' },
    ];
    const result = validateDailySparkBatch(sparks, 'normal', '2026-05-11');
    expect(result.violations).toContain('format_cap_exceeded');
  });

  it('substitutes banned formats on gentle tone and flags the violation', () => {
    const sparks = [
      { dayIso: '2026-05-11', format: 'limerick', layout: 'poem', body: 'a' },
      { dayIso: '2026-05-12', format: 'haiku', layout: 'poem', body: 'b' },
      { dayIso: '2026-05-13', format: 'one_sentence_noir', layout: 'single', body: 'c' },
      { dayIso: '2026-05-14', format: 'sommelier_note', layout: 'single', body: 'd' },
      { dayIso: '2026-05-15', format: 'dry_one_liner', layout: 'single', body: 'e' },
      { dayIso: '2026-05-16', format: 'faux_news_headline', layout: 'single', body: 'f' },
      { dayIso: '2026-05-17', format: 'personal_proverb', layout: 'single', body: 'g' },
    ];
    const result = validateDailySparkBatch(sparks, 'gentle', '2026-05-11');
    expect(result.violations).toContain('gentle_banned_format');
    // After substitution the limerick becomes personal_proverb and the noir becomes sommelier_note.
    expect(result.sparks[0].format).toBe('personal_proverb');
    expect(result.sparks[2].format).toBe('sommelier_note');
  });

  it('returns ok=true for a valid 7-spark non-silent batch', () => {
    const sparks = [
      { dayIso: '2026-05-11', format: 'haiku', layout: 'poem', body: 'a' },
      { dayIso: '2026-05-12', format: 'dry_one_liner', layout: 'single', body: 'b' },
      { dayIso: '2026-05-13', format: 'sommelier_note', layout: 'single', body: 'c' },
      { dayIso: '2026-05-14', format: 'mock_weather_report', layout: 'poem', body: 'd' },
      { dayIso: '2026-05-15', format: 'faux_news_headline', layout: 'single', body: 'e' },
      { dayIso: '2026-05-16', format: 'personal_proverb', layout: 'single', body: 'f' },
      { dayIso: '2026-05-17', format: 'telegram_style', layout: 'poem', body: 'g' },
    ];
    const result = validateDailySparkBatch(sparks, 'normal', '2026-05-11');
    expect(result.ok).toBe(true);
    expect(result.sparks).toHaveLength(7);
  });
});

describe('applyGentleToneSubstitutions', () => {
  it('replaces banned formats and leaves others intact', () => {
    const out = applyGentleToneSubstitutions([
      { dayIso: '2026-05-11', format: 'limerick', layout: 'poem', body: 'a' },
      { dayIso: '2026-05-12', format: 'haiku', layout: 'poem', body: 'b' },
      { dayIso: '2026-05-13', format: 'faux_shakespearean_aside', layout: 'poem', body: 'c' },
      { dayIso: '2026-05-14', format: 'one_sentence_noir', layout: 'single', body: 'd' },
    ]);
    expect(out.map((s) => s.format)).toEqual([
      'personal_proverb',
      'haiku',
      'haiku',
      'sommelier_note',
    ]);
  });
});

describe('generateDailySparkBatch', () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it('returns a validated batch on the happy path', async () => {
    callMock.mockResolvedValueOnce(mockResponse(makeValidSparkPayload()));
    const batch = await generateDailySparkBatch(baseDeps, makeSettings(), {
      weekStartIso: '2026-05-11',
      isFirstAppearance: false,
    });
    expect(batch).not.toBeNull();
    expect(batch?.weekStartIso).toBe('2026-05-11');
    expect(batch?.toneGauge).toBe('normal');
    expect(batch?.sparks).toHaveLength(7);
    expect(batch?.sourceModel).toBe('claude-haiku-4-5');
    expect(batch?.promptVersion).toBe('v1.2');
    expect(callMock).toHaveBeenCalledTimes(1);
  });

  it('retries once on validation failure and returns the corrected batch', async () => {
    const bad = {
      toneGauge: 'normal',
      sparks: [
        // Consecutive same format → fails the validator.
        { dayIso: '2026-05-11', format: 'haiku', layout: 'poem', body: 'a' },
        { dayIso: '2026-05-12', format: 'haiku', layout: 'poem', body: 'b' },
        { dayIso: '2026-05-13', format: 'sommelier_note', layout: 'single', body: 'c' },
        { dayIso: '2026-05-14', format: 'mock_weather_report', layout: 'poem', body: 'd' },
        { dayIso: '2026-05-15', format: 'faux_news_headline', layout: 'single', body: 'e' },
        { dayIso: '2026-05-16', format: 'personal_proverb', layout: 'single', body: 'f' },
        { dayIso: '2026-05-17', format: 'telegram_style', layout: 'poem', body: 'g' },
      ],
    };
    callMock.mockResolvedValueOnce(mockResponse(bad));
    callMock.mockResolvedValueOnce(mockResponse(makeValidSparkPayload()));

    const batch = await generateDailySparkBatch(baseDeps, makeSettings(), {
      weekStartIso: '2026-05-11',
      isFirstAppearance: false,
    });

    expect(batch).not.toBeNull();
    expect(callMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when validation fails twice in a row', async () => {
    const bad = {
      toneGauge: 'normal',
      sparks: [
        { dayIso: '2026-05-11', format: 'haiku', layout: 'poem', body: 'a' },
        { dayIso: '2026-05-12', format: 'haiku', layout: 'poem', body: 'b' },
        { dayIso: '2026-05-13', format: 'sommelier_note', layout: 'single', body: 'c' },
        { dayIso: '2026-05-14', format: 'mock_weather_report', layout: 'poem', body: 'd' },
        { dayIso: '2026-05-15', format: 'faux_news_headline', layout: 'single', body: 'e' },
        { dayIso: '2026-05-16', format: 'personal_proverb', layout: 'single', body: 'f' },
        { dayIso: '2026-05-17', format: 'telegram_style', layout: 'poem', body: 'g' },
      ],
    };
    callMock.mockResolvedValue(mockResponse(bad));

    const batch = await generateDailySparkBatch(baseDeps, makeSettings(), {
      weekStartIso: '2026-05-11',
      isFirstAppearance: false,
    });

    expect(batch).toBeNull();
    expect(callMock).toHaveBeenCalledTimes(2);
  });

  it('propagates CodexDisconnectedBtsError', async () => {
    const { CodexDisconnectedBtsError } = await import('@core/services/behindTheScenesClient');
    callMock.mockRejectedValueOnce(new CodexDisconnectedBtsError());

    await expect(
      generateDailySparkBatch(baseDeps, makeSettings(), {
        weekStartIso: '2026-05-11',
        isFirstAppearance: false,
      }),
    ).rejects.toBeInstanceOf(CodexDisconnectedBtsError);
  });

  it('returns null when the LLM returns no parseable text', async () => {
    callMock.mockResolvedValueOnce({ content: [{ type: 'text', text: 'not-json-and-no-braces' }], model: 'claude-haiku-4-5' });
    const batch = await generateDailySparkBatch(baseDeps, makeSettings(), {
      weekStartIso: '2026-05-11',
      isFirstAppearance: false,
    });
    expect(batch).toBeNull();
  });

  it('returns null when the context assembler yields empty context', async () => {
    const assembler = await import('@core/services/heroChoiceContextAssembler');
    const original = (assembler.assembleHeroChoiceContext as unknown as {
      mockResolvedValueOnce: (v: string) => void;
    });
    original.mockResolvedValueOnce('');
    const batch = await generateDailySparkBatch(baseDeps, makeSettings(), {
      weekStartIso: '2026-05-11',
      isFirstAppearance: false,
    });
    expect(batch).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });
});
