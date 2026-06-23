/**
 * Broadcast sink-seam: the dev/test-gated contract-parse decorator for the
 * one-way `BroadcastService.sendToAllWindows` chokepoint.
 *
 * ## What this is
 * Every schema-backed broadcast funnels through `getBroadcastService()
 * .sendToAllWindows`. This wrap is applied at `setBroadcastService` (the single
 * production-path injection point) so that — *only* under dev/test — every
 * emit on a channel in `BROADCAST_SCHEMAS` runs `schema.parse(args[0])` BEFORE
 * forwarding to the real service. That moves the producer→renderer payload
 * contract from "typed only if the emitter went through `broadcastTypedPayload`"
 * up to "enforced at the runtime sink by construction".
 *
 * ## Honest scope — a future-emitter guard, NOT suite-wide
 * ~57 test files `vi.mock('@core/broadcastService')` and so never hit the real
 * setter; only ~3 integration tests call the real `setBroadcastService`. This
 * seam therefore fires for those few + dev — it is a guard against a *future*
 * local emitter that bypasses `broadcastTypedPayload`'s compile-time typing
 * (exactly how the 260405 bug was introduced). The 260405-class cloud-replay
 * surface is covered separately by the cloud-ingress parse in
 * `cloudEventChannel.ts` (the sink is `vi.mock`ed in `cloudEventChannel.test.ts`).
 *
 * ## Fail-safe-OFF / zero per-emit cost
 * When `!isContractEnforcementOn()` the wrap returns the **same service
 * reference unchanged** — packaged prod stores the original, with no wrapper on
 * the hot path. (Note: zero *per-emit* cost, not zero prod cost — the static
 * `BROADCAST_SCHEMAS` import still loads Zod.) Decide-at-wrap-time mirrors the
 * invoke seam's `wrapHandlerWithContractParse`.
 *
 * ## Validation-only — forwards the ORIGINAL args
 * The parsed (Zod) output is NEVER forwarded — Zod default-strips unknown keys,
 * so forwarding it could silently drop fields the renderer relies on. The
 * original `args` are forwarded byte-identical; the parse is purely a throw-on-
 * drift assertion.
 */

import { isContractEnforcementOn } from '@shared/ipc/contractEnforcement';
import { BROADCAST_SCHEMAS } from '@shared/ipc/broadcasts';

/**
 * Structural shape of `BroadcastService`, declared LOCALLY rather than imported
 * from `./broadcastService`. WHY: `broadcastService.ts` imports this module's
 * wrap fn at injection time, so a type-import back to `./broadcastService` here
 * forms a circular edge that the `validate:circular-deps` (Madge) gate counts
 * even for type-only imports. A local structural type keeps the import graph a
 * one-way edge (broadcastService → broadcastContractSeam) while staying
 * assignment-compatible with `BroadcastService` (structurally identical).
 */
type BroadcastSink = {
  sendToAllWindows(channel: string, ...args: unknown[]): void;
  sendToFocusedWindow(channel: string, ...args: unknown[]): void;
};

/**
 * Wrap a `BroadcastService` with the dev/test-gated broadcast contract-parse
 * seam.
 *
 * - **Enforcement off** (production default / unset / unknown env): returns the
 *   service **unchanged** (same reference) — a true no-op passthrough.
 * - **Enforcement on**: returns a service whose `sendToAllWindows(channel,
 *   ...args)` parses the payload against `BROADCAST_SCHEMAS[channel]` BEFORE
 *   delegating. Schema-backed channels with `args.length !== 1` throw (every
 *   schema-backed channel emits exactly one payload arg — a 2nd arg is drift).
 *   Non-schema channels pass through untouched. `sendToFocusedWindow` is passed
 *   through unchanged (no schema-backed channel uses it — YAGNI).
 */
export function wrapBroadcastWithContractParse(service: BroadcastSink): BroadcastSink {
  // Fail-safe-off: same reference, no wrapper, zero per-emit cost in prod.
  if (!isContractEnforcementOn()) {
    return service;
  }

  return {
    sendToAllWindows(channel: string, ...args: unknown[]): void {
      const schema = BROADCAST_SCHEMAS[channel as keyof typeof BROADCAST_SCHEMAS];
      if (schema) {
        if (args.length !== 1) {
          throw new Error(
            `Broadcast contract violation: channel '${channel}' is schema-backed and must emit exactly one payload arg, got ${args.length}.`,
          );
        }
        // Validation only — throws ZodError on drift. We forward the ORIGINAL
        // args below, never Zod's (key-stripped) parsed output.
        schema.parse(args[0]);
      }
      // Non-schema channels (and validated schema channels) forward unchanged.
      // dynamic-broadcast-reviewed: the broadcast-contract validation wrapper — it forwards the
      // caller's `channel` (declared at its own emit-site) after Zod-validating schema-backed
      // payloads; it introduces no channel of its own.
      return service.sendToAllWindows(channel, ...args);
    },
    // YAGNI: no schema-backed channel emits via sendToFocusedWindow — pass through.
    sendToFocusedWindow(channel: string, ...args: unknown[]): void {
      return service.sendToFocusedWindow(channel, ...args);
    },
  };
}
