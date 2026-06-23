import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLogger,
  mockCallBehindTheScenesWithAuth,
  mockGetPrompt,
  mockHasValidAuth,
  mockResolveCodexConnectivity,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  mockCallBehindTheScenesWithAuth: vi.fn(),
  mockGetPrompt: vi.fn((..._args: unknown[]) => 'ACTIVITY SUMMARY SYSTEM PROMPT'),
  mockHasValidAuth: vi.fn((..._args: unknown[]) => true),
  mockResolveCodexConnectivity: vi.fn((..._args: unknown[]) => ({ connected: false })),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

vi.mock('../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenesWithAuth(...args),
}));

vi.mock('@core/services/promptFileService', () => ({
  getPrompt: (...args: unknown[]) => mockGetPrompt(...args),
  PROMPT_IDS: { UTILITY_ACTIVITY_SUMMARY: 'utility/activity-summary' },
}));

vi.mock('../../utils/authEnvUtils', () => ({
  hasValidAuth: (...args: unknown[]) => mockHasValidAuth(...args),
}));

vi.mock('@core/rebelCore/codexConnectivity', () => ({
  resolveCodexConnectivity: (...args: unknown[]) => mockResolveCodexConnectivity(...args),
}));

import {
  _resetActivitySummaryInFlightForTests,
  maybeGenerateActivitySummaryForTurn,
  sanitizeActivitySummary,
  shouldGenerateActivitySummary,
  type ActivitySummaryDeps,
  type ActivitySummaryInput,
} from '../activitySummaryService';

const textResponse = (text: string) => ({ content: [{ type: 'text', text }] });

const baseInput = (overrides: Partial<ActivitySummaryInput> = {}): ActivitySummaryInput => ({
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolMetrics: { totalToolCalls: 3, filesCreated: 0, filesEdited: 1 },
  durationMs: 30_000,
  activityLines: ['mcp__slack__search: query=Q3 numbers', 'Read: report.md'],
  turnRequest: 'Pull my Q3 numbers and draft the update.',
  answerSnippet: 'Here is the draft update with the Q3 figures.',
  ...overrides,
});

const makeDeps = (overrides: Partial<ActivitySummaryDeps> = {}): {
  deps: ActivitySummaryDeps;
  getPersistedSummary: ReturnType<typeof vi.fn>;
  persistSummary: ReturnType<typeof vi.fn>;
} => {
  const getPersistedSummary = vi.fn(async () => null as string | null);
  const persistSummary = vi.fn(async () => true);
  const deps: ActivitySummaryDeps = {
    getSettings: () => ({}) as never,
    getPersistedSummary,
    persistSummary,
    ...overrides,
  };
  return { deps, getPersistedSummary, persistSummary };
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetActivitySummaryInFlightForTests();
  mockHasValidAuth.mockReturnValue(true);
  mockGetPrompt.mockReturnValue('ACTIVITY SUMMARY SYSTEM PROMPT');
});

describe('shouldGenerateActivitySummary (gating)', () => {
  it('generates when totalToolCalls >= 2', () => {
    expect(
      shouldGenerateActivitySummary({ toolMetrics: { totalToolCalls: 2, filesCreated: 0, filesEdited: 0 } }),
    ).toBe(true);
  });

  it('generates when >= 1 file is touched even with a single tool call', () => {
    expect(
      shouldGenerateActivitySummary({ toolMetrics: { totalToolCalls: 1, filesCreated: 1, filesEdited: 0 } }),
    ).toBe(true);
  });

  it('does NOT generate for a long but tool-free / file-free turn (F2: duration-only arm dropped)', () => {
    // A duration-only turn has no renderable recap host and would only yield a
    // weak sentence grounded on "no tool activity recorded" — it gets the
    // deterministic "Took 18s" count-line instead, never a generated sentence.
    expect(shouldGenerateActivitySummary({ durationMs: 30_000 })).toBe(false);
    expect(
      shouldGenerateActivitySummary({
        toolMetrics: { totalToolCalls: 1, filesCreated: 0, filesEdited: 0 },
        durationMs: 30_000,
      }),
    ).toBe(false);
  });

  it('does NOT generate for a trivial turn (one tool, no files, short)', () => {
    expect(
      shouldGenerateActivitySummary({
        toolMetrics: { totalToolCalls: 1, filesCreated: 0, filesEdited: 0 },
        durationMs: 5_000,
      }),
    ).toBe(false);
  });

  it('does NOT generate with no signal at all', () => {
    expect(shouldGenerateActivitySummary({})).toBe(false);
  });
});

describe('sanitizeActivitySummary', () => {
  it('takes the first non-empty line and strips a label', () => {
    expect(sanitizeActivitySummary('Summary: Pulled the Q3 numbers from Slack and drafted the update.')).toBe(
      'Pulled the Q3 numbers from Slack and drafted the update.',
    );
  });

  it('strips surrounding quotes and code fences, returns one line', () => {
    const raw = '```\n"Reviewed the report and replied in Slack."\n\nextra trailing line\n```';
    expect(sanitizeActivitySummary(raw)).toBe('Reviewed the report and replied in Slack.');
  });

  it('collapses internal whitespace and trims a trailing dash', () => {
    expect(sanitizeActivitySummary('Searched   Slack   and   summarised —')).toBe('Searched Slack and summarised');
  });

  it('returns empty string for empty/whitespace input', () => {
    expect(sanitizeActivitySummary('')).toBe('');
    expect(sanitizeActivitySummary('   \n  ')).toBe('');
  });

  it('caps overly long output', () => {
    const long = `Did a thing ${'x'.repeat(400)}`;
    const result = sanitizeActivitySummary(long);
    expect(result.length).toBeLessThanOrEqual(201); // 200 chars + ellipsis
    expect(result.endsWith('…')).toBe(true);
  });

  it('enforces ONE sentence even when the model crams several onto one line', () => {
    expect(sanitizeActivitySummary('Read the file. Drafted the reply. Sent it.')).toBe('Read the file.');
  });

  it('keeps a single sentence with no trailing terminator intact', () => {
    expect(sanitizeActivitySummary('Reviewed the report and replied in Slack')).toBe(
      'Reviewed the report and replied in Slack',
    );
  });

  it('does not split on a decimal point inside a number', () => {
    // No whitespace after the dot, so it is not treated as a sentence boundary.
    expect(sanitizeActivitySummary('Pulled the 3.5% figure and drafted the note.')).toBe(
      'Pulled the 3.5% figure and drafted the note.',
    );
  });
});

