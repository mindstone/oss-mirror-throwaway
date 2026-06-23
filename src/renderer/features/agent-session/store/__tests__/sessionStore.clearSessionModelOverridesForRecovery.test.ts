import { createSessionStore } from '../sessionStore';

/**
 * FOX-3494 (round-2 M2): the "Switch to GPT" recovery for a claude-* model under
 * connected ChatGPT Pro must neutralize the conversation's per-session model /
 * thinking overrides. Session overrides take precedence over global settings in
 * core, so without clearing them the immediate retry AND every future turn would
 * loop back into the same Claude/Anthropic terminal even though the global
 * settings were repaired to a GPT model.
 *
 * FOX-3494 (round-3 F2): the store action has no session-id parameter — it
 * always reads/persists whatever conversation is current. That is by design:
 * the wrong-session race is guarded at the single async caller
 * (`handleApplySessionErrorResolution` in App.tsx) with a stale-action check
 * captured before the awaited `applyResolution` IPC. The tests below assert
 * (a) the persisted payload's session id + cleared fields, and (b) that the
 * action follows the *current* session (which is exactly why the caller-side
 * guard is required when a session switch can interleave with the await).
 */

let upsertMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  upsertMock = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: upsertMock,
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe('clearSessionModelOverridesForRecovery', () => {
  it('clears a session-level Claude thinking/working override and persists', async () => {
    const store = createSessionStore();
    // NB: the action persists the CURRENT session. `createBackgroundSession`
    // does NOT switch the current session, so the overrides + persist target the
    // store's initial current session — captured below as the recovery target.
    // Give it a draft so `snapshotCurrentSession()` returns a persistable snapshot.
    store.getState().setDraftForSession(store.getState().currentSessionId, 'pending text');

    // Simulate a per-conversation Claude selection via the model selector.
    store.getState().setSessionModelOverrides({
      workingModel: 'claude-opus-4-8',
      thinkingModel: 'claude-sonnet-4-6',
      workingProfileId: undefined,
      thinkingProfileId: 'claude-planning-profile',
      thinkingEffort: 'high',
    });

    expect(store.getState().sessionThinkingModel).toBe('claude-sonnet-4-6');
    expect(store.getState().sessionThinkingProfileId).toBe('claude-planning-profile');

    const recoverySessionId = store.getState().currentSessionId;

    store.getState().clearSessionModelOverridesForRecovery();

    // Model + thinking overrides collapse so the next turn honours global GPT
    // settings; thinkingEffort (provider-agnostic) is intentionally preserved.
    expect(store.getState().sessionWorkingModel).toBeUndefined();
    expect(store.getState().sessionThinkingModel).toBeUndefined();
    expect(store.getState().sessionWorkingProfileId).toBeUndefined();
    expect(store.getState().sessionThinkingProfileId).toBeUndefined();
    expect(store.getState().sessionThinkingEffort).toBe('high');

    // Persisted so FUTURE turns in the conversation also route to GPT. The
    // persisted payload must target the recovery conversation and carry the
    // cleared override fields (not just the in-memory state).
    await Promise.resolve();
    await Promise.resolve();
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const persisted = upsertMock.mock.calls[0][0];
    expect(persisted.id).toBe(recoverySessionId);
    expect(persisted.sessionWorkingModel).toBeUndefined();
    expect(persisted.sessionThinkingModel).toBeUndefined();
    expect(persisted.sessionWorkingProfileId).toBeUndefined();
    expect(persisted.sessionThinkingProfileId).toBeUndefined();
  });

  it('is a no-op (no persist) when there are no session overrides to clear', async () => {
    const store = createSessionStore();
    store.getState().createBackgroundSession('sess-2', 'plugin');
    upsertMock.mockClear();

    store.getState().clearSessionModelOverridesForRecovery();

    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('operates on the CURRENT session — documenting why the caller must guard against a mid-await switch', async () => {
    const store = createSessionStore();

    // Conversation A: the conversation that produced the failed turn. Capture its
    // id as the recovery target (this is what App.tsx captures before the await),
    // and give it a stale Claude session override.
    const recoverySessionId = store.getState().currentSessionId;
    store.getState().setSessionModelOverrides({
      workingModel: 'claude-opus-4-8',
      thinkingModel: undefined,
      workingProfileId: undefined,
      thinkingProfileId: undefined,
      thinkingEffort: undefined,
    });

    // The user navigates to conversation B while applyResolution is in flight.
    // (openHistorySession loads from the LRU cache, so cache B first — mirroring
    // the async engine path that fetches + caches before switching.)
    store.getState().cacheSession({
      id: 'sess-B',
      title: 'Conversation B',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      doneAt: null,
      starredAt: null,
      origin: 'manual',
      // B has its OWN, deliberate Claude selection that must NOT be clobbered.
      sessionWorkingModel: 'claude-sonnet-4-6',
    } as never);
    store.getState().openHistorySession('sess-B');

    const currentSessionId = store.getState().currentSessionId;

    // The recovery target is no longer current. App.tsx's stale-action guard
    // (currentSessionId === recoverySessionId) is now FALSE, so the clear+retry
    // must be skipped. Assert the condition the guard keys on.
    expect(currentSessionId).toBe('sess-B');
    expect(currentSessionId).not.toBe(recoverySessionId);

    // And prove the action itself has no session targeting: if it were called
    // anyway (the bug), it would clear conversation B — not A. This is exactly
    // the wrong-session blast radius the caller-side guard prevents.
    expect(store.getState().sessionWorkingModel).toBe('claude-sonnet-4-6');
    store.getState().clearSessionModelOverridesForRecovery();
    expect(store.getState().sessionWorkingModel).toBeUndefined();
  });
});
