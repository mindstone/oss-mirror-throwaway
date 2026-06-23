/**
 * Tests for mergeSessionTurns and hasLocalOnlyTurns — the core session merge
 * logic that reconciles local desktop sessions with cloud-originated turns.
 *
 * Coverage:
 *  - Basic merge: cloud-only turns added to local
 *  - Dedup by message id (local wins on collision)
 *  - Local-only turns preserved when cloud is a subset
 *  - Per-turn metadata merge (memoryUpdateStatusByTurn, timeSavedStatusByTurn)
 *  - Desktop always wins for live state (isBusy, activeTurnId, lastError, draft)
 *  - CompactionBoundaries: desktop always wins
 *  - No-op when cloud has nothing new
 *  - updatedAt: max of both sides
 *  - Title: local wins unless empty, falls back to cloud
 *  - Metadata (pinnedAt, starredAt, deletedAt, resolvedAt): desktop always wins
 */

import { describe, expect, it } from 'vitest';
import type { AgentSession, AgentEvent, CompactionBoundary, MemoryUpdateStatus } from '@shared/types';
import { STALE_TURN_THRESHOLD_MS } from '@core/services/agentTurnReducer/runtime';

// The merge functions are exported for testing
import {
  _mergeSessionTurnsForTesting as mergeSessionTurns,
  _hasLocalOnlyTurnsForTesting as hasLocalOnlyTurns,
  _localHasContentCloudLacksForTesting as localHasContentCloudLacks,
} from '../cloudRouter';
// Shared title-merge primitive used by the FULL-REPLACEMENT pull branch in
// cloudRouter.ts (no local-only turns → accept cloud version).
import { resolvePulledTitle } from '../cloudRouterHelpers';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    title: 'Test session',
    createdAt: 1000,
    updatedAt: 1000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    doneAt: null,
    origin: 'manual',
    ...overrides,
  } as AgentSession;
}

function makeMessage(id: string, turnId: string, role: 'user' | 'assistant' | 'result', text: string, createdAt: number) {
  return { id, turnId, role, text, createdAt };
}

// --------------------------------------------------------------------------
// hasLocalOnlyTurns
// --------------------------------------------------------------------------

