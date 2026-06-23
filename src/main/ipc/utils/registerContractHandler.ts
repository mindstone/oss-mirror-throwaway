/**
 * Stage-2 spine: the dev/test-gated IPC contract-parse seam decorator.
 *
 * ## What this is
 * Rebel registers every (non-bypass) IPC handler through the single chokepoint
 * `src/main/ipc/utils/registerHandler.ts`. This module supplies the wrap applied
 * at that chokepoint so that — *only* under dev/test — every contract-bearing
 * channel runs `channelDef.request.parse(args[0])` BEFORE its real body and
 * `channelDef.response.parse(result)` AFTER it. That moves the request/response
 * contract from "asserted per-handler if someone remembers" up to
 * "enforced at the runtime seam, by construction of the chokepoint" — for all
 * covered channels at once — in CI.
 *
 * ## Fail-safe-OFF gating (load-bearing safety property)
 * The wrap is a **no-op passthrough** unless enforcement is explicitly on
 * ({@link isContractEnforcementOn}). The default / unset / unknown-env case is
 * the no-op path, so production behaviour is byte-for-byte unchanged. An
 * accidental prod-enforce would be a user-visible regression (Zod default-strips
 * unknown keys; `.refine`/`.min` may reject real payloads), so the gate is
 * deliberately conservative and is explicitly tested.
 *
 * ## CRITICAL scope (round-2 DA-F2 / impl-F1)
 * This global decorator is **parse-only around the REAL body** — it NEVER skips
 * or stubs the handler body. The gate keys on `NODE_ENV==='test'`, and a
 * body-skip there would silently mask/break the ~35k other tests that rely on
 * real handler behaviour. The side-effecting-channel body-skip belongs to the
 * harness DRIVER (Stage 5), behind its own `REBEL_CONTRACT_HARNESS_PARSE_ONLY`
 * flag — NOT here. So in plain `NODE_ENV==='test'` a non-{@link EXECUTE_SAFE}
 * channel still runs its real body. {@link EXECUTE_SAFE} is declared here only
 * for Stage 5 to consume; this module does NOT act on it.
 */

import { allChannels, type IpcChannelName } from '@shared/ipc/contracts';

// Relocated to @shared so the @core broadcast sink-seam + cloud-ingress parse
// share ONE SSOT gate with this invoke seam (the fail-safe-OFF property can't
// drift between the three parse points). Imported for local use AND re-exported
// so existing importers + registerContractHandler.test.ts are untouched.
import { isContractEnforcementOn } from '@shared/ipc/contractEnforcement';
export { isContractEnforcementOn };

/**
 * A handler as seen at the registration chokepoint: the Electron-typed
 * `(event, ...args) => …`. The contract payload is `args[0]` (verified: every
 * `registerHandler('x', (_event, payload) => …)` site, and the existing
 * round-trip test's `handler(null, rawRequest)` — single-arg-after-event holds
 * for object, union, and scalar request schemas alike).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors registerHandler's ElectronIpcHandler boundary type; the cast is absorbed at this seam
export type SeamHandler = (event: any, ...args: any[]) => Promise<unknown> | unknown;

/**
 * SAFE-BY-CONSTRUCTION allowlist (Stage-5 review F1). The Stage-5 harness DRIVER
 * (NOT this decorator) invokes a channel's REAL body **only** if the channel is
 * in this set; every other channel is parse-only/stubbed (sample-and-parse, the
 * registry/real-handler is never hit). Declared here so Stage 5 + Stage 6 import
 * a single SSOT; **this stage does not act on it**.
 *
 * ## Why an allowlist, not a denylist
 * The prior `EXECUTE_UNSAFE` denylist was unsafe by construction: any
 * side-effecting channel NOT enumerated (a typo, a stale rename, or a brand-new
 * channel) had its REAL body executed when the harness iterates every registered
 * channel — real fs writes / store mutations / network during the test run. An
 * allowlist inverts the default to STUB (safe): under-listing only under-covers,
 * it never causes a side effect. New/renamed channels are stubbed until someone
 * deliberately reviews their handler and opts them in here.
 *
 * ## Inclusion criterion (read the handler before adding)
 * A channel belongs here ONLY if its real handler, invoked with a min-valid
 * sampled request under the harness's minimal ambient boot, is **read-only /
 * side-effect-free**: no fs writes, no network/BTS calls, no store mutations, no
 * process spawns. When unsure, leave it OUT (stubbed) — under-executing is safe.
 * The set is typed + runtime-validated against `allChannels` (a stale/typo key
 * fails the Stage-5 test), the same discipline as the Stage-4 `requestOverrides`.
 */
