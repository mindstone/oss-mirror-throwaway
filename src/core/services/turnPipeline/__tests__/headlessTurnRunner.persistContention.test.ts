/**
 * 260618 CLI cross-process contention: a lock-acquire timeout during CLI
 * session persistence is retryable session-store contention, not a successful
 * persist and not optimistic external modification.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import type { IncrementalSessionStore } from '@core/services/incrementalSessionStore';
import type { SessionLockManager } from '@core/utils/sessionFileLock';
import { LockAcquireTimeout } from '@core/utils/sessionFileLock';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  configureCliSessionPersistence,
  configureHeadlessTurnExecutor,
  runHeadlessTurn,
} from '../headlessTurnRunner';
import { CliSessionContentionError } from '../persistSessionFromCli';

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

describe('runHeadlessTurn — contended CLI session persist', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function configure(args: {
    lockManager?: SessionLockManager;
    store?: Partial<IncrementalSessionStore>;
  } = {}): { onSessionsSaved: ReturnType<typeof vi.fn> } {
    const onSessionsSaved = vi.fn();
    configureCliSessionPersistence({
      getSessionStore: () => (args.store ?? {
        getSession: vi.fn(async () => null),
        upsertSessionsSyncWithReload: vi.fn((sessions: AgentSession[]) => ({
          outcome: 'persisted' as const,
          persistedSessionIds: sessions.map((session) => session.id),
          droppedTombstonedSessionIds: [],
        })),
      }) as IncrementalSessionStore,
      lockManager: args.lockManager ?? makeLockManager(),
      ownerKind: 'cli',
      onSessionsSaved,
    });
    configureHeadlessTurnExecutor((async (_win: unknown, turnId: string) => {
      const listener = agentTurnRegistry.getEventListener(turnId);
      listener?.({ type: 'turn_started', timestamp: 1_000 } as unknown as AgentEvent);
      listener?.({ type: 'result', text: 'done', timestamp: 1_100 } as unknown as AgentEvent);
    }) as never);
    return { onSessionsSaved };
  }

  it('throws CliSessionContentionError and never emits session_persisted when the CLI persist lock times out', async () => {
    const sessionId = 'headless-contended-session';
    const lockManager = makeLockManager();
    vi.mocked(lockManager.acquirePerSession).mockRejectedValueOnce(new LockAcquireTimeout({
      lockPath: 'session.lock',
      existingPid: 1234,
      ageMs: 5010,
    }));
    const { onSessionsSaved } = configure({ lockManager });

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
    ).rejects.toBeInstanceOf(CliSessionContentionError);

    expect(events.map((event) => event.type)).not.toContain('session_persisted');
    expect(onSessionsSaved).not.toHaveBeenCalled();
  });

  it('still emits session_persisted on a genuinely persisted write (healthy path unchanged)', async () => {
    const sessionId = 'headless-contention-healthy-session';
    const persisted: AgentSession[] = [];
    configure({
      store: {
        getSession: vi.fn(async () => null),
        upsertSessionsSyncWithReload: vi.fn((sessions: AgentSession[]) => {
          persisted.push(...sessions);
          return {
            outcome: 'persisted' as const,
            persistedSessionIds: sessions.map((session) => session.id),
            droppedTombstonedSessionIds: [],
          };
        }),
      } as unknown as Partial<IncrementalSessionStore>,
    });

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