describe('hasLocalOnlyTurns', () => {
  it('returns false when both sides are empty', () => {
    const local = makeSession();
    const cloud = makeSession();
    expect(hasLocalOnlyTurns(local, cloud)).toBe(false);
  });

  it('returns false when local has no turns', () => {
    const local = makeSession();
    const cloud = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
    });
    expect(hasLocalOnlyTurns(local, cloud)).toBe(false);
  });

  it('returns false when cloud is a superset of local turns', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'hello', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
    });
    expect(hasLocalOnlyTurns(local, cloud)).toBe(false);
  });

  it('returns true when local has turns not in cloud', () => {
    const local = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'user', 'bye', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
    });
    const cloud = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
    });
    expect(hasLocalOnlyTurns(local, cloud)).toBe(true);
  });

  it('detects local-only turns from eventsByTurn keys even if not in messages', () => {
    const local = makeSession({
      messages: [],
      eventsByTurn: { 'turn-only-events': [] },
    });
    const cloud = makeSession();
    expect(hasLocalOnlyTurns(local, cloud)).toBe(true);
  });

  it('detects local-only turns from messages turnId even if not in eventsByTurn', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-msg-only', 'user', 'hi', 100)],
      eventsByTurn: {},
    });
    const cloud = makeSession();
    expect(hasLocalOnlyTurns(local, cloud)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// mergeSessionTurns
// --------------------------------------------------------------------------

describe('mergeSessionTurns', () => {
  it('returns null when cloud has no new data', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
    });
    const cloud = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
    });
    expect(mergeSessionTurns(local, cloud)).toBeNull();
  });

  it('returns null when both are empty', () => {
    const local = makeSession();
    const cloud = makeSession();
    expect(mergeSessionTurns(local, cloud)).toBeNull();
  });

  it('adds cloud-only messages to local', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 1500)],
      eventsByTurn: { 'turn-a': [] },
      updatedAt: 1000,
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 1500),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud reply', 2000),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [{ type: 'result', text: 'cloud reply' } as AgentEvent] },
      updatedAt: 2000,
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged).not.toBeNull();
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[1].text).toBe('cloud reply');
    expect(merged.eventsByTurn['turn-b']).toBeDefined();
    // updatedAt is derived from content: max(lastMsgCreatedAt=2000, createdAt=1000)
    expect(merged.updatedAt).toBe(2000);
  });

  it('deduplicates messages by id (local wins on collision)', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'local version', 100)],
      eventsByTurn: { 'turn-a': [] },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'cloud version', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'new', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged).not.toBeNull();
    const m1 = merged.messages.find((m) => m.id === 'm1');
    expect(m1!.text).toBe('local version');
    expect(merged.messages).toHaveLength(2);
  });

  it('local events win for shared turns', () => {
    const localEvent = { type: 'result', text: 'local result' } as AgentEvent;
    const cloudEvent = { type: 'result', text: 'cloud result' } as AgentEvent;

    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [localEvent] },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-c', 'assistant', 'new', 300),
      ],
      eventsByTurn: { 'turn-a': [cloudEvent], 'turn-c': [] },
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.eventsByTurn['turn-a'][0]).toBe(localEvent);
  });

  it('preserves local-only turns when merging cloud data', () => {
    const local = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'user', 'local only', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m3', 'turn-c', 'assistant', 'cloud only', 300),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-c': [] },
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.messages).toHaveLength(3);
    const turnIds = merged.messages.map((m) => m.turnId);
    expect(turnIds).toContain('turn-a');
    expect(turnIds).toContain('turn-b');
    expect(turnIds).toContain('turn-c');
    expect(merged.eventsByTurn).toHaveProperty('turn-b');
    expect(merged.eventsByTurn).toHaveProperty('turn-c');
  });

  it('sorts merged messages by createdAt', () => {
    const local = makeSession({
      messages: [makeMessage('m2', 'turn-a', 'user', 'second', 200)],
      eventsByTurn: { 'turn-a': [] },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-b', 'assistant', 'first', 100),
        makeMessage('m3', 'turn-c', 'assistant', 'third', 300),
      ],
      eventsByTurn: { 'turn-b': [], 'turn-c': [] },
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('projects live state fields from merged events (without clobbering metadata)', () => {
    const now = Date.now();
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: {
        'turn-a': [],
        'turn-active': [{ type: 'turn_started', timestamp: now }],
      },
      isBusy: true,
      activeTurnId: 'turn-active',
      lastError: 'local error',
      draft: { text: 'local draft', updatedAt: Date.now() },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      isBusy: false,
      activeTurnId: null,
      lastError: null,
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.isBusy).toBe(true);
    expect(merged.activeTurnId).toBe('turn-active');
    expect(merged.lastError).toBe('local error');
  });

  it('keeps local turn running when controller confirms activity despite stale events', () => {
    const staleTimestamp = Date.now() - STALE_TURN_THRESHOLD_MS - 1;
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: {
        'turn-a': [],
        'turn-active': [{ type: 'status', message: 'Thinking', timestamp: staleTimestamp } as AgentEvent],
      },
      isBusy: true,
      activeTurnId: 'turn-active',
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      isBusy: false,
      activeTurnId: null,
    });

    const merged = mergeSessionTurns(local, cloud, (turnId) => turnId === 'turn-active')!;
    expect(merged.isBusy).toBe(true);
    expect(merged.activeTurnId).toBe('turn-active');
  });

  it('prefers terminal events over controller-active stale suppression', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: {
        'turn-a': [],
        'turn-active': [{ type: 'result', text: 'done', timestamp: Date.now() } as AgentEvent],
      },
      isBusy: true,
      activeTurnId: 'turn-active',
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      isBusy: false,
      activeTurnId: null,
    });

    const merged = mergeSessionTurns(local, cloud, (turnId) => turnId === 'turn-active')!;
    expect(merged.isBusy).toBe(false);
    expect(merged.activeTurnId).toBeNull();
  });

  it('desktop always wins for metadata fields', () => {
    const now = Date.now();
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
      doneAt: null,
      starredAt: now - 1000,
      deletedAt: null,
      resolvedAt: now - 2000,
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      doneAt: now,
      starredAt: null,
      deletedAt: now - 500,
      resolvedAt: null,
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.doneAt).toBeNull();
    expect(merged.starredAt).toBe(now - 1000);
    expect(merged.deletedAt).toBeNull();
    expect(merged.resolvedAt).toBe(now - 2000);
  });

  it('uses local title unless empty, then falls back to cloud', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
      title: 'Local Title',
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      title: 'Cloud Title',
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.title).toBe('Local Title');
  });

  it('falls back to cloud title when local is empty', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
      title: '',
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      title: 'Cloud Title',
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.title).toBe('Cloud Title');
  });

  it('prefers cloud auto-generated title over local default "New conversation"', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
      title: 'New conversation',
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      title: 'Mindstone Operating Model',
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.title).toBe('Mindstone Operating Model');
  });

  it('prefers cloud auto-generated title over local default "New Agent Run"', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
      title: 'New Agent Run',
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      title: 'Budget Review',
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.title).toBe('Budget Review');
  });

  it('derives updatedAt from content timestamps across both sides', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 3000)],
      eventsByTurn: { 'turn-a': [] },
      updatedAt: 3000,
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 3000),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 2000),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      updatedAt: 2000,
    });

    const merged = mergeSessionTurns(local, cloud)!;
    // updatedAt derived from content: max(lastMsgCreatedAt=3000, createdAt=1000)
    expect(merged.updatedAt).toBe(3000);
  });

  it('merges per-turn metadata maps (local wins for shared turns, cloud fills gaps)', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
      memoryUpdateStatusByTurn: { 'turn-a': 'local-status' as unknown as MemoryUpdateStatus },
    }) as AgentSession & { memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus> };

    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      memoryUpdateStatusByTurn: { 'turn-a': 'cloud-status', 'turn-b': 'cloud-only-status' } as unknown as Record<string, MemoryUpdateStatus>,
    }) as AgentSession & { memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus> };

    const merged = mergeSessionTurns(local, cloud)! as AgentSession & { memoryUpdateStatusByTurn: Record<string, unknown> };
    expect(merged.memoryUpdateStatusByTurn['turn-a']).toBe('local-status');
    expect(merged.memoryUpdateStatusByTurn['turn-b']).toBe('cloud-only-status');
  });

  it('merges activitySummaryByTurn (local wins shared turn, preserves cloud-only and local-only)', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [], 'turn-local': [] },
      activitySummaryByTurn: {
        'turn-a': 'local sentence',
        'turn-local': 'local-only sentence',
      },
    }) as AgentSession & { activitySummaryByTurn: Record<string, string> };

    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      activitySummaryByTurn: {
        'turn-a': 'cloud sentence',
        'turn-b': 'cloud-only sentence',
      },
    }) as AgentSession & { activitySummaryByTurn: Record<string, string> };

    const merged = mergeSessionTurns(local, cloud)! as AgentSession & { activitySummaryByTurn: Record<string, string> };
    // Shared turn: local (desktop) wins.
    expect(merged.activitySummaryByTurn['turn-a']).toBe('local sentence');
    // Cloud-only turn: filled from cloud (else it would vanish on reconciliation — F2).
    expect(merged.activitySummaryByTurn['turn-b']).toBe('cloud-only sentence');
    // Local-only turn: preserved.
    expect(merged.activitySummaryByTurn['turn-local']).toBe('local-only sentence');
  });

  it('preserves a cloud summary on a SHARED turn whose key the local map lacks (F2 union merge)', () => {
    // Renderer snapshots always include `activitySummaryByTurn: { ... }`, so the
    // common shape is: local knows turn-a (it has messages/events) but its
    // summary map lacks turn-a's key (summary not generated locally yet), while
    // cloud generated it. The old mergePerTurnMap treats "primary knows the turn
    // but lacks this key" as authoritative absence and DROPS the cloud sentence.
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
      // Map present (matches renderer snapshot) but missing turn-a's key.
      activitySummaryByTurn: {},
    }) as AgentSession & { activitySummaryByTurn: Record<string, string> };

    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        // A new cloud message forces hasNewMessages so the merge proceeds.
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      activitySummaryByTurn: {
        'turn-a': 'cloud summary for shared turn',
      },
    }) as AgentSession & { activitySummaryByTurn: Record<string, string> };

    const merged = mergeSessionTurns(local, cloud)! as AgentSession & { activitySummaryByTurn: Record<string, string> };
    // FAILS under old mergePerTurnMap (turn-a is a shared/known turn → cloud key skipped).
    expect(merged.activitySummaryByTurn['turn-a']).toBe('cloud summary for shared turn');
  });

  it('applies a cloud-only summary on a metadata-only pull (no new messages/events) instead of returning null (F2 early-return gap)', () => {
    // The turn is already fully synced to desktop (same messages + events). Cloud
    // then generated a summary for it. The desktop was offline and missed the
    // live broadcast, so the only way this reaches the PERSISTED store is the
    // pull-merge write-back. The old code returned null here (no new
    // messages/events) and the summary was lost on disk.
    const sharedMessages = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
    const sharedEvents = { 'turn-a': [] as AgentEvent[] };
    const local = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      activitySummaryByTurn: {},
    }) as AgentSession & { activitySummaryByTurn: Record<string, string> };

    const cloud = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      activitySummaryByTurn: { 'turn-a': 'cloud summary, no new content' },
    }) as AgentSession & { activitySummaryByTurn: Record<string, string> };

    const merged = mergeSessionTurns(local, cloud);
    // FAILS under old code: `!hasNewMessages && !hasNewEvents` returned null.
    expect(merged).not.toBeNull();
    expect((merged as AgentSession & { activitySummaryByTurn: Record<string, string> }).activitySummaryByTurn['turn-a'])
      .toBe('cloud summary, no new content');
  });

  // F2 (260618 fix-autotitle-cloud-livesync): a title-only cloud update (cloud
  // generated a real title for a turn already fully synced to desktop) must NOT
  // be dropped by the metadata-only early return. The live broadcast can be
  // missed while offline; pull-merge write-back is the only durable path.
  it('applies a cloud-generated title on a metadata-only pull (no new messages/events) instead of returning null (F2 early-return gap)', () => {
    const sharedMessages = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
    const sharedEvents = { 'turn-a': [] as AgentEvent[] };
    const local = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      title: 'New conversation',
    });
    const cloud = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      title: 'Useful Title',
      autoTitleGeneratedAt: 1_700_000_000_000,
      autoTitleTurnCount: 1,
    });

    const merged = mergeSessionTurns(local, cloud);
    // FAILS under old code: `!hasNewMessages && !hasNewEvents` returned null.
    expect(merged).not.toBeNull();
    expect(merged!.title).toBe('Useful Title');
    expect(merged!.autoTitleGeneratedAt).toBe(1_700_000_000_000);
    expect(merged!.autoTitleTurnCount).toBe(1);
  });

  // F1 metadata-coherence (260618 refinement): the title strings are already
  // EQUAL (the cloud title was applied locally via the live broadcast / a prior
  // pull) but the persisted local store is missing the paired auto-title
  // metadata. The only durable path to repair the on-disk metadata is this
  // pull-merge write-back, so a metadata-only difference here must NOT be dropped
  // by the early return.
  it('F1: applies a metadata-only repair when titles are equal but local lacks the auto-title metadata (not null)', () => {
    const sharedMessages = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
    const sharedEvents = { 'turn-a': [] as AgentEvent[] };
    const local = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: undefined,
      autoTitleTurnCount: undefined,
    });
    const cloud = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: 1_700_000_777_777,
      autoTitleTurnCount: 6,
    });

    const merged = mergeSessionTurns(local, cloud);
    // FAILS under the pre-refinement code: hasNewCloudTitle requires
    // local.title !== cloud.title, so equal titles short-circuit the early return
    // to null and the on-disk metadata is never repaired.
    expect(merged).not.toBeNull();
    expect(merged!.title).toBe('Quarterly Planning');
    expect(merged!.autoTitleGeneratedAt).toBe(1_700_000_777_777);
    expect(merged!.autoTitleTurnCount).toBe(6);
  });

  it.each([
    'Conversation 7',
    'New Agent Run',
  ])(
    'F2: applies a cloud title on a metadata-only pull when local is the broader fallback title (%s)',
    (localTitle) => {
      const sharedMessages = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
      const sharedEvents = { 'turn-a': [] as AgentEvent[] };
      const local = makeSession({
        messages: sharedMessages,
        eventsByTurn: sharedEvents,
        title: localTitle,
      });
      const cloud = makeSession({
        messages: sharedMessages,
        eventsByTurn: sharedEvents,
        title: 'Quarterly Planning',
        autoTitleGeneratedAt: 1_700_000_222_222,
        autoTitleTurnCount: 2,
      });

      const merged = mergeSessionTurns(local, cloud);
      expect(merged).not.toBeNull();
      expect(merged!.title).toBe('Quarterly Planning');
      expect(merged!.autoTitleGeneratedAt).toBe(1_700_000_222_222);
      expect(merged!.autoTitleTurnCount).toBe(2);
    },
  );

  it('F2: does NOT bypass the early-return when local already has a real title and cloud title is auto-overwritable', () => {
    // No real title transition to apply → still returns null (scope guard: only a
    // genuine fallback→real cloud title change earns a metadata-only write).
    const sharedMessages = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
    const sharedEvents = { 'turn-a': [] as AgentEvent[] };
    const local = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      title: 'My Real Title',
    });
    const cloud = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      title: 'New conversation',
    });
    expect(mergeSessionTurns(local, cloud)).toBeNull();
  });

  it('F2: a real local title is preserved over a cloud fallback even when other content forces a merge', () => {
    // Manual rename / real local title wins. Scope: the broader predicate must not
    // let a cloud fallback overwrite a real local title.
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
      title: 'My Real Title',
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      title: 'Conversation 4',
    });
    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.title).toBe('My Real Title');
  });

  // 260619 cloud catch-up: a cloud-produced memory status (now persisted on the
  // executing surface) must reach the desktop on a metadata-only pull. This was
  // previously DROPPED — the early-return only relaxed for activity summaries and
  // the merge used the authoritative-absence mergePerTurnMap. Memory status now
  // joins the async/sparse camp (union + terminal-beats-running).
  it('applies a cloud-produced TERMINAL memory status for a shared known turn the desktop lacks (no new messages/events) instead of returning null (260619 catch-up)', () => {
    const sharedMessages = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
    const sharedEvents = { 'turn-a': [] as AgentEvent[] };
    const cloudStatus: MemoryUpdateStatus = {
      originalTurnId: 'turn-a',
      originalSessionId: 'sess-1',
      status: 'success',
      summary: 'updated 2 memories',
      timestamp: 1_700_000_000_000,
    };
    const local = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      memoryUpdateStatusByTurn: {},
    }) as AgentSession & { memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus> };
    const cloud = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      memoryUpdateStatusByTurn: { 'turn-a': cloudStatus },
    }) as AgentSession & { memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus> };

    const merged = mergeSessionTurns(local, cloud);
    // FAILS under old code: returned null (status-only difference ignored).
    expect(merged).not.toBeNull();
    expect(
      (merged as AgentSession & { memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus> })
        .memoryUpdateStatusByTurn['turn-a'],
    ).toEqual(cloudStatus);
  });

  it('resolves a same-turn memory-status conflict to the TERMINAL status (cloud success beats local running)', () => {
    const sharedMessages = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
    const sharedEvents = { 'turn-a': [] as AgentEvent[] };
    const localRunning: MemoryUpdateStatus = {
      originalTurnId: 'turn-a',
      originalSessionId: 'sess-1',
      status: 'running',
      timestamp: 1_700_000_000_000,
    };
    const cloudSuccess: MemoryUpdateStatus = {
      originalTurnId: 'turn-a',
      originalSessionId: 'sess-1',
      status: 'success',
      summary: 'done',
      timestamp: 1_700_000_001_000,
    };
    const local = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      memoryUpdateStatusByTurn: { 'turn-a': localRunning },
    }) as AgentSession & { memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus> };
    const cloud = makeSession({
      messages: sharedMessages,
      eventsByTurn: sharedEvents,
      memoryUpdateStatusByTurn: { 'turn-a': cloudSuccess },
    }) as AgentSession & { memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus> };

    const merged = mergeSessionTurns(local, cloud);
    expect(merged).not.toBeNull();
    expect(
      (merged as AgentSession & { memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus> })
        .memoryUpdateStatusByTurn['turn-a'].status,
    ).toBe('success');
  });

  it('preserves compactionBoundaries from desktop (local always wins)', () => {
    const localBoundaries: CompactionBoundary[] = [{ afterMessageIndex: 5, summary: 'compacted', timestamp: 1000, depth: 1 }];
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
      compactionBoundaries: localBoundaries,
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
      compactionBoundaries: [{ afterMessageIndex: 10, summary: 'compacted', timestamp: 2000, depth: 1 }] as CompactionBoundary[],
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged.compactionBoundaries).toBe(localBoundaries);
  });
});

