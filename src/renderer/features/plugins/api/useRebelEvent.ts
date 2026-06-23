/**
 * useRebelEvent — React hook for subscribing to plugin lifecycle events
 *
 * Wraps the pluginEventBus singleton with React lifecycle cleanup.
 * When the component (plugin) unmounts, the subscription is automatically
 * removed. Uses a callback ref to avoid stale closures.
 *
 * Usage in a plugin:
 * ```tsx
 * import { useRebelEvent } from '@rebel/plugin-api';
 *
 * function MyPlugin() {
 *   useRebelEvent('turn:completed', (payload) => {
 *     console.log('Turn completed:', payload);
 *   });
 *   return <div>...</div>;
 * }
 * ```
 *
 * @see src/renderer/features/plugins/api/pluginEventBus.ts — event bus singleton
 * @see src/renderer/features/plugins/api/types.ts — RebelEventType union
 */

import { useEffect, useRef } from 'react';
import { usePluginId } from './PluginContext';
import { pluginEventBus } from './pluginEventBus';
import type { RebelEventType } from './types';

type SubscriptionSlotPool = {
  nextSlot: number;
  freeSlots: number[];
};

const subscriptionSlotPools = new Map<string, SubscriptionSlotPool>();

function getSlotPoolKey(pluginId: string, eventType: RebelEventType): string {
  return `${pluginId}\u0000${eventType}`;
}

function acquireSubscriptionSlot(pluginId: string, eventType: RebelEventType): { cursorKey: string; release: () => void } {
  const poolKey = getSlotPoolKey(pluginId, eventType);
  let pool = subscriptionSlotPools.get(poolKey);
  if (!pool) {
    pool = { nextSlot: 0, freeSlots: [] };
    subscriptionSlotPools.set(poolKey, pool);
  }

  pool.freeSlots.sort((a, b) => a - b);
  const slot = pool.freeSlots.shift() ?? pool.nextSlot++;
  const cursorKey = `${poolKey}\u0000${slot}`;

  return {
    cursorKey,
    release: () => {
      const currentPool = subscriptionSlotPools.get(poolKey);
      if (!currentPool) return;
      currentPool.freeSlots.push(slot);
      if (currentPool.freeSlots.length >= currentPool.nextSlot) {
        subscriptionSlotPools.delete(poolKey);
      }
    },
  };
}

export function useRebelEvent(
  eventType: RebelEventType,
  callback: (payload: unknown) => void,
): void {
  const pluginId = usePluginId();
  // Ref keeps the latest callback without re-subscribing on every render
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const handler = (payload: unknown) => callbackRef.current(payload);
    const subscriptionSlot = acquireSubscriptionSlot(pluginId, eventType);
    const unsubscribe = pluginEventBus.subscribeWithReplay(subscriptionSlot.cursorKey, eventType, handler);
    return () => {
      unsubscribe();
      subscriptionSlot.release();
    };
  }, [eventType, pluginId]);
}
