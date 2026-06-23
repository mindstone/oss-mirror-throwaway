/**
 * S2-CI round-trip guard for `AgentSession`.
 *
 * Behavioural complement to the compile-time `_SessionCheck` assertion in
 * `zodTypeAlignment.test.ts`. Loads a fully-populated `ManualAgentSession`
 * fixture, JSON-stringifies it, parses through `AgentSessionSchema`, and asserts
 * deep-equality against the original. Catches the drift class that was masked
 * by the loose `IsExact` until S2-CH strengthened the type-parity gate
 * (specifically `setupContext.pendingAnnouncement` was being silently stripped
 * on every persistence/cloud round-trip).
 *
 * See `docs/plans/260429_r2_stage2_chunked_implementation_plan.md` § S2-CI.
 */
import { describe, it, expect } from 'vitest';
import type { AgentSession as ManualAgentSession } from '@shared/types/agent';
import { AgentSessionSchema } from '../agent';

describe('AgentSession round-trip parity', () => {
  it('preserves setupContext.pendingAnnouncement through JSON round-trip', () => {
    const session: ManualAgentSession = {
      id: 'test-session-1',
      title: 'Round-trip test',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_010_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      setupContext: {
        kind: 'bundled-app-bridge',
        pairSessionId: 'pair-1',
        pendingAnnouncement: {
          status: 'connected',
          emittedAt: 1_700_000_005_000,
        },
      },
    };

    const roundTripped = AgentSessionSchema.parse(JSON.parse(JSON.stringify(session)));
    expect(roundTripped).toEqual(session);
    // Explicit canary on the previously-dropped field
    expect(roundTripped.setupContext?.pendingAnnouncement).toEqual({
      status: 'connected',
      emittedAt: 1_700_000_005_000,
    });
  });

  it('round-trips a fully-populated session with every optional surface set', () => {
    const session: ManualAgentSession = {
      id: 'test-session-2',
      title: 'Fully populated',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_010_000,
      cloudUpdatedAt: 1_700_000_020_000,
      messages: [],
      eventsByTurn: {},
      maxSeq: 42,
      activeTurnId: 'turn-active-1',
      isBusy: true,
      lastError: 'Synthetic error for fixture',
      resolvedAt: 1_700_000_030_000,
      doneAt: 1_700_000_040_000,
      starredAt: 1_700_000_050_000,
      deletedAt: null,
      autoTitleGeneratedAt: 1_700_000_060_000,
      autoTitleTurnCount: 3,
      isCorrupted: false,
      origin: 'manual',
      memoryUpdateStatusByTurn: {
        'turn-1': {
          originalTurnId: 'turn-1',
          status: 'success',
          summary: 'Memory update succeeded',
          timestamp: 1_700_000_070_000,
        },
      },
      timeSavedStatusByTurn: {
        'turn-1': {
          turnId: 'turn-1',
          status: 'success',
          actualDurationSeconds: 30,
          timestamp: 1_700_000_080_000,
        },
      },
      automationId: 'automation-1',
      automationRunId: 'run-1',
      compactionBoundaries: [],
      privateMode: false,
      sessionWorkingModel: 'claude-opus-4-7',
      sessionThinkingModel: 'claude-opus-4-7',
      sessionWorkingProfileId: 'profile-1',
      sessionThinkingProfileId: 'profile-2',
      sessionThinkingEffort: 'medium',
      interruptedTurnId: null,
      draft: { text: 'unsent draft text', updatedAt: 1_700_000_090_000 },
      setupContext: {
        kind: 'bundled-app-bridge',
        pairSessionId: 'pair-2',
        pendingAnnouncement: {
          status: 'expired',
          emittedAt: 1_700_000_100_000,
        },
      },
      toolDetailArchive: {
        'tool-use-1': {
          toolName: 'Read',
          input: 'path: /foo/bar',
          output: 'file contents',
          outputChars: 14,
        },
      },
      meetingCompanion: {
        meetingUrl: 'https://example.com/meet',
        botId: 'bot-1',
        meetingTitle: 'Strategy session',
        startedAt: 1_700_000_110_000,
        prepPath: '/path/to/prep.md',
        coach: {
          skillPath: '/skills/coach',
          skillName: 'Sales coach',
          showAllChecks: true,
        },
        lastInjectedCoachPath: '/skills/coach',
      },
    };

    const roundTripped = AgentSessionSchema.parse(JSON.parse(JSON.stringify(session)));
    expect(roundTripped).toEqual(session);
  });

  it('parses a minimally-populated session (no optional surfaces)', () => {
    const session: ManualAgentSession = {
      id: 'minimal',
      title: 'Minimal',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
    };

    const roundTripped = AgentSessionSchema.parse(JSON.parse(JSON.stringify(session)));
    expect(roundTripped).toEqual(session);
  });

  describe('conversation annotations', () => {
    const minimalSession = (): ManualAgentSession => ({
      id: 'annotations-schema',
      title: 'Annotation schema',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
    });

    it('safeParse succeeds when annotations are absent', () => {
      const result = AgentSessionSchema.safeParse(minimalSession());

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('annotations');
      }
    });

    it('safeParse succeeds when annotations are valid', () => {
      const session: ManualAgentSession = {
        ...minimalSession(),
        annotations: [{
          id: 'ann-1',
          messageId: 'msg-1',
          text: 'selected text',
          comment: 'private comment',
          createdAt: 1_700_000_010_000,
          startOffset: 0,
          endOffset: 13,
        }],
      };

      const result = AgentSessionSchema.safeParse(session);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.annotations).toEqual(session.annotations);
      }
    });

    it('safeParse rejects malformed annotation entries', () => {
      const result = AgentSessionSchema.safeParse({
        ...minimalSession(),
        annotations: [{
          id: 'ann-1',
          messageId: 'msg-1',
          text: 'selected text',
          createdAt: 1_700_000_010_000,
          startOffset: 0,
          endOffset: 13,
        }],
      });

      expect(result.success).toBe(false);
    });
  });
});
