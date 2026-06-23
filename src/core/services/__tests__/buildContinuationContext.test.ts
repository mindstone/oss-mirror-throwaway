import { describe, expect, it, vi } from 'vitest';

import {
  buildContinuationContext,
  type BuildContinuationContextDeps,
  type ContinuationContextInput,
  type ContinuationContextLogger,
} from '../buildContinuationContext';
import type { TranscriptTurnSummary } from '../priorTurnsReader';
import type { AppSettings, AgentTurnMessage } from '@shared/types';

function makeLogger(): ContinuationContextLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeSummary(overrides: Partial<TranscriptTurnSummary> = {}): TranscriptTurnSummary {
  return {
    turnId: 't-prior',
    startTs: 1,
    endTs: 2,
    terminalSeq: 1,
    toolCallCount: { Read: 1 },
    toolUseIds: [],
    toolUseIdToToolName: {},
    filePathsRead: ['/repo/foo.ts'],
    externalSourcesHit: [],
    materializedOutputs: [],
    oneLineGist: 'Did some work',
    outcomeClass: 'completed',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<AgentTurnMessage> = {}): AgentTurnMessage {
  return {
    id: 'm1',
    turnId: 't-prior',
    role: 'assistant',
    text: 'Hello there',
    createdAt: Date.now(),
    ...overrides,
  } as AgentTurnMessage;
}

function makeDeps(overrides: Partial<BuildContinuationContextDeps> = {}): BuildContinuationContextDeps {
  return {
    readPriorTurns: vi.fn(async () => [] as TranscriptTurnSummary[]),
    buildPriorTurnsHeader: vi.fn(({ summaries, currentTurnId }) => {
      if (
        summaries.length === 0 ||
        summaries.every((s: TranscriptTurnSummary) => s.turnId === currentTurnId)
      ) {
        return { text: '', bytes: 0, truncated: false, turnCount: 0 };
      }
      const text = '<prior_turns>\nfake header\n</prior_turns>\n\n';
      return { text, bytes: text.length, truncated: false, turnCount: summaries.length };
    }),
    loadConversationHistory: vi.fn(async () => ''),
    getSettings: vi.fn(() => ({ enablePriorTurnsHeader: true } as AppSettings)),
    readEnvFlag: vi.fn(() => false),
    ...overrides,
  };
}

function makeInput(overrides: Partial<ContinuationContextInput> = {}): ContinuationContextInput {
  return {
    sessionId: 's1',
    currentTurnId: 't-current',
    scope: 'main',
    resetConversation: false,
    modeInput: { mode: 'proactive-main' },
    turnLogger: makeLogger(),
    ...overrides,
  };
}

describe('buildContinuationContext', () => {
  describe('gate: resetConversation', () => {
    it('returns empty prefix when resetConversation is true (proactive-main)', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        loadConversationHistory: vi.fn(async () => '<conversation_history>\nstuff\n</conversation_history>\n\n'),
      });
      const result = await buildContinuationContext(
        makeInput({ resetConversation: true }),
        deps,
      );
      expect(result.prefix).toBe('');
      expect(result.meta.headerIncluded).toBe(false);
      expect(result.meta.historyIncluded).toBe(false);
      expect(deps.readPriorTurns).not.toHaveBeenCalled();
      expect(deps.loadConversationHistory).not.toHaveBeenCalled();
    });

    it('returns empty prefix when resetConversation is true (continuation-accumulator)', async () => {
      const deps = makeDeps();
      const result = await buildContinuationContext(
        makeInput({
          resetConversation: true,
          modeInput: {
            mode: 'continuation-accumulator',
            accumulator: { messages: [makeMessage()] },
          },
        }),
        deps,
      );
      expect(result.prefix).toBe('');
      expect(result.meta.historyIncluded).toBe(false);
    });
  });

  describe('gate: recovery mode', () => {
    it('returns empty prefix when mode is recovery (header skipped per D5)', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        loadConversationHistory: vi.fn(async () => 'should-not-be-loaded'),
      });
      const result = await buildContinuationContext(
        makeInput({ modeInput: { mode: 'recovery', skipHeader: true } }),
        deps,
      );
      expect(result.prefix).toBe('');
      expect(result.meta).toEqual({
        headerIncluded: false,
        headerBytes: 0,
        historyIncluded: false,
        historyBytes: 0,
        truncated: false,
      });
      expect(deps.loadConversationHistory).not.toHaveBeenCalled();
      expect(deps.readPriorTurns).not.toHaveBeenCalled();
    });
  });

  describe('gate: settings + env flag', () => {
    it('omits header when settings.enablePriorTurnsHeader is false and env is unset', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        getSettings: vi.fn(() => ({ enablePriorTurnsHeader: false } as AppSettings)),
        readEnvFlag: vi.fn(() => false),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect(result.meta.headerIncluded).toBe(false);
      expect(deps.readPriorTurns).not.toHaveBeenCalled();
    });

    it('includes header when env override is set even if settings flag is false', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        getSettings: vi.fn(() => ({ enablePriorTurnsHeader: false } as AppSettings)),
        readEnvFlag: vi.fn(() => true),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect(result.meta.headerIncluded).toBe(true);
      expect(deps.readPriorTurns).toHaveBeenCalledOnce();
    });

    it('includes header when settings flag is true and env is unset', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        getSettings: vi.fn(() => ({ enablePriorTurnsHeader: true } as AppSettings)),
        readEnvFlag: vi.fn(() => false),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect(result.meta.headerIncluded).toBe(true);
    });
  });

  describe('gate: hasPriorTurns', () => {
    it('omits header when reader returns no summaries', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => []),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect(result.meta.headerIncluded).toBe(false);
    });

    it('omits header when readPriorTurns throws', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => {
          throw new Error('disk error');
        }),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect(result.meta.headerIncluded).toBe(false);
    });
  });

  describe('combined gates (AND)', () => {
    it('all gates open → header AND history both included (proactive-main)', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        loadConversationHistory: vi.fn(
          async () => '<conversation_history>\nfake history\n</conversation_history>\n\n',
        ),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect(result.meta.headerIncluded).toBe(true);
      expect(result.meta.historyIncluded).toBe(true);
      expect(result.prefix.indexOf('<prior_turns>')).toBeLessThan(
        result.prefix.indexOf('<conversation_history>'),
      );
      const priorMatches = result.prefix.match(/<prior_turns>/g) ?? [];
      const historyMatches = result.prefix.match(/<conversation_history>/g) ?? [];
      expect(priorMatches).toHaveLength(1);
      expect(historyMatches).toHaveLength(1);
    });

    it('settings flag off + env on + reader has summaries → header included', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        getSettings: vi.fn(() => ({ enablePriorTurnsHeader: false } as AppSettings)),
        readEnvFlag: vi.fn(() => true),
        loadConversationHistory: vi.fn(async () => ''),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect(result.meta.headerIncluded).toBe(true);
    });

    it('settings flag off + env off + reader has summaries → header omitted', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        getSettings: vi.fn(() => ({ enablePriorTurnsHeader: false } as AppSettings)),
        readEnvFlag: vi.fn(() => false),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect(result.meta.headerIncluded).toBe(false);
    });

    it('settings flag on + reader returns 0 summaries → header omitted', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => []),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect(result.meta.headerIncluded).toBe(false);
    });
  });

  describe('mode: proactive-main', () => {
    it('calls loadConversationHistory once', async () => {
      const deps = makeDeps({
        loadConversationHistory: vi.fn(async () => '<conversation_history>\nh\n</conversation_history>\n\n'),
      });
      await buildContinuationContext(makeInput(), deps);
      expect(deps.loadConversationHistory).toHaveBeenCalledOnce();
    });

    it('does not call buildPriorTurnsHeader if env+settings disabled', async () => {
      const deps = makeDeps({
        getSettings: vi.fn(() => ({ enablePriorTurnsHeader: false } as AppSettings)),
        readEnvFlag: vi.fn(() => false),
      });
      await buildContinuationContext(makeInput(), deps);
      expect(deps.buildPriorTurnsHeader).not.toHaveBeenCalled();
    });
  });

  describe('mode: continuation-accumulator', () => {
    it('renders accumulator messages as a single conversation_history block', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => []),
        loadConversationHistory: vi.fn(async () => 'should-not-be-loaded'),
      });
      const result = await buildContinuationContext(
        makeInput({
          modeInput: {
            mode: 'continuation-accumulator',
            accumulator: {
              messages: [
                makeMessage({ role: 'assistant', text: 'I researched this.' }),
                makeMessage({ role: 'result', text: 'Final answer' }),
              ],
            },
          },
        }),
        deps,
      );
      expect(deps.loadConversationHistory).not.toHaveBeenCalled();
      const historyMatches = result.prefix.match(/<conversation_history>/g) ?? [];
      expect(historyMatches).toHaveLength(1);
      expect(result.prefix).toContain('[assistant]: I researched this.');
      expect(result.prefix).toContain('[result]: Final answer');
    });

    it('returns empty history when accumulator has no eligible messages', async () => {
      const deps = makeDeps({ readPriorTurns: vi.fn(async () => []) });
      const result = await buildContinuationContext(
        makeInput({
          modeInput: {
            mode: 'continuation-accumulator',
            accumulator: {
              messages: [makeMessage({ role: 'user', text: 'still text' })],
            },
          },
        }),
        deps,
      );
      expect(result.meta.historyIncluded).toBe(false);
      expect(result.prefix).toBe('');
    });

    it('still injects the prior-turns header when gates allow it', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
      });
      const result = await buildContinuationContext(
        makeInput({
          modeInput: {
            mode: 'continuation-accumulator',
            accumulator: {
              messages: [makeMessage()],
            },
          },
        }),
        deps,
      );
      expect(result.meta.headerIncluded).toBe(true);
      expect(result.meta.historyIncluded).toBe(true);
      expect(result.prefix.indexOf('<prior_turns>')).toBeLessThan(
        result.prefix.indexOf('<conversation_history>'),
      );
    });
  });

  describe('single-injection invariant', () => {
    it('emits at most one <prior_turns> AND one <conversation_history> across all modes', async () => {
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        loadConversationHistory: vi.fn(
          async () => '<conversation_history>\nfake\n</conversation_history>\n\n',
        ),
      });
      const result = await buildContinuationContext(makeInput(), deps);
      expect((result.prefix.match(/<prior_turns>/g) ?? []).length).toBe(1);
      expect((result.prefix.match(/<\/prior_turns>/g) ?? []).length).toBe(1);
      expect((result.prefix.match(/<conversation_history>/g) ?? []).length).toBe(1);
      expect((result.prefix.match(/<\/conversation_history>/g) ?? []).length).toBe(1);
    });
  });

  describe('Bug 1 (Phase 7): currentTurnId optional for continuation-accumulator path', () => {
    it('continuation-accumulator without currentTurnId includes ALL prior turn summaries', async () => {
      const turn1 = makeSummary({ turnId: 't-prior-1', oneLineGist: 'Did turn-1 work' });
      const deps = makeDeps({ readPriorTurns: vi.fn(async () => [turn1]) });
      const result = await buildContinuationContext(
        makeInput({
          currentTurnId: undefined,
          modeInput: {
            mode: 'continuation-accumulator',
            accumulator: { messages: [makeMessage()] },
          },
        }),
        deps,
      );
      expect(result.meta.headerIncluded).toBe(true);
      expect(deps.buildPriorTurnsHeader).toHaveBeenCalledWith(
        expect.objectContaining({
          currentTurnId: undefined,
          summaries: [turn1],
        }),
      );
    });

    it('continuation-accumulator WITH currentTurnId === turn-1.id excludes turn 1 (legacy behaviour)', async () => {
      const turn1 = makeSummary({ turnId: 't-prior-1', oneLineGist: 'Did turn-1 work' });
      const deps = makeDeps({ readPriorTurns: vi.fn(async () => [turn1]) });
      const result = await buildContinuationContext(
        makeInput({
          currentTurnId: 't-prior-1',
          modeInput: {
            mode: 'continuation-accumulator',
            accumulator: { messages: [makeMessage()] },
          },
        }),
        deps,
      );
      expect(result.meta.headerIncluded).toBe(false);
      expect(deps.buildPriorTurnsHeader).toHaveBeenCalledWith(
        expect.objectContaining({ currentTurnId: 't-prior-1' }),
      );
    });

    it('bda78829 shape: turn-1 just finished, AskUserQuestion handler invokes with no currentTurnId → header includes turn 1', async () => {
      const turn1 = makeSummary({
        turnId: 't-batch-1',
        oneLineGist: 'Read 43 files and asked clarifying questions',
        toolCallCount: { Read: 43 },
        outcomeClass: 'asked-user-question',
      });
      const deps = makeDeps({ readPriorTurns: vi.fn(async () => [turn1]) });
      const result = await buildContinuationContext(
        makeInput({
          currentTurnId: undefined,
          modeInput: {
            mode: 'continuation-accumulator',
            accumulator: { messages: [makeMessage({ text: 'Started investigation.' })] },
          },
        }),
        deps,
      );
      expect(result.meta.headerIncluded).toBe(true);
      expect(result.meta.historyIncluded).toBe(true);
      expect(result.prefix).toContain('<prior_turns>');
      expect(result.prefix).toContain('<conversation_history>');
    });
  });

  describe('telemetry', () => {
    it('logs `priorTurnsHeader` info on the proactive path when included with unified shape', async () => {
      const logger = makeLogger();
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        loadConversationHistory: vi.fn(
          async () => '<conversation_history>\nfake\n</conversation_history>\n\n',
        ),
      });
      await buildContinuationContext(makeInput({ turnLogger: logger }), deps);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          priorTurnsHeader: expect.objectContaining({
            included: true,
            bytes: expect.any(Number),
            turnCount: 1,
            historyIncluded: true,
            historyBytes: expect.any(Number),
            truncated: false,
          }),
          source: 'proactive',
        }),
        expect.any(String),
      );
    });

    it('logs `priorTurnsHeader` with source=feature-disabled when settings + env both off', async () => {
      const logger = makeLogger();
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
        getSettings: vi.fn(() => ({ enablePriorTurnsHeader: false } as AppSettings)),
        readEnvFlag: vi.fn(() => false),
      });
      await buildContinuationContext(makeInput({ turnLogger: logger }), deps);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          priorTurnsHeader: expect.objectContaining({
            included: false,
            bytes: 0,
            turnCount: 0,
            historyIncluded: false,
            historyBytes: 0,
            truncated: false,
          }),
          source: 'feature-disabled',
        }),
        expect.any(String),
      );
    });

    it('logs `priorTurnsHeader` with source=no-prior-turns when feature on but reader empty', async () => {
      const logger = makeLogger();
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => []),
      });
      await buildContinuationContext(makeInput({ turnLogger: logger }), deps);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          priorTurnsHeader: expect.objectContaining({
            included: false,
          }),
          source: 'no-prior-turns',
        }),
        expect.any(String),
      );
    });

    it('logs `priorTurnsHeader` with source=reset when resetConversation is true', async () => {
      const logger = makeLogger();
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
      });
      await buildContinuationContext(
        makeInput({ turnLogger: logger, resetConversation: true }),
        deps,
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          priorTurnsHeader: expect.objectContaining({
            included: false,
            historyIncluded: false,
          }),
          source: 'reset',
        }),
        expect.any(String),
      );
    });

    it('logs `priorTurnsHeader` with source=recovery when modeInput is recovery', async () => {
      const logger = makeLogger();
      const deps = makeDeps({
        readPriorTurns: vi.fn(async () => [makeSummary()]),
      });
      await buildContinuationContext(
        makeInput({ turnLogger: logger, modeInput: { mode: 'recovery', skipHeader: true } }),
        deps,
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          priorTurnsHeader: expect.objectContaining({
            included: false,
          }),
          source: 'recovery',
        }),
        expect.any(String),
      );
    });
  });
});
