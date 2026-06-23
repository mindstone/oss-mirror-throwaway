/**
 * Final-review fix round (F1, 260612 recs-round5): a store-dropped CLI session
 * write must surface from `runHeadlessTurn` as a typed
 * `CliSessionPersistDroppedError` and must NOT emit `session_persisted` —
 * pre-fix the runner reported success and emitted the event for a write the
 * store refused (tombstoned / read-only / corrupt-index / version-forward).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import type { IncrementalSessionStore } from '@core/services/incrementalSessionStore';
import type { SessionLockManager } from '@core/utils/sessionFileLock';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  configureCliSessionPersistence,
  configureHeadlessTurnExecutor,
  runHeadlessTurn,
} from '../headlessTurnRunner';
import { CliSessionPersistDroppedError } from '../persistSessionFromCli';

function makeLockManager(): SessionLockManager {
  const release = vi.fn(async () => undefined);
  const releaseSync = vi.fn(() => undefined);
  return {
    acquirePerSession: vi.fn(async () => ({ release })),
    acquireGlobalIndex: vi.fn(async () => ({ release })),
    acquirePerSessionSync: vi.fn(() => ({ release: releaseSync })),
    acquireGlobalIndexSync: vi.fn(() => ({ release: releaseSync })),
  } as unknown as SessionLockManager;
}

describe('runHeadlessTurn — dropped CLI session persist', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function configure(store: Partial<IncrementalSessionStore>): { onSessionsSaved: ReturnType<typeof vi.fn> } {
    const onSessionsSaved = vi.fn();
    configureCliSessionPersistence({
      getSessionStore: () => store as IncrementalSessionStore,
      lockManager: makeLockManager(),
      ownerKind: 'cli',
      onSessionsSaved,
    });
    // Stub executor: emit a minimal turn through the runner's registered
    // listener so the local accumulator has a snapshot to persist.
    configureHeadlessTurnExecutor((async (_win: unknown, turnId: string) => {
      const listener = agentTurnRegistry.getEventListener(turnId);
      listener?.({ type: 'turn_started', timestamp: 1_000 } as unknown as AgentEvent);
      listener?.({ type: 'result', text: 'done', timestamp: 1_100 } as unknown as AgentEvent);
    }) as never);
    return { onSessionsSaved };
  }

  it('throws CliSessionPersistDroppedError and never emits session_persisted when the store drops the write (tombstoned)', async () => {
    const sessionId = 'headless-tombstoned-session';
    const { onSessionsSaved } = configure({
      getSession: vi.fn(async () => null), // read chokepoint hides the tombstoned id
      upsertSessionsSyncWithReload: vi.fn(() => ({
        outcome: 'all-dropped-tombstoned' as const,
        droppedTombstonedSessionIds: [sessionId],
      })),
    } as unknown as Partial<IncrementalSessionStore>);

    const events: Array<{ type: string }> = [];
    await expect(
      runHeadlessTurn({
        prompt: 'persist me',
        onEvent: (event) => events.push(event as unknown as { type: string }),
        options: {
          sessionType: 'cli',
          persistMode: { kind: 'cli-session' },
          sessionId,
        },
      }),
    ).rejects.toThrow(CliSessionPersistDroppedError);

    expect(events.map((event) => event.type)).not.toContain('session_persisted');
    expect(onSessionsSaved).not.toHaveBeenCalled();
  });

  it('still emits session_persisted on a genuinely persisted write (healthy path unchanged)', async () => {
    const sessionId = 'headless-persisted-session';
    const persisted: AgentSession[] = [];
    configure({
      getSession: vi.fn(async () => null),
      upsertSessionsSyncWithReload: vi.fn((sessions: AgentSession[]) => {
        persisted.push(...sessions);
        return {
          outcome: 'persisted' as const,
          persistedSessionIds: sessions.map((session) => session.id),
          droppedTombstonedSessionIds: [],
        };
      }),
    } as unknown as Partial<IncrementalSessionStore>);

    const events: Array<{ type: string }> = [];
    await runHeadlessTurn({
      prompt: 'persist me',
      onEvent: (event) => events.push(event as unknown as { type: string }),
      options: {
        sessionType: 'cli',
        persistMode: { kind: 'cli-session' },
        sessionId,
      },
    });

    expect(persisted.map((session) => session.id)).toEqual([sessionId]);
    expect(events.map((event) => event.type)).toContain('session_persisted');
  });
});
