import { describe, expect, it } from 'vitest';
import type { AgentSessionSummary } from '@shared/types';
import { ratchetSummaryUpdatedAt } from '../useAgentSessionEngine';

/**
 * Layer B ratchet tests for the focused-session save path.
 *
 * Background: `saveSessionAndUpdateSummary` and `saveSessionByIdAndUpdateSummary`
 * derive a fresh summary from the session whose `updatedAt` is taken from the
 * (text-aggregated) last message createdAt. Cloud-sync's wholesale
 * `setSessionSummaries` can bump the in-memory summary's `updatedAt` to a
 * disk-side value that's strictly greater than the per-event derived value,
 * which used to seesaw the focused session's sidebar position vs. concurrent
 * background streamers. The ratchet guarantees `updatedAt` is monotonically
 * non-decreasing on this write path.
 *
 * See docs/plans/260427_sidebar_concurrent_swap_groundup_fix.md (Layer B).
 */

const summary = (overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 'sess-ratchet-test',
  title: 'test',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  resolvedAt: null,
  doneAt: null,
  starredAt: null,
  deletedAt: null,
  origin: 'manual',
  isCorrupted: false,
  preview: '',
  messageCount: 0,
  hasDraft: false,
  draftPreview: null,
  draftUpdatedAt: null,
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  ...overrides,
});

describe('ratchetSummaryUpdatedAt — Layer B sidebar-sort ratchet', () => {
  it('does NOT decrease updatedAt when existing summary is newer', () => {
    const existing = summary({ updatedAt: 1_700_000_010_000 });
    const next = summary({ updatedAt: 1_700_000_005_000 });

    const result = ratchetSummaryUpdatedAt(next, existing);

    expect(result.updatedAt).toBe(1_700_000_010_000);
    // Identity preserved on other fields.
    expect(result.id).toBe(next.id);
  });

  it('takes the new updatedAt when next is strictly newer', () => {
    const existing = summary({ updatedAt: 1_700_000_005_000 });
    const next = summary({ updatedAt: 1_700_000_010_000 });

    const result = ratchetSummaryUpdatedAt(next, existing);

    expect(result.updatedAt).toBe(1_700_000_010_000);
    // No-op clone when next.updatedAt already wins (perf detail).
    expect(result).toBe(next);
  });

  it('uses next.updatedAt as-is when there is no existing summary', () => {
    const next = summary({ updatedAt: 1_700_000_005_000 });

    const result = ratchetSummaryUpdatedAt(next, undefined);

    expect(result.updatedAt).toBe(1_700_000_005_000);
    expect(result).toBe(next);
  });

  it('handles future-dated existing updatedAt (cloud-synced clocks can be ahead)', () => {
    // Cloud-synced summaries can carry timestamps that are slightly ahead of
    // the local wall clock. Ratchet must still preserve them.
    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const existing = summary({ updatedAt: farFuture });
    const next = summary({ updatedAt: Date.now() });

    const result = ratchetSummaryUpdatedAt(next, existing);

    expect(result.updatedAt).toBe(farFuture);
  });

  it('preserves all non-updatedAt fields from next when ratcheting up', () => {
    const existing = summary({
      updatedAt: 1_700_000_010_000,
      preview: 'old preview',
      messageCount: 3,
      isBusy: false,
      activeTurnId: null,
    });
    const next = summary({
      updatedAt: 1_700_000_005_000,
      preview: 'new preview',
      messageCount: 4,
      isBusy: true,
      activeTurnId: 'turn-2',
    });

    const result = ratchetSummaryUpdatedAt(next, existing);

    expect(result.updatedAt).toBe(1_700_000_010_000); // ratcheted from existing
    expect(result.preview).toBe('new preview');
    expect(result.messageCount).toBe(4);
    expect(result.isBusy).toBe(true);
    expect(result.activeTurnId).toBe('turn-2');
  });

  it('treats equal updatedAt as a no-op (no clone)', () => {
    const existing = summary({ updatedAt: 1_700_000_005_000 });
    const next = summary({ updatedAt: 1_700_000_005_000 });

    const result = ratchetSummaryUpdatedAt(next, existing);

    expect(result.updatedAt).toBe(1_700_000_005_000);
    expect(result).toBe(next);
  });
});

describe('ratchet APPLIED at save call sites', () => {
  // The helper tests above prove `ratchetSummaryUpdatedAt` is correct in
  // isolation. These tests guard against a future regression where a refactor
  // accidentally removes the ratchet from one of the two call sites in
  // `useAgentSessionEngine.ts`:
  //   - `saveSessionAndUpdateSummary`     — useAgentSessionEngine.ts:~2664
  //   - `saveSessionByIdAndUpdateSummary` — useAgentSessionEngine.ts:~2706
  //
  // Both call sites are inner closures inside the engine subscription
  // useEffect (not exported), so testing them directly would require mounting
  // the hook via React, providing a Zustand store and persistenceManager
  // fixture, mocking `window.sessionsApi.get`, and synthesizing an
  // engine-event flow that triggers `doSave` — far beyond the existing test
  // infrastructure for this file.
  //
  // Tracked as `it.todo` so the gap is visible. Replace with real tests once
  // the call-site infrastructure exists (e.g. via a renderer-side hook test
  // rig or extraction of these closures into module-level pure functions).
  it.todo(
    'saveSessionAndUpdateSummary does NOT decrease stored summary updatedAt when session is older than existing summary',
  );

  it.todo(
    'saveSessionByIdAndUpdateSummary does NOT decrease stored summary updatedAt when session is older than existing summary',
  );
});