// --------------------------------------------------------------------------
// resolvePulledTitle — FULL-REPLACEMENT pull branch title policy (F2)
// (cloudRouter.ts: "No local-only turns — safe to accept cloud version")
// --------------------------------------------------------------------------

describe('resolvePulledTitle (full-replacement pull branch)', () => {
  // F2 (260618): the full-replacement branch used the NARROW DEFAULT_SESSION_TITLES
  // set, so a local 'New Agent Run' / 'Conversation N' / first-message fallback
  // pinned a placeholder over the cloud's real title. The shared predicate fixes it.
  it.each([
    ['New conversation', []],
    ['New Agent Run', []],
    ['Conversation 7', []],
    ['Plan the offsite agenda', [makeMessage('m1', 'turn-a', 'user', 'Plan the offsite agenda', 1)]],
    ['', []],
  ])(
    'adopts the cloud real title + metadata when local title is auto-overwritable (%s)',
    (localTitle, messages) => {
      const local = makeSession({ title: localTitle, messages: messages as never });
      const cloud = makeSession({
        title: 'Quarterly Planning',
        autoTitleGeneratedAt: 1_700_000_222_222,
        autoTitleTurnCount: 2,
      });
      const resolved = resolvePulledTitle(local, cloud);
      expect(resolved.title).toBe('Quarterly Planning');
      expect(resolved.autoTitleGeneratedAt).toBe(1_700_000_222_222);
      expect(resolved.autoTitleTurnCount).toBe(2);
    },
  );

  it('preserves a real local (manual rename) title + its metadata over the cloud title', () => {
    const local = makeSession({
      title: 'My Custom Name',
      messages: [makeMessage('m1', 'turn-a', 'user', 'unrelated first message', 1)],
      autoTitleGeneratedAt: undefined,
      autoTitleTurnCount: undefined,
    });
    const cloud = makeSession({
      title: 'Cloud Auto Title',
      autoTitleGeneratedAt: 1_700_000_222_222,
      autoTitleTurnCount: 2,
    });
    const resolved = resolvePulledTitle(local, cloud);
    expect(resolved.title).toBe('My Custom Name');
    expect(resolved.autoTitleGeneratedAt).toBeUndefined();
    expect(resolved.autoTitleTurnCount).toBeUndefined();
  });

  // F1 metadata-coherence (260618 refinement): equal title strings where only
  // one side carries the auto-title metadata. The title + its auto-title
  // metadata are ONE unit; an equal-title merge must never strand metadata that
  // some side has. (The renderer live-title path can leave a local session with
  // the cloud title string but no metadata; the pull merge is the durable repair.)
  it('F1: equal titles, local missing metadata — adopts the cloud auto-title metadata (repair)', () => {
    const local = makeSession({
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: undefined,
      autoTitleTurnCount: undefined,
    });
    const cloud = makeSession({
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: 1_700_000_555_555,
      autoTitleTurnCount: 4,
    });
    const resolved = resolvePulledTitle(local, cloud);
    expect(resolved.title).toBe('Quarterly Planning');
    // FAILS under the pre-refinement code: local title is real (not
    // auto-overwritable) → resolvePulledTitle returns local's metadata =
    // undefined → cloud metadata not repaired.
    expect(resolved.autoTitleGeneratedAt).toBe(1_700_000_555_555);
    expect(resolved.autoTitleTurnCount).toBe(4);
  });

  it('F1: equal titles, only local has metadata — keeps the local metadata', () => {
    const local = makeSession({
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: 1_700_000_666_666,
      autoTitleTurnCount: 5,
    });
    const cloud = makeSession({
      title: 'Quarterly Planning',
      autoTitleGeneratedAt: undefined,
      autoTitleTurnCount: undefined,
    });
    const resolved = resolvePulledTitle(local, cloud);
    expect(resolved.title).toBe('Quarterly Planning');
    expect(resolved.autoTitleGeneratedAt).toBe(1_700_000_666_666);
    expect(resolved.autoTitleTurnCount).toBe(5);
  });
});

