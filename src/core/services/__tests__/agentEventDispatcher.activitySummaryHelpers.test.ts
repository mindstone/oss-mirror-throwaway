import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import {
  deriveActivityLinesForTurn,
  deriveAnswerSnippetForTurn,
  deriveTurnDurationMs,
  extractUserRequestText,
} from '../agentEventDispatcher';

/**
 * Focused coverage for the activity-summary grounding helpers used by the
 * dispatcher's fire-and-forget hook (Stage 2). The hook itself is exercised
 * end-to-end via the service tests + manual verification; these unit tests pin
 * the pure derivations that build the grounded, no-fabrication input.
 */

const toolEvent = (
  toolName: string,
  stage: 'start' | 'end',
  detail = '',
  origin?: 'real' | 'synthetic-plan-seed' | 'pre-turn-context',
): AgentEvent =>
  ({
    type: 'tool',
    toolName,
    stage,
    detail,
    timestamp: 0,
    ...(origin ? { _origin: origin } : {}),
  }) as AgentEvent;

describe('deriveActivityLinesForTurn', () => {
  it('includes only real tool START events with name + detail', () => {
    const lines = deriveActivityLinesForTurn([
      toolEvent('mcp__slack__search', 'start', 'query=Q3 numbers'),
      toolEvent('mcp__slack__search', 'end', 'query=Q3 numbers'), // end stage ignored
      toolEvent('Read', 'start', 'report.md'),
    ]);
    expect(lines).toEqual(['mcp__slack__search: query=Q3 numbers', 'Read: report.md']);
  });

  it('excludes synthetic-plan-seed and pre-turn-context tool events (no-fabrication grounding)', () => {
    const lines = deriveActivityLinesForTurn([
      toolEvent('MissionSet', 'start', 'seeded', 'synthetic-plan-seed'),
      toolEvent('search_files', 'start', 'context', 'pre-turn-context'),
      toolEvent('Write', 'start', 'draft.md', 'real'),
    ]);
    expect(lines).toEqual(['Write: draft.md']);
  });

  it('deduplicates identical lines and collapses whitespace', () => {
    const lines = deriveActivityLinesForTurn([
      toolEvent('Bash', 'start', 'ls   -la'),
      toolEvent('Bash', 'start', 'ls -la'),
    ]);
    expect(lines).toEqual(['Bash: ls -la']);
  });

  it('emits the bare tool name when there is no detail', () => {
    expect(deriveActivityLinesForTurn([toolEvent('TodoWrite', 'start', '')])).toEqual(['TodoWrite']);
  });
});

describe('deriveAnswerSnippetForTurn', () => {
  const msg = (turnId: string, role: AgentTurnMessage['role'], text: string): AgentTurnMessage => ({
    id: `${turnId}-${role}-${text.slice(0, 4)}`,
    turnId,
    role,
    text,
    createdAt: 0,
  });

  it('returns the last result/assistant message for the turn', () => {
    const snippet = deriveAnswerSnippetForTurn(
      [
        msg('turn-1', 'user', 'do the thing'),
        msg('turn-1', 'assistant', 'thinking out loud'),
        msg('turn-1', 'result', 'Here is the final answer.'),
        msg('turn-2', 'result', 'A different turn.'),
      ],
      'turn-1',
    );
    expect(snippet).toBe('Here is the final answer.');
  });

  it('returns undefined when the turn has no answer text', () => {
    expect(deriveAnswerSnippetForTurn([{ id: 'x', turnId: 'turn-1', role: 'user', text: 'q', createdAt: 0 }], 'turn-1')).toBeUndefined();
    expect(deriveAnswerSnippetForTurn([], 'turn-1')).toBeUndefined();
  });
});

describe('extractUserRequestText', () => {
  it('unwraps a <user-request> XML wrapper', () => {
    expect(extractUserRequestText('<context/>\n<user-request>\n  Pull my Q3 numbers.\n</user-request>')).toBe(
      'Pull my Q3 numbers.',
    );
  });

  it('returns the raw prompt when there is no wrapper', () => {
    expect(extractUserRequestText('Just a plain prompt')).toBe('Just a plain prompt');
  });

  it('returns undefined for empty / undefined input', () => {
    expect(extractUserRequestText(undefined)).toBeUndefined();
    expect(extractUserRequestText('   ')).toBeUndefined();
  });
});

describe('deriveTurnDurationMs', () => {
  const evAt = (timestamp: number): AgentEvent => ({ type: 'status', message: 's', timestamp }) as AgentEvent;

  it('measures earliest accumulated event timestamp to the result timestamp', () => {
    expect(deriveTurnDurationMs([evAt(1_000), evAt(5_000), evAt(3_000)], 26_000)).toBe(25_000);
  });

  it('returns undefined when no earlier timestamp is available', () => {
    expect(deriveTurnDurationMs([], 10_000)).toBeUndefined();
  });

  it('returns undefined for non-positive durations (clock skew / same instant)', () => {
    expect(deriveTurnDurationMs([evAt(10_000)], 10_000)).toBeUndefined();
    expect(deriveTurnDurationMs([evAt(20_000)], 10_000)).toBeUndefined();
  });
});
