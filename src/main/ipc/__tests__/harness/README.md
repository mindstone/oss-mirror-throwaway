# IPC contract round-trip harness

> **Honest scope, by design.** This harness was built specifically to *not* ship a
> meta-false-green — a test that looks like it proves more than it does. The
> coverage split below is deliberately precise: read "what it ACTUALLY verifies"
> and "what it does NOT catch" together, not just the headline.

Canonical plan: [`docs/plans/260609_ipc-inprocess-contract-harness/PLAN.md`](../../../../../docs/plans/260609_ipc-inprocess-contract-harness/PLAN.md)
(shape C+; see the drift-class banner under `## Stages`).

## What the harness IS

A **single-process round-trip harness** that drives an Electron main↔renderer IPC
call end-to-end in one Node test process, plus the **dev/test-gated contract-parse
SEAM** that is the actual guarantee.

The round-trip path (one channel, in-process, no Electron runtime):

```
sampleRequest(request schema)              ← bounded Zod fixture source (sampleRequest.ts)
  → request.parse        (driver-side)     ← prove the sample is contract-valid
  → transport(req)       (structuredClone) ← faithful V8-SCA wire (transport.ts)
  → real preload makeDomainApi[method](req)← the REAL renderer invoke path (ipcBridgeBuilder.ts)
      → fake ipcRenderer.invoke = harnessInvoke
        → transport(req) (the wire the fake models)
        → registry.invokeWithRouting(channel, event, req)
          → SEAM decorator: request.parse in / response.parse out   ← the spine
          → the REAL handler body
        → transport(res)
  → response.parse       (driver-side)     ← final contract assertion
```

The **spine** is the seam at `registerHandler` — a dev/test-gated decorator that
wraps every handler registered through the single registration chokepoint so that
its input is `request.parse`d before the body and its output `response.parse`d
after. The harness (transport + boot + driver + coverage guard) is the
**boot/transport/coverage evidence and driver around that seam**, not a separate
contract assertion.

- **Seam decorator:** [`src/main/ipc/utils/registerContractHandler.ts`](../../utils/registerContractHandler.ts)
  (the gated wrap, `isContractEnforcementOn()`, `EXECUTE_SAFE`).
- **Registration chokepoint it wraps:** [`src/main/ipc/utils/registerHandler.ts`](../../utils/registerHandler.ts).
- **Harness modules** (this directory): `transport.ts` (the faithful
  `structuredClone` wire), `bootRealAmbientServices.ts` (minimal test-local
  factory-shim boot + divergence guard), `cloudSafeRegistrars.ts` (the 23-registrar
  boot table), `sampleRequest.ts` (`sampleRequest` / `sampleResponse` bounded
  sampler), `requestOverrides.ts` (curated fixtures + `UNSAMPLEABLE`), `roundTrip.ts`
  (the driver), `coverageGuard.ts` + `harnessExemptions.ts` (anti-rot).
- **The enumerate-and-assert suite:** [`../ipcContractRoundTrip.harness.test.ts`](../ipcContractRoundTrip.harness.test.ts).

## What it ACTUALLY verifies (the honest coverage split)

### Suite-wide (the real headline value)

The seam is **on under `NODE_ENV==='test'`** (fail-safe-off everywhere else), so
**every handler invoked through `registerHandler` in the whole ~36k-test suite gets
its request and response contract-parsed by construction** — not just the handlers
this harness drives. This was validated empirically: a full `--project=desktop`
run (36,407 tests) with the seam globally on produced **5 failures, all
seam-induced, all malformed test fixtures** (since fixed); 0 pre-existing. That
one-time cost bought suite-wide contract enforcement for free thereafter.

### Harness-driven cloud-safe subset

The harness boots the **23 cloud-safe registrars** and reads back the channels they
actually register — **279 registered invoke channels**, split honestly:

- **3 EXECUTED** (`inbox:load`, `feedback:conversation-get`, `library:stat-file`):
  the **real handler body runs** and its **real response is `response.parse`d** =
  **genuine response-contract coverage**. These are on the `EXECUTE_SAFE`
  read-only allowlist.