// ===========================================================================
// Cloud-synced field round-trip CONTRACT (family regression net)
// ===========================================================================
// The `cloud_synced_field_plumbing_gap` family (auto-title, show-more-activity,
// memory status) all took the SAME shape: a field a cloud-executed turn produced
// failed to reach the desktop on a metadata-only pull (a turn the desktop already
// fully synced — no new messages/events) because the early-return skipped it
// and/or the per-turn map merge dropped it. This parametrized contract asserts
// every such field SURVIVES that pull. Adding a new cloud-synced per-turn/session
// field? Add a case here — if it's missing, this net won't catch the next gap.
// (Live broadcast allowlist + push-merge direction are covered by their own
// tests: cloudEventChannel.* and cloudSessionMergeService.*.)
describe('cloud-synced field round-trip contract (metadata-only pull surfaces cloud-produced fields)', () => {
  type FieldCase = {
    name: string;
    localOverrides: Partial<AgentSession>;
    cloudOverrides: Partial<AgentSession>;
    assertSurvived: (merged: AgentSession) => void;
  };

  const cloudMemoryStatus: MemoryUpdateStatus = {
    originalTurnId: 'turn-a',
    originalSessionId: 'sess-1',
    status: 'success',
    summary: 'remembered 2 things',
    timestamp: 1_700_000_000_000,
  };

  const cases: FieldCase[] = [
    {
      name: 'activitySummaryByTurn (260618 show-more-activity)',
      localOverrides: { activitySummaryByTurn: {} },
      cloudOverrides: { activitySummaryByTurn: { 'turn-a': 'Drafted the budget memo' } },
      assertSurvived: (merged) =>
        expect(
          (merged as AgentSession & { activitySummaryByTurn: Record<string, string> })
            .activitySummaryByTurn['turn-a'],
        ).toBe('Drafted the budget memo'),
    },
    {
      name: 'memoryUpdateStatusByTurn (260619 catch-up)',
      localOverrides: { memoryUpdateStatusByTurn: {} },
      cloudOverrides: { memoryUpdateStatusByTurn: { 'turn-a': cloudMemoryStatus } },
      assertSurvived: (merged) =>
        expect(
          (merged as AgentSession & { memoryUpdateStatusByTurn: Record<string, MemoryUpdateStatus> })
            .memoryUpdateStatusByTurn['turn-a'],
        ).toEqual(cloudMemoryStatus),
    },
    {
      name: 'title + auto-title metadata (260618 fix-autotitle)',
      localOverrides: { title: 'New conversation' },
      cloudOverrides: {
        title: 'Project Budget Review',
        autoTitleGeneratedAt: 1_700_000_222_222,
        autoTitleTurnCount: 2,
      },
      assertSurvived: (merged) => {
        expect(merged.title).toBe('Project Budget Review');
        expect(merged.autoTitleGeneratedAt).toBe(1_700_000_222_222);
        expect(merged.autoTitleTurnCount).toBe(2);
      },
    },
  ];

  it.each(cases)('pull merge surfaces a cloud-produced $name on a shared known turn', ({ localOverrides, cloudOverrides, assertSurvived }) => {
    const sharedMessages = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
    const sharedEvents = { 'turn-a': [] as AgentEvent[] };
    const local = makeSession({ messages: sharedMessages, eventsByTurn: sharedEvents, ...localOverrides });
    const cloud = makeSession({ messages: sharedMessages, eventsByTurn: sharedEvents, ...cloudOverrides });

    const merged = mergeSessionTurns(local, cloud);
    // The whole point: a metadata-only pull (no new messages/events) must NOT
    // early-return null when a cloud-produced field is present.
    expect(merged).not.toBeNull();
    assertSurvived(merged as AgentSession);
  });
});

