/**
 * Safety-prompt event emitter — typed fan-out for `safety-prompt:updated`
 * push events.
 *
 * Added by Stage 0 of
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`. `EventBridge`
 * forwards `safety-prompt:updated` messages from the WebSocket push channel
 * to this emitter. The mobile `ApprovalTransport` adapter subscribes via
 * `onUpdated`. Events are ephemeral (no persistence) and global across the
 * authenticated session.
 */

import type { SafetyPromptUpdatedEvent } from '../transport/approvalTransport';

export interface SafetyPromptEventMap {
  'safety-prompt:updated': SafetyPromptUpdatedEvent;
}

type EventKey = keyof SafetyPromptEventMap;
type EventHandler<K extends EventKey> = (event: SafetyPromptEventMap[K]) => void;
type AnyEventHandler = (event: SafetyPromptEventMap[EventKey]) => void;

class SafetyPromptEventEmitter {
  private listeners = new Map<EventKey, Set<AnyEventHandler>>();

  /**
   * F-R3-6: Version-based dedup. Desktop in cloud mode can receive the same
   * safety-prompt:updated event twice — once from the local main-process
   * broadcast and once echoed back from cloud push via EventBridge. Track the
   * last-emitted version to suppress duplicates and stale out-of-order events.
   */
  private lastEmittedVersion = -1;

  on<K extends EventKey>(event: K, handler: EventHandler<K>): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler as AnyEventHandler);

    return () => {
      handlers!.delete(handler as AnyEventHandler);
      if (handlers!.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  emit<K extends EventKey>(event: K, payload: SafetyPromptEventMap[K]): void {
    // F-R3-6: Version-based dedup — skip duplicate or stale events.
    const version = (payload as SafetyPromptUpdatedEvent).version;
    if (typeof version === 'number') {
      if (version <= this.lastEmittedVersion) {
        console.debug('[safetyPromptEventEmitter] dedup-skip: version', version, '≤ last', this.lastEmittedVersion);
        return;
      }
      this.lastEmittedVersion = version;
    }

    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        // Log but don't block remaining listeners (F-R2-10).
        console.error('[safetyPromptEventEmitter] listener threw:', err);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  /** Reset dedup state — primarily for tests. */
  reset(): void {
    this.listeners.clear();
    this.lastEmittedVersion = -1;
  }
}

/** Singleton emitter — shared between EventBridge and any `ApprovalTransport` adapter. */
export const safetyPromptEventEmitter = new SafetyPromptEventEmitter();