export const EXECUTE_SAFE = [
  // inbox:load → getInboxState() — pure read of the in-memory/disk inbox state.
  'inbox:load',
  // feedback:conversation-get → getConversationFeedback() — pure store read
  // (loadInternal + filter/sort); no writes, no reporter/network call.
  'feedback:conversation-get',
  // library:stat-file → fs.stat under the configured coreDirectory — read-only
  // filesystem stat; no writes, no service imports invoked at body time.
  'library:stat-file',
] as const satisfies readonly IpcChannelName[];

/** Membership test for the safe-to-execute allowlist (string-keyed view). */
const EXECUTE_SAFE_SET: ReadonlySet<string> = new Set<string>(EXECUTE_SAFE);

/** Is this channel on the safe-by-construction execute allowlist? */
export function isExecuteSafe(channel: string): boolean {
  return EXECUTE_SAFE_SET.has(channel);
}

/**
 * Wrap a handler with the dev/test-gated contract-parse seam.
 *
 * - **Enforcement off** (production default / unset / unknown env): returns the
 *   handler **unchanged** (same reference) — a true no-op passthrough, so the
 *   prod path is byte-for-byte unaffected.
 * - **Channel absent from `allChannels`** (sync `ipcMain.on` channels, the
 *   `RAW_IPC_BYPASS_CHANNELS`/e2e/perf set): returns the handler **unwrapped**
 *   (same reference), never throws — there is no contract to enforce.
 * - **Enforcement on + channel known**: returns a wrapper that runs
 *   `channelDef.request.parse(args[0])` BEFORE delegating to the real handler and
 *   `channelDef.response.parse(result)` AFTER. The real body ALWAYS runs (no
 *   body-skip here — see module docstring).
 *
 * The enforce-vs-passthrough decision is made **at wrap time** (i.e. at
 * `registerHandler` time): production registers handlers once at boot under a
 * fixed env, so a registration-time gate gives the strongest no-op guarantee —
 * the prod registry stores the *original handler reference*, with zero wrapper
 * on the hot path.
 */
export function wrapHandlerWithContractParse(
  channel: string,
  handler: SeamHandler,
): SeamHandler {
  // Fail-safe-off: in production (default / unset / unknown env) return the
  // handler unchanged — no wrapper, no per-invocation cost, identical reference.
  if (!isContractEnforcementOn()) {
    return handler;
  }

  const channelDef = (allChannels as Record<string, { request: { parse: (v: unknown) => unknown }; response: { parse: (v: unknown) => unknown } }>)[channel];

  // No contract for this channel (sync / bypass / e2e) → never wrap.
  if (!channelDef) {
    return handler;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- preserve the variadic boundary signature
  return async (event: any, ...args: any[]): Promise<unknown> => {
    // Parse the request crossing the seam BEFORE the body. Throws ZodError on a
    // malformed/drifted input (banner claim (a)).
    channelDef.request.parse(args[0]);
    // Always run the REAL body — never skipped here (round-2 DA-F2 / impl-F1).
    const result = await handler(event, ...args);
    // Parse the response AFTER the body. Throws ZodError on a contract-violating
    // response (banner claim (b)).
    channelDef.response.parse(result);
    return result;
  };
}