- **276 STUBBED**: request-sampleable + response-schema-sampleable **only**. The
  body does **NOT** run; the response is a `sampleResponse(...)` fixture parsed
  against the same schema that produced it (**circular** → this is NOT real
  response verification). Do not count stubbed channels as response-verified.

Stub-by-default is safe-by-construction: a channel that is not on the allowlist
(a miss, a rename, a new side-effecting channel) can never mutate state or hit the
network during the test run.

### Anti-rot

- The **coverage guard** ([`coverageGuard.ts`](./coverageGuard.ts) +
  [`harnessExemptions.ts`](./harnessExemptions.ts)) **fails loud** if a cloud-safe
  channel becomes uncovered: **601 not-skipped = 276 covered / 325 exempted-by-domain-category**
  (pinned counts; the gap cannot silently grow). Exemptions are domain-keyed
  (38 reviewed domain entries) with a no-mixed-domain invariant the guard
  re-asserts.
- The **import guard** (`scripts/check-no-prod-test-imports.ts`) blocks any
  production file under `src/**` from importing `__tests__/` — the bug class this
  run itself hit when the seam decorator briefly lived under `__tests__/`.

## What it does NOT catch (be explicit)

- **Handler-internal field-read drift on contract-valid input.** The seam
  `request.parse` proves the *input crossing the seam* conforms to the contract; it
  does **not** prove the handler body reads the field names the contract declares.
  A body that reads `user_id` while the contract declares `userId` passes the
  request seam (the input `{userId}` is valid) — it only surfaces **response-mediated**
  (the response fails `response.parse`) or via a crash.
- **Renderer call-site drift.** A renderer passing the wrong object shape is a
  type-level concern. The `DomainApi` / `RequestArgs<z.input<TReq>>` mapped type in
  `ipcBridgeBuilder.ts` makes a **typed** wrong-shape call a `lint:ts` compile error
  — **but ~132 raw `ipcRenderer.invoke(...)` sites in `src/preload/index.ts` bypass
  the typed surface** and are NOT type-guarded. Quantified caveat, not "covered."
- **Broadcast / event channels** (`broadcasts.ts` → `BROADCAST_SCHEMAS`). These are
  a separate map, out of scope for a round-trip harness — and they are the actual
  analog of the motivating `260405_memory_approval_ipc_crash` bug (which fired on a
  broadcast/event-dispatch path). Stage 8 reconstructs only the **invoke** analog.
- **Cross-surface (desktop-vs-cloud) parity.** The harness boots cloud-style local
  deps; it does NOT exercise the same channel under both surfaces, so the
  "cross-surface" half of the parent intent is only partially served.

## Production enforcement (shape B) is DEFERRED

The seam is **gated OFF in production by construction** (the enforcement path
requires `NODE_ENV !== 'production'`). Flipping it on in prod (shape B) is an
explicitly-deferred, separately-approved follow-up — it is a user-visible behavior
change on a shared contract and needs its own audit first:

- Zod **default-strips** undeclared object keys, so an unaudited prod enforce would
  silently drop fields handlers may read.
- `.refine` / `.min` constraints may **reject real payloads** that today flow.
- Per-call parse **perf budget** in the hot IPC path.

Once that audit is done and approved, the dev/test decorator promotes to prod with
a one-line gate flip.

## How to extend (grow REAL coverage)

- **Add a read-only channel to `EXECUTE_SAFE`** (in
  [`registerContractHandler.ts`](../../utils/registerContractHandler.ts)) with a
  read-only justification — that moves it from STUBBED to EXECUTED and gives it
  genuine response-contract coverage. The default (stub) stays safe, so only
  vetted read-only channels run their real bodies.
- The **bounded sampler** ([`sampleRequest.ts`](./sampleRequest.ts)) auto-produces
  a contract-valid request for most channels; for a channel whose real body applies
  validation beyond the request schema (e.g. an on-disk path), add a curated
  fixture via `requestOverrides` / the harness-local `executedRequestOverrides`.
- An un-sampleable channel must be a **loud `UNSAMPLEABLE` exemption with a reason**
  — never a silent skip (the sampler throws on failure).