// ===========================================================================
// localHasContentCloudLacks predicate (Stage 1 — REBEL-6C0 / REBEL-6BZ)
// ===========================================================================
// The destructive "else" branch in syncSessionFromCloud fires when the old
// hasLocalOnlyTurns (turn-ID-set difference only) returns false.  The new
// localHasContentCloudLacks broadens that guard to also return true when, for
// any shared turn, local has MORE non-user messages OR more events — i.e. the
// local session has content the cloud snapshot lacks on a shared turn.
// Tests marked RED confirm the OLD hasLocalOnlyTurns missed these cases.
// ===========================================================================

describe('localHasContentCloudLacks predicate (Stage 1 — same-turn content divergence)', () => {
  // This test is RED on the current code because hasLocalOnlyTurns only checks
  // turn-ID set difference — it returns false when the same turn ID appears on
  // both sides even though local has more non-user messages.
  it('returns true when local has more non-user messages on a shared turn (RED on old hasLocalOnlyTurns)', () => {
    const localResult: AgentEvent = { type: 'result', text: 'Final answer with big table' } as AgentEvent;
    const local = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
        makeMessage('m-answer', 'turn-T', 'result', 'Big table answer', 300),
      ],
      eventsByTurn: { 'turn-T': [localResult] },
      updatedAt: 1000,
    });
    // Cloud has the SAME turn id but only the preamble — this is the REBEL-6C0
    // scenario: semantically older but chronologically newer cloud snapshot.
    const cloud = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
      ],
      eventsByTurn: { 'turn-T': [] },
      updatedAt: 2000,
    });

    // OLD hasLocalOnlyTurns returns false here (both know about turn-T).
    expect(hasLocalOnlyTurns(local, cloud)).toBe(false);
    // NEW predicate must return true — local has more non-user messages on turn-T.
    expect(localHasContentCloudLacks(local, cloud)).toBe(true);
  });

  it('returns true when local has a higher max event seq on a shared turn even if message counts match', () => {
    // Robust signal: local has a terminal result event with a higher seq than
    // cloud's last event. seq is monotonic per session, so this means local has
    // newer events cloud lacks (even regardless of array length).
    const localEvents: AgentEvent[] = [
      { type: 'status', message: 'Thinking', seq: 1 } as AgentEvent,
      { type: 'result', text: 'done', seq: 2 } as AgentEvent,
    ];
    const cloudEvents: AgentEvent[] = [
      { type: 'status', message: 'Thinking', seq: 1 } as AgentEvent,
    ];
    const sharedMsg = makeMessage('m-user', 'turn-T', 'user', 'hi', 100);
    const local = makeSession({
      messages: [sharedMsg],
      eventsByTurn: { 'turn-T': localEvents },
      updatedAt: 1000,
    });
    const cloud = makeSession({
      messages: [sharedMsg],
      eventsByTurn: { 'turn-T': cloudEvents },
      updatedAt: 2000,
    });

    expect(hasLocalOnlyTurns(local, cloud)).toBe(false);
    expect(localHasContentCloudLacks(local, cloud)).toBe(true);
  });

  it('returns false when local has more events by array length but the SAME max seq (length is not the signal)', () => {
    // Edge: local has more events in the array, but the max valid seq is equal to
    // cloud's. With the seq-based predicate this does NOT fire on the event signal.
    // (The non-user-message-count signal also does not fire here — equal user-only.)
    const localEvents: AgentEvent[] = [
      { type: 'status', message: 'a', seq: 1 } as AgentEvent,
      { type: 'status', message: 'b', seq: 2 } as AgentEvent,
    ];
    const cloudEvents: AgentEvent[] = [
      { type: 'status', message: 'c', seq: 2 } as AgentEvent,
    ];
    const sharedMsg = makeMessage('m-user', 'turn-T', 'user', 'hi', 100);
    const local = makeSession({
      messages: [sharedMsg],
      eventsByTurn: { 'turn-T': localEvents },
      updatedAt: 1000,
    });
    const cloud = makeSession({
      messages: [sharedMsg],
      eventsByTurn: { 'turn-T': cloudEvents },
      updatedAt: 2000,
    });

    expect(localHasContentCloudLacks(local, cloud)).toBe(false);
  });

  it('returns false when cloud is a superset of local for all shared turns', () => {
    const sharedMsg = makeMessage('m-user', 'turn-T', 'user', 'hi', 100);
    const sharedEvent: AgentEvent = { type: 'result', text: 'done' } as AgentEvent;
    const local = makeSession({
      messages: [sharedMsg],
      eventsByTurn: { 'turn-T': [sharedEvent] },
    });
    const cloud = makeSession({
      messages: [
        sharedMsg,
        makeMessage('m2', 'turn-T', 'assistant', 'extra', 200),
      ],
      eventsByTurn: { 'turn-T': [sharedEvent, { type: 'status', message: 'extra' } as AgentEvent] },
    });

    expect(localHasContentCloudLacks(local, cloud)).toBe(false);
  });

  it('returns true when local has a turn ID cloud lacks (subsumes old hasLocalOnlyTurns)', () => {
    const local = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'user', 'bye', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
    });
    const cloud = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
    });

    expect(localHasContentCloudLacks(local, cloud)).toBe(true);
  });

  it('returns false when both sessions have identical content', () => {
    const msg = makeMessage('m1', 'turn-a', 'user', 'hi', 100);
    const local = makeSession({
      messages: [msg],
      eventsByTurn: { 'turn-a': [{ type: 'result', text: 'done' } as AgentEvent] },
    });
    const cloud = makeSession({
      messages: [msg],
      eventsByTurn: { 'turn-a': [{ type: 'result', text: 'done' } as AgentEvent] },
    });

    expect(localHasContentCloudLacks(local, cloud)).toBe(false);
  });

  it('returns false when local is empty and cloud has all the content', () => {
    const local = makeSession();
    const cloud = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
    });

    expect(localHasContentCloudLacks(local, cloud)).toBe(false);
  });

  // COUNT-STABLE case (reviewer must-address): mergeResultMessage promotes an
  // assistant message to `result` IN-PLACE (same id, same count), and the local
  // turn gains a higher-seq terminal/result event while keeping an EQUAL-LENGTH
  // event array vs cloud. A non-user-message-count check AND an event-array-length
  // check would BOTH return false here — only the per-turn MAX VALID EVENT SEQ
  // comparison catches it. This is the exact shape that defeated the original
  // array-length predicate.
  it('returns true on the count-stable case: equal non-user count + equal event-array length, higher local max seq (RED on array-length predicate)', () => {
    // Local: one non-user message (preamble promoted to result IN-PLACE → role
    // 'result', same slot), one event array of length 1 but with a higher seq
    // (the terminal result event, seq 5).
    const local = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-answer', 'turn-T', 'result', 'Promoted-in-place final answer', 200),
      ],
      eventsByTurn: { 'turn-T': [{ type: 'result', text: 'final', seq: 5 } as AgentEvent] },
      updatedAt: 1000,
    });
    // Cloud: same turn id, ALSO one non-user message (the stale preamble, same id
    // slot but pre-promotion content), event array ALSO length 1 but a LOWER seq
    // (the stale streaming event, seq 2). EQUAL message count, EQUAL event count.
    const cloud = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-answer', 'turn-T', 'assistant', 'Stale preamble', 200),
      ],
      eventsByTurn: { 'turn-T': [{ type: 'assistant', text: 'stale', seq: 2 } as AgentEvent] },
      updatedAt: 1001, // chronologically newer but semantically older
    });

    // Both signals that an array-length / count predicate would use are EQUAL:
    expect(local.messages.filter((m) => m.role !== 'user')).toHaveLength(1);
    expect(cloud.messages.filter((m) => m.role !== 'user')).toHaveLength(1);
    expect(local.eventsByTurn['turn-T']).toHaveLength(1);
    expect(cloud.eventsByTurn['turn-T']).toHaveLength(1);

    // Old hasLocalOnlyTurns: false (both know turn-T). The robust max-seq signal
    // is the only thing that fires here.
    expect(hasLocalOnlyTurns(local, cloud)).toBe(false);
    expect(localHasContentCloudLacks(local, cloud)).toBe(true);
  });
});

