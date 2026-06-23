/**
 * Shared network-class error classifier (260618_arthur-offline-resilience, Stage 1).
 *
 * Single source of truth for "was this failure caused by the network being
 * unreachable?" — i.e. a transient connectivity blip (DNS failure, timeout,
 * connection refused/reset, offline) that usually self-heals, as opposed to an
 * auth/permission error (401/403) or a programming bug.
 *
 * WHY a shared util: the same code/message set was previously hard-coded inside
 * `classifySyncErrorCause` (`@shared/ipc/channels/calendar.ts`). The
 * auth-heartbeat log-storm hygiene (`authService.ts`) needs the identical
 * predicate to decide when to downgrade a per-tick offline ERROR to a debounced
 * DEBUG. Duplicating the code set risks the two drifting apart, so both now
 * import from here. (Other older copies exist in `apiKeyValidation.ts` and
 * `audioService.ts`; consolidating those is out of scope for Stage 1 — see the
 * Stage 1 implementer report.)
 *
 * The walk-the-cause-chain shape is required because undici surfaces network
 * failures as `TypeError: fetch failed` with the real errno nested in `.cause`.
 */

/** Node/undici error codes that mean a host was unreachable / the network failed. */
export const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Message substrings that betray a network failure even when no structured
 * `code` is present (e.g. undici's bare `TypeError: fetch failed`). Kept
 * deliberately broad — false positives only soften an error toward "transient
 * blip", and callers gate on additional context (e.g. a cached token still
 * being present) before acting on the verdict.
 */
export const NETWORK_MESSAGE_RE =
  /fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|socket hang up|network|dns/i;

/**
 * Walk an error's `cause` chain (with cycle protection), applying `visit` to
 * each link. Returns the first truthy result, or `false` if none matches.
 * Shared by `matchesNetworkCodeOrMessage` and `isNetworkClassError` so both
 * traverse identically (undici nests the real errno under `.cause`).
 */
function someInCauseChain(error: unknown, visit: (link: object) => boolean): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (visit(current as object)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * True when the error (or any link in its cause chain) carries a known network
 * errno or a network-shaped message. Does NOT treat a bare `AbortError` as
 * network on its own — use `isNetworkClassError` for that. This is the exact
 * code+message predicate `classifySyncErrorCause` relies on (behavior-preserving
 * extraction).
 */
export function matchesNetworkCodeOrMessage(error: unknown): boolean {
  return someInCauseChain(error, (link) => {
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
    const message = (link as { message?: unknown }).message;
    return typeof message === 'string' && NETWORK_MESSAGE_RE.test(message);
  });
}

/**
 * True when `error` (or any error in its `cause` chain) looks like a
 * network-class failure: a known network errno, a network-shaped message, OR an
 * `AbortError` (a timed-out / cancelled request — undici/fetch surface offline
 * timeouts this way). Walks the `cause` chain with cycle protection.
 *
 * Conservative by design: returns `false` when unsure, so a genuine
 * auth/permission failure is never mistaken for "just offline".
 */
export function isNetworkClassError(error: unknown): boolean {
  return someInCauseChain(error, (link) => {
    // AbortError: a request aborted by our own timeout firing while offline /
    // on a stalled connection. DOMException and Error both set `.name`, so a
    // name check covers both the fetch and AbortController abort paths.
    if ((link as { name?: unknown }).name === 'AbortError') return true;
    const code = (link as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
    const message = (link as { message?: unknown }).message;
    return typeof message === 'string' && NETWORK_MESSAGE_RE.test(message);
  });
}
