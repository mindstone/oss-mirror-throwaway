import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import type { SessionTombstoneStore } from '@core/services/continuity/sessionTombstoneStore';

interface CleanupLeakedSessionsBridgeDeps {
  tombstoneStore: Pick<SessionTombstoneStore, 'addTombstone'>;
  now?: () => number;
  broadcast?: (channel: string, payload: unknown) => void;
}

/**
 * Bridge callback for cloud startup leaked-session cleanup.
 * For every deleted leaked session, emit the same tombstone + broadcasts as
 * the DELETE /api/sessions route so all clients converge via normal sync paths.
 */
export function createCleanupLeakedSessionDeletedCallback(
  deps: CleanupLeakedSessionsBridgeDeps,
): (sessionId: string) => void {
  const now = deps.now ?? Date.now;
  const broadcast = deps.broadcast ?? ((channel: string, payload: unknown) => {
    // dynamic-broadcast-reviewed: default broadcast sink for this bridge — the only channels passed to
    // it are the literals below (`cloud:session-changed`, `cloud:session-tombstoned`), both declared in
    // cloudEventChannel. This forwarder adds no channel of its own.
    cloudEventBroadcaster.broadcast(channel, payload);
  });

  return (sessionId: string) => {
    const tombstone = deps.tombstoneStore.addTombstone(sessionId, 'cloud', now());
    broadcast('cloud:session-changed', { sessionId, action: 'deleted' });
    broadcast('cloud:session-tombstoned', tombstone);
  };
}