// ===========================================================================
// Persistence root-cause regression: mergeSessionTurns via broadened routing
// ===========================================================================
// REBEL-6C0 / REBEL-6BZ (Stage 1 fix). The original routing was:
//   if (localHasUnknownTurns || restampedCount > 0) → mergeSessionTurns (safe)
//   else → full-replace with cloud snapshot (DESTRUCTIVE)
// The fix changes the routing predicate to: `localHasContentCloudLacks` which
// also triggers the additive mergeSessionTurns path when local has more content
// on a shared turn.
// ===========================================================================

describe('persistence root-cause regression: final answer preserved when cloud is same-turn-poorer (REBEL-6C0)', () => {
  // The key REBEL-6C0 scenario: local turn T has [user, preamble, finalAnswer(result)];
  // cloud has the SAME turn T but only [user, preamble].  Cloud's updatedAt is
  // newer (e.g. bumped by a memory/activity push).  Previously: localHasUnknownTurns
  // returned false → destructive full-replace fired → finalAnswer lost on disk.
  // Fixed: localHasContentCloudLacks returns true → mergeSessionTurns fires (local wins).
  //
  // The core protection: localHasContentCloudLacks must fire, routing to mergeSessionTurns
  // and BYPASSING the destructive else-branch full-replace. mergeSessionTurns with
  // local-as-superset returns null (no new cloud content to add — correct behavior, local
  // disk is already good) rather than writing a cloud-poorer snapshot.
  it('localHasContentCloudLacks fires for the REBEL-6C0 scenario (cloud same-turn-poorer) — the destructive full-replace is bypassed', () => {
    const resultEvent: AgentEvent = { type: 'result', text: 'Big answer table' } as AgentEvent;
    const local = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
        makeMessage('m-answer', 'turn-T', 'result', 'Big answer table', 300),
      ],
      eventsByTurn: { 'turn-T': [resultEvent] },
      updatedAt: 1000,
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
      ],
      eventsByTurn: { 'turn-T': [] },
      updatedAt: 2000, // cloud is chronologically newer but semantically older
    });

    // Confirm old hasLocalOnlyTurns would NOT have triggered the safe path
    expect(hasLocalOnlyTurns(local, cloud)).toBe(false);
    // Confirm new predicate DOES trigger the safe path (prevents destructive full-replace)
    expect(localHasContentCloudLacks(local, cloud)).toBe(true);

    // When mergeSessionTurns is called with local-as-superset, it returns null
    // (no new cloud content to add). This is correct: the local disk is already good,
    // no upsert needed. The key protection is that the destructive full-replace was bypassed.
    const merged = mergeSessionTurns(local, cloud);
    expect(merged).toBeNull(); // null = no new cloud content, local already correct on disk
  });

  it('mergeSessionTurns preserves local finalAnswer when cloud has new content PLUS same-turn-poorer snapshot', () => {
    // More complex scenario: cloud has a new turn (turn-B) but FEWER messages
    // on the shared turn (turn-T). mergeSessionTurns must: (a) add the new cloud
    // turn, AND (b) preserve the local final answer on turn-T.
    const resultEvent: AgentEvent = { type: 'result', text: 'Big answer table' } as AgentEvent;
    const local = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
        makeMessage('m-answer', 'turn-T', 'result', 'Big answer table', 300),
      ],
      eventsByTurn: { 'turn-T': [resultEvent] },
      updatedAt: 1000,
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
        // Cloud also has a new turn (e.g. from mobile/web)
        makeMessage('m-cloud-new', 'turn-B', 'assistant', 'cloud new turn answer', 400),
      ],
      eventsByTurn: {
        'turn-T': [], // cloud turn-T is poorer
        'turn-B': [{ type: 'result', text: 'cloud new turn answer' } as AgentEvent],
      },
      updatedAt: 2000,
    });

    // localHasContentCloudLacks fires (local has more messages on turn-T)
    expect(localHasContentCloudLacks(local, cloud)).toBe(true);

    // mergeSessionTurns: adds turn-B from cloud AND preserves local turn-T messages
    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged).not.toBeNull();

    // The result message from turn-T must survive (local wins)
    const resultMsg = merged.messages.find((m) => m.id === 'm-answer');
    expect(resultMsg).toBeDefined();
    expect(resultMsg?.text).toBe('Big answer table');

    // The result event for turn-T must survive (local events win for shared turns)
    expect(merged.eventsByTurn['turn-T']).toContain(resultEvent);

    // Cloud's new turn-B is also incorporated
    expect(merged.messages.map((m) => m.id)).toContain('m-cloud-new');
    expect(merged.eventsByTurn['turn-B']).toBeDefined();
  });

  it('mergeSessionTurns preserves all local non-user messages on the shared turn when cloud adds a new turn', () => {
    const resultEvent: AgentEvent = { type: 'result', text: 'Final answer' } as AgentEvent;
    const local = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
        makeMessage('m-answer', 'turn-T', 'result', 'Final answer', 300),
      ],
      eventsByTurn: { 'turn-T': [resultEvent] },
      updatedAt: 1000,
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'Let me look…', 200),
        // Cloud has a new turn
        makeMessage('m-cloud-new', 'turn-B', 'assistant', 'extra', 400),
      ],
      eventsByTurn: {
        'turn-T': [], // cloud is poorer on turn-T
        'turn-B': [],
      },
      updatedAt: 2000,
    });

    const merged = mergeSessionTurns(local, cloud)!;
    // Local has 3 messages on turn-T; plus 1 new from cloud turn-B = 4 total
    expect(merged.messages).toHaveLength(4);
    expect(merged.messages.map((m) => m.id)).toContain('m-answer');
    expect(merged.messages.map((m) => m.id)).toContain('m-preamble');
  });

  // Positive back-compat: cloud-only NEW message on a shared turn must still merge in
  it('still incorporates a cloud-only new message on a shared turn (Assumption #1 back-compat)', () => {
    const local = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'preamble', 200),
      ],
      eventsByTurn: { 'turn-T': [] },
      updatedAt: 1000,
    });
    // Cloud has same content PLUS an extra message with a new ID (mobile/web edit)
    const cloud = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'question', 100),
        makeMessage('m-preamble', 'turn-T', 'assistant', 'preamble', 200),
        makeMessage('m-cloud-extra', 'turn-T', 'assistant', 'cloud note', 250),
      ],
      eventsByTurn: { 'turn-T': [] },
      updatedAt: 2000,
    });

    // local does NOT have more content than cloud (cloud is superset) — predicate false
    expect(localHasContentCloudLacks(local, cloud)).toBe(false);
    // But mergeSessionTurns still unions by message id — cloud-only new id survives
    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged).not.toBeNull();
    expect(merged.messages.map((m) => m.id)).toContain('m-cloud-extra');
  });

  // First-pull / disjoint case: cloud has entirely new turns that local doesn't know.
  // The predicate must NOT fire just because cloud has more (cloud is a SUPERSET).
  it('does not fire when cloud is a superset of local (first-pull / disjoint stays additive)', () => {
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud turn', 200),
      ],
      eventsByTurn: { 'turn-a': [], 'turn-b': [{ type: 'result', text: 'done' } as AgentEvent] },
    });

    expect(localHasContentCloudLacks(local, cloud)).toBe(false);
  });
});

