# Broadcast / event-channel contract harness

> **Honest scope, by design.** This is the broadcast/event-channel sibling of the
> invoke round-trip harness (`src/main/ipc/__tests__/harness/README.md`). Like that
> one it is built to *not* ship a meta-false-green. The headline below is **CI/dev
> regression guard, NOT prod protection** — read "what it verifies" and "what it
> does NOT" together.

Canonical plan: [`docs/plans/260609_ipc-broadcast-contract-harness/PLAN.md`](../../../../../docs/plans/260609_ipc-broadcast-contract-harness/PLAN.md)
(two-seam design; see the `## Stages` arbitration note).

## Why this exists

Rebel's invoke harness closed request/response contract drift for `ipcRenderer.invoke`
round-trip channels. But IPC also has **one-way broadcast/event channels**
(`src/shared/ipc/broadcasts.ts` → `BROADCAST_SCHEMAS`, 10 channels), which the invoke
seam does NOT touch. Critically, the motivating postmortem
`260405_memory_approval_ipc_crash` **actually fired on the broadcast/event path**: a
FLAT persisted memory-approval payload (top-level `filePath`/`spaceName`, no nested
`destination`) was dispatched on `memory:write-approval-request`, and the renderer
consumer (`usePendingApprovals.ts`) crashed dereferencing `request.destination.path`.
The invoke harness covers only the *invoke analog* of that bug; this harness covers the
real broadcast variant.

## The two-seam design (division of labour)

There is NO test-suite-wide chokepoint for broadcasts (unlike `registerHandler` for
invoke): ~57 test files `vi.mock('@core/broadcastService')` and never hit the real
setter; only ~3 integration tests call the real `setBroadcastService`. So coverage is
deliberately split across **two** dev/test-gated parse points, both behind the single
SSOT gate [`isContractEnforcementOn()`](../../../../shared/ipc/contractEnforcement.ts)
(shared with the invoke seam — the fail-safe-OFF property can't drift between them):

1. **Sink-seam — a future-emitter guard.** `wrapBroadcastWithContractParse`
   ([`src/core/broadcastContractSeam.ts`](../../../../core/broadcastContractSeam.ts))
   is applied inside `setBroadcastService` (the single production-path injection
   point). Under dev/test it `schema.parse`es every schema-backed emit before
   forwarding. It is **NOT suite-wide** — it fires for the ~3 real-setter integration
   tests + dev + the packaged-desktop path. Its value is guarding against a *future*
   local emitter that bypasses `broadcastTypedPayload`'s compile-time typing (exactly
   how 260405 was introduced).

2. **Cloud-ingress parse — the 260405-class kill.** A gated `BROADCAST_SCHEMAS[channel]
   ?.parse(args[0])` at `cloudEventChannel.dispatchToRenderer`
   ([`src/main/services/cloud/cloudEventChannel.ts`](../cloudEventChannel.ts), ~`:649`),
   the single point where `as`-cast HTTP/WS JSON enters the broadcast bus. This is what
   actually fires on the 260405 surface in `cloudEventChannel.test.ts` (which
   `vi.mock`s the sink, so the sink-seam never runs there). The parse sits downstream
   of `normalizeMemoryApproval`; the catch-up route launders flat→nested first, but the
   direct WS-push path reaches the parse with the genuine flat shape.

Both seams forward the **ORIGINAL** args byte-identical — the parse is validation-only,
never Zod's key-stripped output. Schema-backed channels with `args.length !== 1` throw
(every schema-backed channel emits exactly one payload arg per census; a 2nd arg is
drift). Non-schema channels pass through untouched.

## What it ACTUALLY verifies

- **Cloud-ingress parse (`cloudEventChannel.contractParse.test.ts`):** drifted
  schema-backed cloud push → `ZodError` in test/dev; valid → forwarded; wrong arg-count
  → throws; gate-OFF → straight passthrough.
