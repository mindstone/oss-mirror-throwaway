import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSessionStore } from '../sessionStore';

/**
 * Unit tests for background session creation and per-session draft management.
 *
 * These tests verify:
 * 1. createBackgroundSession creates a session with correct origin, caches it, and persists via IPC
 * 2. setDraftForSession updates draft metadata for non-current background sessions
 * 3. createBackgroundSession does not overwrite existing sessions (duplicate ID guard)
 */

// Mock window APIs required by sessionStore (matches pattern from selectIsEffectivelyIdleForUi.test.ts)
beforeEach(() => {
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe('createBackgroundSession', () => {
  it('creates a session summary with origin "plugin" and caches it', () => {
    const store = createSessionStore();
    const sessionId = 'bg-session-1';

    store.getState().createBackgroundSession(sessionId, 'plugin');

    // Session should appear in sessionSummaries
    const summary = store.getState().sessionSummaries.find(s => s.id === sessionId);
    expect(summary).toBeDefined();
    expect(summary!.origin).toBe('plugin');

    // Session should be cached in loadedSessions
    const cached = store.getState().getLoadedSession(sessionId);
    expect(cached).toBeDefined();
    expect(cached!.id).toBe(sessionId);
    expect(cached!.origin).toBe('plugin');
  });

  it('calls window.sessionsApi.upsert to persist the session', () => {
    const store = createSessionStore();
    const sessionId = 'bg-session-persist';

    store.getState().createBackgroundSession(sessionId, 'plugin');

    // addOrUpdateHistorySession calls cacheSession which triggers upsert via fire-and-forget
    expect(window.sessionsApi.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: sessionId, origin: 'plugin' })
    );
  });

  it('does not overwrite an existing session (duplicate ID check)', () => {
    const store = createSessionStore();
    const sessionId = 'bg-session-dup';

    // First creation
    store.getState().createBackgroundSession(sessionId, 'plugin');
    const firstSummary = store.getState().sessionSummaries.find(s => s.id === sessionId);
    expect(firstSummary).toBeDefined();
    const originalCreatedAt = firstSummary!.createdAt;

    // Second creation with same ID — should be a no-op
    store.getState().createBackgroundSession(sessionId, 'automation');

    // Should still have only one summary with original origin
    const summaries = store.getState().sessionSummaries.filter(s => s.id === sessionId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].origin).toBe('plugin');
    expect(summaries[0].createdAt).toBe(originalCreatedAt);
  });

  it('upgrades existing manual-origin sessions to a more specific origin', () => {
    const store = createSessionStore();
    const sessionId = 'bg-session-origin-upgrade';

    store.getState().createBackgroundSession(sessionId);
    store.getState().createBackgroundSession(sessionId, 'mcp-tool');

    const summary = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(summary).toBeDefined();
    expect(summary!.origin).toBe('mcp-tool');

    const loaded = store.getState().getLoadedSession(sessionId);
    expect(loaded).toBeDefined();
    expect(loaded!.origin).toBe('mcp-tool');
    expect(window.sessionsApi.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: sessionId, origin: 'mcp-tool' }),
    );
  });

  it('does not switch currentSessionId', () => {
    const store = createSessionStore();
    const originalSessionId = store.getState().currentSessionId;

    store.getState().createBackgroundSession('bg-session-no-switch', 'plugin');

    expect(store.getState().currentSessionId).toBe(originalSessionId);
  });

  it('defaults origin to "manual" when not specified', () => {
    const store = createSessionStore();
    store.getState().createBackgroundSession('bg-session-default');

    const summary = store.getState().sessionSummaries.find(s => s.id === 'bg-session-default');
    expect(summary).toBeDefined();
    expect(summary!.origin).toBe('manual');
  });

  it('preserves origin "browser-extension" for extension-started sessions', () => {
    const store = createSessionStore();
    store.getState().createBackgroundSession('bg-session-browser-extension', 'browser-extension');

    const summary = store.getState().sessionSummaries.find(
      s => s.id === 'bg-session-browser-extension'
    );
    expect(summary).toBeDefined();
    expect(summary!.origin).toBe('browser-extension');
  });
});

describe('setDraftForSession on background session', () => {
  it('updates draftsBySessionId for a non-current background session', () => {
    const store = createSessionStore();
    const bgId = 'bg-draft-session';

    // Create background session and set draft
    store.getState().createBackgroundSession(bgId, 'plugin');
    store.getState().setDraftForSession(bgId, 'Hello world');

    const draft = store.getState().draftsBySessionId[bgId];
    expect(draft).toBeDefined();
    expect(draft!.text).toBe('Hello world');
    expect(draft!.updatedAt).toBeGreaterThan(0);
  });

  it('updates hasDraft, draftPreview, and draftUpdatedAt on the session summary', () => {
    const store = createSessionStore();
    const bgId = 'bg-draft-meta';

    store.getState().createBackgroundSession(bgId, 'plugin');
    store.getState().setDraftForSession(bgId, 'Draft preview text');

    const summary = store.getState().sessionSummaries.find(s => s.id === bgId);
    expect(summary).toBeDefined();
    expect(summary!.hasDraft).toBe(true);
    expect(summary!.draftPreview).toBeTruthy();
    expect(summary!.draftUpdatedAt).toBeGreaterThan(0);
  });

  it('does not affect the current session', () => {
    const store = createSessionStore();
    const currentId = store.getState().currentSessionId;
    const bgId = 'bg-draft-isolation';

    store.getState().createBackgroundSession(bgId, 'plugin');
    store.getState().setDraftForSession(bgId, 'Background draft');

    // Current session should have no draft
    const currentDraft = store.getState().draftsBySessionId[currentId];
    expect(currentDraft).toBeUndefined();
  });

  it('clears draft when text is empty', () => {
    const store = createSessionStore();
    const bgId = 'bg-draft-clear';

    store.getState().createBackgroundSession(bgId, 'plugin');
    store.getState().setDraftForSession(bgId, 'Some draft');
    expect(store.getState().draftsBySessionId[bgId]).toBeDefined();

    // Clear by setting empty text
    store.getState().setDraftForSession(bgId, '');
    expect(store.getState().draftsBySessionId[bgId]).toBeUndefined();
  });
});