// ===========================================================================
// DA F1 — anti-regression: mergeEventsForDesktopPull is local-wins-wholesale
// on shared TERMINAL turns (DELIBERATE asymmetry protecting the final answer)
// ===========================================================================
// This asymmetry MUST NOT be "harmonized" into a symmetric union — that would
// re-open REBEL-6C0 (a cloud-poorer event array would replace the local answer).
// These tests lock the behavior so any future "harmonization" fails loudly.
// ===========================================================================

describe('DA F1 anti-regression: mergeEventsForDesktopPull local-wins-wholesale on shared terminal turns', () => {
  it('local events win wholesale when local turn is terminal (no cloud event additions)', () => {
    // Local has a completed terminal turn. Cloud also has events for the same turn
    // (e.g. cloud executed a parallel copy of the turn). Local wins wholesale —
    // cloud events for this turn are DROPPED. This is intentional.
    const localEvents: AgentEvent[] = [
      { type: 'status', message: 'Thinking' } as AgentEvent,
      { type: 'result', text: 'local final answer' } as AgentEvent,
    ];
    const cloudEvents: AgentEvent[] = [
      { type: 'status', message: 'cloud status' } as AgentEvent,
      { type: 'result', text: 'cloud result' } as AgentEvent,
    ];
    const local = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'question', 100),
        makeMessage('m2', 'turn-a', 'result', 'local final answer', 200),
      ],
      eventsByTurn: { 'turn-a': localEvents },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'question', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud other turn', 300),
      ],
      eventsByTurn: { 'turn-a': cloudEvents, 'turn-b': [] },
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged).not.toBeNull();
    // Local events for turn-a must win wholesale
    expect(merged.eventsByTurn['turn-a']).toStrictEqual(localEvents);
    // Cloud's event array for turn-a must NOT appear
    expect(merged.eventsByTurn['turn-a']).not.toContain(cloudEvents[0]);
    // DELIBERATE: the local final answer survives
    expect(merged.eventsByTurn['turn-a'].some((e) => e.type === 'result' && (e as { text?: string }).text === 'local final answer')).toBe(true);
  });

  it('cloud events do NOT get unioned into a locally-terminal turn (symmetric union would be wrong)', () => {
    // This test makes the ASYMMETRY explicit: even though cloud has an event local
    // lacks for turn-a, it is NOT added because local already completed the turn.
    const localResult: AgentEvent = { type: 'result', text: 'local result' } as AgentEvent;
    const cloudExtraEvent: AgentEvent = { type: 'status', message: 'cloud extra status' } as AgentEvent;
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [localResult] },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'cloud turn', 200),
      ],
      eventsByTurn: {
        'turn-a': [cloudExtraEvent, localResult],  // cloud has an extra event local lacks
        'turn-b': [],
      },
    });

    const merged = mergeSessionTurns(local, cloud)!;
    // Local's event array is kept wholesale — cloudExtraEvent is NOT merged in
    expect(merged.eventsByTurn['turn-a']).toStrictEqual([localResult]);
    expect(merged.eventsByTurn['turn-a']).not.toContain(cloudExtraEvent);
  });
});