- **Sink-seam unit tests (`broadcastContractSeam` tests):** gate-OFF → same reference /
  drift sails through; gate-ON + drift → ZodError; non-schema channel → passthrough;
  valid payload with an unknown extra field → forwarded byte-identical (not Zod-
  stripped); 2 args → throws.
- **260405 regression anchor (`broadcastContractDriftRegression.test.ts`):** the genuine
  flat `PersistedMemoryApprovalRequest` payload driven through the REAL cloud-ingress
  seam on the REAL channel + schema throws `ZodError` naming `destination`; valid nested
  → forwarded clean; **SEAM-OFF proof** (NODE_ENV=production → flat payload sails through,
  proving the test depends on the seam, not a bare Zod call); **`destination`-required
  mutation-to-red guard** (a future `.optional()` loosening turns it red — the schema
  keeps the flat legacy fields optional, so `destination` being required is the sole
  load-bearing protection).
- **Coverage guard (`broadcastCoverageGuard.test.ts`):** every `BROADCAST_SCHEMAS` key
  round-trips `sampleSchema → transport (structuredClone) → schema.parse`; a schema
  added is auto-covered, one removed fails loud. Plus a cheap **no-raw-send literal
  test**: zero raw `webContents.send('<channel>', …)` in `src/**` for any of the 10
  channel literals — locking in that all schema-backed emits route through the typed
  sink (where the sink-seam parses).
- `memory:staged-files-changed` is **payloadless** and deliberately NOT in
  `BROADCAST_SCHEMAS` (`broadcasts.ts:33`) — documented exemption, not a flag.

## Production enforcement is OFF — blunt statement

**Both seams are OFF in production by construction.** Deployed cloud runs
`NODE_ENV=production` (`cloud-service/Dockerfile`, `fly.toml`) and packaged desktop
leaves `NODE_ENV` unset; `isContractEnforcementOn()` requires a POSITIVE `test`/
`development` signal, so it is false in both. **In prod, users on the 260405 path are
protected only by `normalizeMemoryApproval` + the `ff8813a78` consumer fallbacks — NOT
by this harness.** This is a CI/dev regression guard, not a would-have-caught (the
strict schema postdates the fix).

## Deferred follow-ups (named, out of scope)

- **Consumer chokepoint.** Renderer `ipcRenderer.on` subscriptions are scattered
  (`src/preload/index.ts`); there is no runtime parse on receive. The producer seam
  protects consumers transitively. A `subscribeBroadcast(channel, cb)` chokepoint is a
  net-new scattered→chokepoint refactor — deferred.
- **The un-schema'd channels.** ~25 unschematized `sendToAllWindows` channels (incl.
  the approval-adjacent siblings `app-bridge:pending-approval-updated` and
  `conversations:send-requested`) + the raw-`webContents.send` family
  (menu/meeting-bot/voice/super-mcp/`agent:event`) pass through untouched. Covering them
  means authoring schemas — curated-subset scope, not a defect.
- **The `260405_cloud_memory_approval_zombie_loop` sibling** is a `CLOUD_CHANNEL_POLICIES`
  parity gap (a routing-table omission), NOT a payload-shape drift — a DIFFERENT seam.
  This payload-contract harness does not catch it; needs the channel-policy enumeration
  test its own postmortem recommends.
- **Prod-ingress fail-soft = the Shape-B prod-protection follow-up.** A fail-soft
  (log-and-drop) parse at the cloud ingress that COULD run in prod is the user-visible,
  separately-approved Shape-B lever Greg deferred (Zod default-strips unknown keys and
  `.refine`/`.min` may reject real payloads → an accidental prod-enforce would be a
  user-visible regression).
- **Full AST anti-bypass ratchet** for future raw `webContents.send` on a schema-backed
  channel — the cheap literal test above covers today's claim (zero offenders);
  full-AST is recommended OUT, candidate follow-up alongside the consumer chokepoint.
