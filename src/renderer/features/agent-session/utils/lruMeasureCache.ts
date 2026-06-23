/**
 * Bounded LRU helper for the external measurement cache used by
 * `ConversationPane`'s TanStack Virtual `estimateSize`.
 *
 * We persist measured row heights across virtualizer recalculations AND across
 * session switches so that switch-back to a long thread has accurate estimates
 * immediately — letting `scrollToBottom`'s 25-RAF chase loop converge on the
 * actual bottom instead of landing mid-scroll (a known amplifier of the
 * "thread jumps to top on switch" bug; see
 * docs-private/investigations/260416_thread_scroll_jumps_to_top_on_switch.md).
 *
 * Message IDs are globally unique UUIDs so cross-session collisions cannot
 * happen. The only concern is unbounded growth over long-lived app sessions;
 * this LRU cap bounds memory while keeping the working set hot.
 *
 * Implementation notes:
 * - Exploits `Map`'s insertion-order iteration: re-setting a key that already
 *   exists is done via `delete` + `set` so the key moves to the tail (most
 *   recently used). When over the cap, the head (`keys().next()`) is the
 *   least recently used and is evicted.
 * - Mutates the passed-in cache in place (caller owns the lifetime; the
 *   helper is deliberately allocation-free on the hot measurement path).
 */
export function setMeasureCacheEntryLru(
  cache: Map<string, number>,
  id: string,
  size: number,
  maxEntries: number,
): void {
  if (cache.has(id)) {
    cache.delete(id);
  } else if (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(id, size);
}

// Shared across ConversationPane remounts so switching sessions can reset the
// virtualizer instance without throwing away known row heights.
const conversationMeasureCache = new Map<string, number>();

export function getConversationMeasureCache(): Map<string, number> {
  return conversationMeasureCache;
}

export function clearConversationMeasureCache(): void {
  conversationMeasureCache.clear();
}
