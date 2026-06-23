/**
 * Plugin Lifecycle Manager
 *
 * Tracks intervals, timeouts, and subscriptions created by a plugin
 * and cleans them all up when the plugin unmounts.
 */

import type { PluginLifecycle } from './types';

export interface LifecycleCleanup {
  cleanup(): void;
}

export function createLifecycleManager(): PluginLifecycle & LifecycleCleanup {
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const subscriptions: (() => void)[] = [];

  const removeTimeout = (timeoutId: ReturnType<typeof setTimeout>) => {
    const index = timeouts.indexOf(timeoutId);
    if (index !== -1) {
      timeouts.splice(index, 1);
    }
  };

  return {
    registerInterval(callback: () => void, ms: number) {
      intervals.push(setInterval(callback, ms));
    },
    registerTimeout(callback: () => void, ms: number) {
      const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
        removeTimeout(timeoutId);
        callback();
      }, ms);
      timeouts.push(timeoutId);
    },
    registerSubscription(unsubscribe: () => void) {
      subscriptions.push(unsubscribe);
    },
    cleanup() {
      for (const id of intervals) clearInterval(id);
      for (const id of timeouts) clearTimeout(id);
      for (const unsub of subscriptions) {
        try { unsub(); } catch { /* best-effort */ }
      }
      intervals.length = 0;
      timeouts.length = 0;
      subscriptions.length = 0;
    },
  };
}
