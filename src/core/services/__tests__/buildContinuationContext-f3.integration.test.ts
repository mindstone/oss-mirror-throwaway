/**
 * F3 anti-double-injection integration test.
 *
 * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`:
 * verifies that when an upstream accumulator (e.g. `userQuestionResponseHandler`)
 * has already injected `<prior_turns>` + `<conversation_history>` into the
 * continuation prompt, the resulting prefix has at most ONE of each block.
 *
 * Specifically:
 *   - `continuation-accumulator` mode emits exactly ONE `<conversation_history>`
 *     and (when gates are open) exactly ONE `<prior_turns>`.
 *   - `proactive-main` mode emits the same structure independently.
 *   - The two modes never run on the same prompt (executor branches on
 *     `turnOptions.continuationContext.alreadyInjected`).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildContinuationContext,
  type BuildContinuationContextDeps,
} from '../buildContinuationContext';
import type { TranscriptTurnSummary } from '../priorTurnsReader';
import type { AgentTurnMessage, AppSettings } from '@shared/types';

function deps(over: Partial<BuildContinuationContextDeps> = {}): BuildContinuationContextDeps {
  return {
    readPriorTurns: vi.fn(async () => [
      {
        turnId: 't-prior-1',
        startTs: 1,
        endTs: 2,
        terminalSeq: 1,
        toolCallCount: { Read: 1 },
        toolUseIds: [],
        toolUseIdToToolName: {},
        filePathsRead: ['/repo/foo.ts'],
        externalSourcesHit: [],
        materializedOutputs: [],
        oneLineGist: 'Read foo.ts',
        outcomeClass: 'completed',
      },
    ] as TranscriptTurnSummary[]),
    buildPriorTurnsHeader: vi.fn(({ summaries, currentTurnId }) => {
      if (
        summaries.length === 0 ||
        summaries.every((s: TranscriptTurnSummary) => s.turnId === currentTurnId)
      ) {
        return { text: '', bytes: 0, truncated: false, turnCount: 0 };
      }
      const text = '<prior_turns>\nT1: Read foo.ts\n</prior_turns>\n\n';
      return { text, bytes: text.length, truncated: false, turnCount: 1 };
    }),
    loadConversationHistory: vi.fn(
      async () => '<conversation_history>\nfrom-disk\n</conversation_history>\n\n',
    ),
    getSettings: vi.fn(() => ({ enablePriorTurnsHeader: true } as AppSettings)),
    readEnvFlag: vi.fn(() => false),
    ...over,
  };
}

const baseLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

describe('Stage 2 F3 — single-injection invariant across both injection paths', () => {
  it('continuation-accumulator path emits one prior_turns + one conversation_history', async () => {
    const messages: AgentTurnMessage[] = [
      { id: 'm1', turnId: 't-prior-1', role: 'assistant', text: 'Did the work', createdAt: 1 } as AgentTurnMessage,
      { id: 'm2', turnId: 't-prior-1', role: 'result', text: 'Final answer', createdAt: 2 } as AgentTurnMessage,
    ];
    const result = await buildContinuationContext(
      {
        sessionId: 's1',
        currentTurnId: 't-now',
        scope: 'main',
        resetConversation: false,
        modeInput: { mode: 'continuation-accumulator', accumulator: { messages } },
        turnLogger: baseLogger,
      },
      deps(),
    );

    expect((result.prefix.match(/<prior_turns>/g) ?? []).length).toBe(1);
    expect((result.prefix.match(/<\/prior_turns>/g) ?? []).length).toBe(1);
    expect((result.prefix.match(/<conversation_history>/g) ?? []).length).toBe(1);
    expect((result.prefix.match(/<\/conversation_history>/g) ?? []).length).toBe(1);
    expect(result.meta.headerIncluded).toBe(true);
    expect(result.meta.historyIncluded).toBe(true);
  });

  it('proactive-main path emits one prior_turns + one conversation_history', async () => {
    const result = await buildContinuationContext(
      {
        sessionId: 's1',
        currentTurnId: 't-now',
        scope: 'main',
        resetConversation: false,
        modeInput: { mode: 'proactive-main' },
        turnLogger: baseLogger,
      },
      deps(),
    );
    expect((result.prefix.match(/<prior_turns>/g) ?? []).length).toBe(1);
    expect((result.prefix.match(/<\/prior_turns>/g) ?? []).length).toBe(1);
    expect((result.prefix.match(/<conversation_history>/g) ?? []).length).toBe(1);
    expect((result.prefix.match(/<\/conversation_history>/g) ?? []).length).toBe(1);
  });

  it('F3 absent-flag (no continuationContext on turn options) → proactive path runs', async () => {
    const proactive = await buildContinuationContext(
      {
        sessionId: 's1',
        currentTurnId: 't-now',
        scope: 'main',
        resetConversation: false,
        modeInput: { mode: 'proactive-main' },
        turnLogger: baseLogger,
      },
      deps(),
    );
    expect(proactive.prefix.length).toBeGreaterThan(0);
    expect(proactive.meta.headerIncluded).toBe(true);
    expect(proactive.meta.historyIncluded).toBe(true);
  });

  it('header always precedes history within the prefix (ordering invariant)', async () => {
    const result = await buildContinuationContext(
      {
        sessionId: 's1',
        currentTurnId: 't-now',
        scope: 'main',
        resetConversation: false,
        modeInput: { mode: 'proactive-main' },
        turnLogger: baseLogger,
      },
      deps(),
    );
    const headerIdx = result.prefix.indexOf('<prior_turns>');
    const historyIdx = result.prefix.indexOf('<conversation_history>');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(historyIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeLessThan(historyIdx);
  });

  it('history-once invariant — accumulator messages render exactly once', async () => {
    const messages: AgentTurnMessage[] = [
      { id: 'm1', turnId: 't-prior-1', role: 'assistant', text: 'unique-marker-A', createdAt: 1 } as AgentTurnMessage,
      { id: 'm2', turnId: 't-prior-1', role: 'result', text: 'unique-marker-B', createdAt: 2 } as AgentTurnMessage,
    ];
    const result = await buildContinuationContext(
      {
        sessionId: 's1',
        currentTurnId: 't-now',
        scope: 'main',
        resetConversation: false,
        modeInput: { mode: 'continuation-accumulator', accumulator: { messages } },
        turnLogger: baseLogger,
      },
      deps(),
    );
    expect((result.prefix.match(/unique-marker-A/g) ?? []).length).toBe(1);
    expect((result.prefix.match(/unique-marker-B/g) ?? []).length).toBe(1);
  });

  describe('reset × F3 matrix — reset always wins, passthrough opts out of proactive', () => {
    it('proactive + reset=true → empty prefix and source=reset telemetry', async () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
      const result = await buildContinuationContext(
        {
          sessionId: 's1',
          currentTurnId: 't-now',
          scope: 'main',
          resetConversation: true,
          modeInput: { mode: 'proactive-main' },
          turnLogger: logger,
        },
        deps(),
      );
      expect(result.prefix).toBe('');
      expect(result.meta.headerIncluded).toBe(false);
      expect(result.meta.historyIncluded).toBe(false);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'reset' }),
        expect.any(String),
      );
    });

    it('proactive + reset=false + flag absent → header AND history injected', async () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
      const result = await buildContinuationContext(
        {
          sessionId: 's1',
          currentTurnId: 't-now',
          scope: 'main',
          resetConversation: false,
          modeInput: { mode: 'proactive-main' },
          turnLogger: logger,
        },
        deps(),
      );
      expect(result.meta.headerIncluded).toBe(true);
      expect(result.meta.historyIncluded).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'proactive' }),
        expect.any(String),
      );
    });

    it('continuation-accumulator + reset=true → empty prefix and source=reset telemetry (producer reset)', async () => {
      const messages: AgentTurnMessage[] = [
        { id: 'm1', turnId: 't-prior-1', role: 'assistant', text: 'work', createdAt: 1 } as AgentTurnMessage,
      ];
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
      const result = await buildContinuationContext(
        {
          sessionId: 's1',
          currentTurnId: 't-now',
          scope: 'main',
          resetConversation: true,
          modeInput: { mode: 'continuation-accumulator', accumulator: { messages } },
          turnLogger: logger,
        },
        deps(),
      );
      expect(result.prefix).toBe('');
      expect(result.meta.historyIncluded).toBe(false);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'reset' }),
        expect.any(String),
      );
    });

    it('continuation-accumulator + reset=false + flag present (proactive call suppressed by executor) → producer prefix kept verbatim, no double-injection', async () => {
      const messages: AgentTurnMessage[] = [
        { id: 'm1', turnId: 't-prior-1', role: 'assistant', text: 'work', createdAt: 1 } as AgentTurnMessage,
      ];
      const result = await buildContinuationContext(
        {
          sessionId: 's1',
          currentTurnId: 't-now',
          scope: 'main',
          resetConversation: false,
          modeInput: { mode: 'continuation-accumulator', accumulator: { messages } },
          turnLogger: baseLogger,
        },
        deps(),
      );
      expect((result.prefix.match(/<prior_turns>/g) ?? []).length).toBe(1);
      expect((result.prefix.match(/<conversation_history>/g) ?? []).length).toBe(1);
    });
  });

  describe('Bug 2 (Phase 7): empty-prefix detection — no false alreadyInjected when nothing was injected', () => {
    it('feature OFF + no eligible accumulator messages → prefix is empty (handler must omit alreadyInjected)', async () => {
      const result = await buildContinuationContext(
        {
          sessionId: 's1',
          currentTurnId: undefined,
          scope: 'main',
          resetConversation: false,
          modeInput: {
            mode: 'continuation-accumulator',
            accumulator: { messages: [] },
          },
          turnLogger: baseLogger,
        },
        deps({
          getSettings: vi.fn(() => ({ enablePriorTurnsHeader: false } as AppSettings)),
          readEnvFlag: vi.fn(() => false),
        }),
      );
      expect(result.prefix).toBe('');
      expect(result.meta.headerIncluded).toBe(false);
      expect(result.meta.historyIncluded).toBe(false);
    });

    it('feature ON + prior turns + accumulator messages → prefix non-empty (handler sets alreadyInjected: true)', async () => {
      const messages: AgentTurnMessage[] = [
        { id: 'm1', turnId: 't-prior-1', role: 'assistant', text: 'work', createdAt: 1 } as AgentTurnMessage,
      ];
      const result = await buildContinuationContext(
        {
          sessionId: 's1',
          currentTurnId: undefined,
          scope: 'main',
          resetConversation: false,
          modeInput: { mode: 'continuation-accumulator', accumulator: { messages } },
          turnLogger: baseLogger,
        },
        deps({
          getSettings: vi.fn(() => ({ enablePriorTurnsHeader: true } as AppSettings)),
        }),
      );
      expect(result.prefix.length).toBeGreaterThan(0);
      expect(result.meta.headerIncluded).toBe(true);
      expect(result.meta.historyIncluded).toBe(true);
    });

    it('feature OFF + accumulator has eligible messages → history is still injected (legacy behaviour preserved)', async () => {
      const messages: AgentTurnMessage[] = [
        { id: 'm1', turnId: 't-prior-1', role: 'assistant', text: 'partial work', createdAt: 1 } as AgentTurnMessage,
      ];
      const result = await buildContinuationContext(
        {
          sessionId: 's1',
          currentTurnId: undefined,
          scope: 'main',
          resetConversation: false,
          modeInput: { mode: 'continuation-accumulator', accumulator: { messages } },
          turnLogger: baseLogger,
        },
        deps({
          getSettings: vi.fn(() => ({ enablePriorTurnsHeader: false } as AppSettings)),
          readEnvFlag: vi.fn(() => false),
        }),
      );
      expect(result.meta.headerIncluded).toBe(false);
      expect(result.meta.historyIncluded).toBe(true);
      expect(result.prefix).toContain('<conversation_history>');
      expect(result.prefix).not.toContain('<prior_turns>');
    });
  });
});