// ===========================================================================
// Completeness F2 — inverse edge: cloud terminal supersedes local non-terminal
// (local streaming events may be dropped — bounded as intentional)
// ===========================================================================
// When cloud has a terminal event for a shared turn and local does NOT, cloud's
// entire event array replaces local's. This means local non-terminal streaming
// events can be dropped. This is intentional (cloud terminal beats local
// unterminated) and must be documented + tested to prevent misclassification as
// a bug.
// ===========================================================================

describe('Completeness F2 inverse edge: cloud terminal supersedes local non-terminal on shared turn', () => {
  it('cloud events replace local non-terminal events when cloud has terminal and local does not', () => {
    // Local has partial streaming events (turn in progress / not yet terminal).
    // Cloud received the terminal result (e.g. from a cloud-executed turn).
    // Cloud's event array replaces local's wholesale.
    const localStreamingEvents: AgentEvent[] = [
      { type: 'status', message: 'Streaming…' } as AgentEvent,
      { type: 'assistant', text: 'partial answer…' } as AgentEvent,
    ];
    const cloudTerminalEvents: AgentEvent[] = [
      { type: 'result', text: 'cloud completed answer' } as AgentEvent,
    ];
    const local = makeSession({
      messages: [makeMessage('m1', 'turn-T', 'user', 'question', 100)],
      eventsByTurn: { 'turn-T': localStreamingEvents },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m1', 'turn-T', 'user', 'question', 100),
        makeMessage('m2', 'turn-T', 'result', 'cloud completed answer', 200),
      ],
      eventsByTurn: { 'turn-T': cloudTerminalEvents },
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged).not.toBeNull();
    // Cloud terminal event array replaces local's non-terminal events
    expect(merged.eventsByTurn['turn-T']).toStrictEqual(cloudTerminalEvents);
    // Local streaming events are gone — this is INTENTIONAL (cloud terminal wins)
    expect(merged.eventsByTurn['turn-T']).not.toContain(localStreamingEvents[0]);
    expect(merged.eventsByTurn['turn-T']).not.toContain(localStreamingEvents[1]);
  });

  it('F2 inverse-edge note: local non-terminal events are dropped intentionally (bounded, not a bug)', () => {
    // Same scenario but verifying the cloud result message is preserved in merged messages
    const localStreamingEvents: AgentEvent[] = [
      { type: 'assistant', text: 'streaming partial' } as AgentEvent,
    ];
    const cloudTerminalEvents: AgentEvent[] = [
      { type: 'result', text: 'cloud final' } as AgentEvent,
    ];
    const local = makeSession({
      messages: [makeMessage('m-user', 'turn-T', 'user', 'q', 100)],
      eventsByTurn: { 'turn-T': localStreamingEvents },
    });
    const cloud = makeSession({
      messages: [
        makeMessage('m-user', 'turn-T', 'user', 'q', 100),
        makeMessage('m-result', 'turn-T', 'result', 'cloud final', 200),
      ],
      eventsByTurn: { 'turn-T': cloudTerminalEvents },
    });

    const merged = mergeSessionTurns(local, cloud)!;
    expect(merged).not.toBeNull();
    // Cloud result message included (via message dedup)
    expect(merged.messages.map((m) => m.id)).toContain('m-result');
    // Cloud terminal event wins
    expect(merged.eventsByTurn['turn-T']).toStrictEqual(cloudTerminalEvents);
  });
});
