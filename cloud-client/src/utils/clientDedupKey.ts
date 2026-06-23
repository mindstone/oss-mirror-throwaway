/**
 * Client-side UUID generator for Stage C IPC dedup keys.
 *
 * Stage C of `docs/plans/260417_approval_consolidation_closeout.md` attaches
 * a per-action UUID to the 4 staging IPCs so the server-side dedup cache
 * can replay the original response when `fetchWithRetry` re-dispatches a
 * lost-response POST. The UUID is generated ONCE per user-triggered action
 * (outside any retry loop) so all retries share the same key; the server
 * keys its cache by this value plus the channel name.
 *
 * Environment support:
 *   - Modern browsers (desktop renderer via Electron Chromium) expose
 *     `globalThis.crypto.randomUUID()`.
 *   - React Native 0.76+ with Hermes ships a `globalThis.crypto.randomUUID`
 *     polyfill as part of its URL/crypto JSI bindings.
 *   - Older runtimes that lack `randomUUID` but have `getRandomValues` get
 *     a v4 UUID built from 16 random bytes. This path is rare in practice
 *     but keeps the helper resilient against future React Native runtime
 *     shuffling.
 *   - As an absolute last resort we fall back to `Math.random`. This is
 *     fine for dedup keys (we only need uniqueness within 30 seconds per
 *     process) but the cryptographic branches are strongly preferred.
 *
 * The output is always a 36-char v4 UUID string that matches the Zod
 * `z.string().uuid()` schema attached to `clientDedupKey` in
 * `src/shared/ipc/channels/memory.ts`.
 */

type MaybeCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

function getCrypto(): MaybeCrypto | undefined {
  // `globalThis.crypto` is the modern spec on both browsers and Node 18+
  // (and React Native 0.76+ with Hermes). Guarded so the module doesn't
  // throw when evaluated in a context without `crypto` bound at all.
  if (typeof globalThis !== 'undefined') {
    const maybe = (globalThis as { crypto?: MaybeCrypto }).crypto;
    if (maybe && typeof maybe === 'object') return maybe;
  }
  return undefined;
}

function randomBytesFallback(out: Uint8Array): Uint8Array {
  const crypto = getCrypto();
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(out);
    return out;
  }
  // Non-cryptographic fallback — acceptable because dedup keys don't need
  // to be unguessable, only unique within the TTL. The server still
  // validates the UUID shape via `z.string().uuid()`.
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function buildUuidV4FromBytes(bytes: Uint8Array): string {
  // RFC 4122 §4.4 — set version (4) and variant (10x) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return (
    `${hex.slice(0, 8)}-` +
    `${hex.slice(8, 12)}-` +
    `${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-` +
    `${hex.slice(20, 32)}`
  );
}

/**
 * Generate a v4 UUID suitable for Stage C's `clientDedupKey`.
 *
 * Call this ONCE per user-triggered action — not inside the retry loop —
 * so all retries of the same action share the same key and the server
 * can dedup them. A new UUID for each retry defeats the whole purpose.
 */
export function newClientDedupKey(): string {
  const crypto = getCrypto();
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return buildUuidV4FromBytes(randomBytesFallback(new Uint8Array(16)));
}