describe('maybeGenerateActivitySummaryForTurn — gating', () => {
  it('returns null and makes NO BTS call below threshold', async () => {
    const { deps, persistSummary } = makeDeps();
    const result = await maybeGenerateActivitySummaryForTurn(
      baseInput({ toolMetrics: { totalToolCalls: 1, filesCreated: 0, filesEdited: 0 }, durationMs: 1_000 }),
      deps,
    );
    expect(result).toBeNull();
    expect(mockCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
    expect(persistSummary).not.toHaveBeenCalled();
  });

  it('generates and persists above threshold', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue(textResponse('Pulled your Q3 numbers and drafted the update.'));
    const { deps, persistSummary } = makeDeps();
    const result = await maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    expect(result).toBe('Pulled your Q3 numbers and drafted the update.');
    expect(mockCallBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);
    expect(persistSummary).toHaveBeenCalledWith('session-1', 'turn-1', 'Pulled your Q3 numbers and drafted the update.');
    // category is the registered cost category
    const trackingArg = mockCallBehindTheScenesWithAuth.mock.calls[0][2];
    expect(trackingArg).toMatchObject({ category: 'activity-summary', sessionId: 'session-1', turnId: 'turn-1' });
  });

  it('skips generation when auth is invalid', async () => {
    mockHasValidAuth.mockReturnValue(false);
    const { deps } = makeDeps();
    const result = await maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    expect(result).toBeNull();
    expect(mockCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
  });
});

describe('maybeGenerateActivitySummaryForTurn — idempotency (F1)', () => {
  it('skips the BTS call when a summary is already persisted (preflight)', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue(textResponse('A second sentence.'));
    const { deps, persistSummary } = makeDeps({
      getPersistedSummary: vi.fn(async () => 'Already summarised this turn.'),
    });
    const result = await maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    expect(result).toBeNull();
    expect(mockCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
    expect(persistSummary).not.toHaveBeenCalled();
  });

  it('collapses concurrent invocations for the same turn to a single BTS call (in-flight Set)', async () => {
    let resolveCall: (value: unknown) => void = () => {};
    mockCallBehindTheScenesWithAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve;
        }),
    );
    const { deps } = makeDeps();

    const first = maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    // Second invocation while the first is still in flight.
    const second = maybeGenerateActivitySummaryForTurn(baseInput(), deps);

    const secondResult = await second;
    expect(secondResult).toBeNull(); // collapsed by the in-flight guard

    resolveCall(textResponse('Drafted the update from your Q3 numbers.'));
    const firstResult = await first;
    expect(firstResult).toBe('Drafted the update from your Q3 numbers.');
    expect(mockCallBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);
  });

  it('does not write twice when the apply-time guard declines (persistSummary returns false)', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue(textResponse('Reviewed and replied.'));
    const persistSummary = vi.fn(async () => false);
    const { deps } = makeDeps({ persistSummary });
    const result = await maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    expect(result).toBeNull();
    expect(persistSummary).toHaveBeenCalledTimes(1);
  });
});

describe('maybeGenerateActivitySummaryForTurn — graceful failure', () => {
  it('returns null and does NOT persist when the BTS call throws', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(new Error('network down'));
    const { deps, persistSummary } = makeDeps();
    const result = await maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    expect(result).toBeNull();
    expect(persistSummary).not.toHaveBeenCalled();
  });

  it('returns null on timeout (AbortError after our own timeout fired)', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    // Simulate the BTS call rejecting due to our timeout abort.
    mockCallBehindTheScenesWithAuth.mockImplementation(async (_s: unknown, opts: { signal?: AbortSignal }) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (opts.signal) {
        // Force the abort path deterministically.
        throw abortErr;
      }
      return textResponse('unused');
    });
    const { deps, persistSummary } = makeDeps();
    const result = await maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    expect(result).toBeNull();
    expect(persistSummary).not.toHaveBeenCalled();
  });

  it('returns null (no persist) when the model returns text that sanitises to empty', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue(textResponse('```\n\n```'));
    const { deps, persistSummary } = makeDeps();
    const result = await maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    expect(result).toBeNull();
    expect(persistSummary).not.toHaveBeenCalled();
  });

  it('releases the in-flight slot after failure so a later retry can run', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValueOnce(new Error('transient'));
    const { deps } = makeDeps();
    const firstResult = await maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    expect(firstResult).toBeNull();

    mockCallBehindTheScenesWithAuth.mockResolvedValueOnce(textResponse('Recovered and drafted the update.'));
    const secondResult = await maybeGenerateActivitySummaryForTurn(baseInput(), deps);
    expect(secondResult).toBe('Recovered and drafted the update.');
    expect(mockCallBehindTheScenesWithAuth).toHaveBeenCalledTimes(2);
  });
});
