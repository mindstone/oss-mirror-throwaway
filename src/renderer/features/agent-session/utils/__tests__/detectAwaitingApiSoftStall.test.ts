import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { detectAwaitingApiSoftStall } from '../detectAwaitingApiSoftStall';

const ts = (n: number) => n;
const statusStall = (sinceMs = 30_000): AgentEvent => ({
  type: 'status',
  message: 'Still on this one — it is taking longer than usual.',
  timestamp: ts(2),
  stall: { phase: 'awaiting_api', sinceMs },
});
const plainStatus = (): AgentEvent => ({ type: 'status', message: 'Working…', timestamp: ts(1) });

describe('detectAwaitingApiSoftStall (Stage 1b, 260617)', () => {
  it('returns null for an empty turn', () => {
    expect(detectAwaitingApiSoftStall([])).toBeNull();
  });

  it('returns the marker when the last status carries stall', () => {
    expect(detectAwaitingApiSoftStall([plainStatus(), statusStall(42_000)])).toEqual({
      phase: 'awaiting_api',
      sinceMs: 42_000,
    });
  });

  it('returns null when a later assistant (rolled-up) event has landed (turn produced output)', () => {
    const events: AgentEvent[] = [
      statusStall(),
      { type: 'assistant', text: 'Here is the answer', timestamp: ts(3) },
    ];
    expect(detectAwaitingApiSoftStall(events)).toBeNull();
  });

  // NOTE: `assistant_delta` is NOT broadcast to / stored by the renderer
  // (Stage-2 collapse — useAgentSessionEngine.ts drops it). The renderer's
  // first-token clear runs off the `answer_phase_started` marker via a store
  // flag, NOT off events (covered in MessageItem.softStall.test.tsx). The
  // detector still treats a stored `assistant_delta` as output (defensive),
  // but it never appears in a real renderer event history.
  it('defensively treats a stored assistant_delta as output (never appears in real renderer history)', () => {
    const events: AgentEvent[] = [
      statusStall(),
      { type: 'assistant_delta', text: 'H', timestamp: ts(3) },
    ];
    expect(detectAwaitingApiSoftStall(events)).toBeNull();
  });

  it('returns null when a later tool event has fired', () => {
    const events: AgentEvent[] = [
      statusStall(),
      { type: 'tool', toolName: 'read_file', detail: '', stage: 'start', timestamp: ts(3) } as AgentEvent,
    ];
    expect(detectAwaitingApiSoftStall(events)).toBeNull();
  });

  it('returns null when the turn has ended (result)', () => {
    const events: AgentEvent[] = [
      statusStall(),
      { type: 'result', text: 'done', timestamp: ts(3) } as AgentEvent,
    ];
    expect(detectAwaitingApiSoftStall(events)).toBeNull();
  });

  it('returns null when a later status WITHOUT stall supersedes it (activity-resume)', () => {
    expect(detectAwaitingApiSoftStall([statusStall(), plainStatus()])).toBeNull();
  });

  it('re-arms when the turn stalls again after producing output (latest stall wins)', () => {
    const events: AgentEvent[] = [
      statusStall(30_000),
      { type: 'assistant_delta', text: 'partial', timestamp: ts(3) },
      statusStall(31_000),
    ];
    expect(detectAwaitingApiSoftStall(events)).toEqual({ phase: 'awaiting_api', sinceMs: 31_000 });
  });

  it('ignores a plain status with no stall and no output', () => {
    expect(detectAwaitingApiSoftStall([plainStatus()])).toBeNull();
  });
});
