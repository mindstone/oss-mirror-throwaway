/**
 * Faithful in-process IPC transport for the contract round-trip harness.
 *
 * ## Why this exists
 * Electron's main↔renderer `invoke`/`sendSync` IPC serialises every payload with
 * V8's **Structured Clone Algorithm (SCA)**. A test harness that simulates that
 * boundary must use the *same* serialisation, or it produces false confidence:
 *
 * - A naive `JSON.parse(JSON.stringify(x))` transport **silently accepts** payloads
 *   that real Electron IPC **rejects** (e.g. an object carrying a function property —
 *   the function is silently stripped) and **corrupts** values Electron preserves
 *   (`Date` → string, `Map`/`Set` → `{}`/lost, an `undefined`-valued key dropped,
 *   `bigint` → thrown TypeError). That divergence is exactly the false-green this
 *   harness exists to eliminate.
 *
 * ## The transport
 * `globalThis.structuredClone` **is** V8's SCA — the very same family Electron IPC
 * uses (verified empirically against Electron's accept/reject behaviour in the
 * Stage-1 transport-fidelity research probe). So the faithful transport is a single
 * call to `structuredClone`, with the canonical `DataCloneError` surfaced verbatim
 * on rejected values (functions anywhere, symbols, Promises, …).
 *
 * ## Deliberate non-goals (documented gaps, additive — not modelled here)
 * - **Payload-size ceiling / native-handle limits.** Electron's cross-process IPC
 *   has an oversize guard (`src/main/ipc/utils/ipcPayloadGuard.ts`) and cannot
 *   transfer host/native-backed objects (`MessagePort`, `BrowserWindow`). These are
 *   additive size/handle contracts, orthogonal to *shape* drift. `ipcPayloadGuard`
 *   is intentionally **NOT** wired here (deferred); it could be layered on later if
 *   size-contract coverage is wanted.
 *
 * Node ≥17 ships `structuredClone` as a global; this repo runs Node 24.
 */

/**
 * Round-trip a value through the faithful in-process IPC transport.
 *
 * Mirrors what a value experiences crossing Electron's main↔renderer boundary:
 * structurally cloned via V8 SCA. Throws the canonical {@link DataCloneError}
 * (a `DOMException` with `name === 'DataCloneError'`) on any value Electron IPC
 * would reject (functions, symbols, Promises, …); preserves `Date`/`Map`/`Set`/
 * `bigint`/`undefined`-valued keys that a JSON transport would corrupt.
 *
 * @typeParam T - the value's type (the clone has the same shape, hence same type).
 * @param value - the payload to transport.
 * @returns a structurally-cloned copy of `value`.
 * @throws DataCloneError if `value` (or a nested value) is not structured-cloneable.
 */
export function transport<T>(value: T): T {
  return globalThis.structuredClone(value);
}

/**
 * Type guard for the canonical Structured-Clone-Algorithm rejection.
 *
 * V8/Electron surface clone failures as a `DOMException` whose `name` is
 * `'DataCloneError'`. Tests assert against this rather than a bare `Error` so the
 * harness fails loudly if the runtime's clone behaviour ever stops matching the
 * Electron-equivalent contract.
 */
export function isDataCloneError(err: unknown): boolean {
  return err instanceof Error && err.name === 'DataCloneError';
}
