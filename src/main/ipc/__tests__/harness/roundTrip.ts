/**
 * Stage 5: the in-process IPC contract round-trip driver.
 *
 * ## Two modes, honestly distinguished (Stage-5 review F1/F2)
 * The driver has a **safe-by-construction** execute policy. A channel runs its
 * REAL handler body ONLY if it is on the {@link EXECUTE_SAFE} allowlist
 * (`mode: 'executed'`); EVERY other channel is **stubbed** (`mode: 'stubbed'`) —
 * the registry / real handler is NEVER hit. The default is stub = safe: a
 * channel NOT on the allowlist (a miss, a rename, a brand-new side-effecting
 * channel) can never mutate state or hit the network during the test run.
 *
 * ### `mode: 'executed'` (EXECUTE_SAFE channels) — GENUINE response coverage
 * Drives one channel end-to-end through the SAME path a real renderer→main IPC
 * call takes, in a single Node test process:
 *
 *   sampleRequest(req schema)            ← Stage-4 fixture source
 *     → request.parse  (driver-side)     ← prove the sample is contract-valid
 *     → transport(req) (structuredClone) ← faithful V8-SCA wire (Stage 1)
 *     → real preload `makeDomainApi[method](req)`  ← the REAL renderer invoke path
 *         → fake ipcRenderer.invoke = {@link harnessInvoke}
 *             → transport(req) again (the wire the fake models)
 *             → registry.invokeWithRouting(channel, event, req)
 *                 → Stage-2 seam decorator: request.parse / response.parse
 *                 → the REAL handler body
 *             → transport(res)
 *     → response.parse (driver-side)     ← final contract assertion on the REAL response
 *
 * So for an executed channel a request-shape drift fails at the seam's
 * `request.parse`, and a response-shape drift (incl. `undefined`-drop / Date /
 * Map corruption a JSON wire hid) fails at the seam's `response.parse` AND the
 * driver's final `response.parse` — against the ACTUAL handler output.
 *
 * ### `mode: 'stubbed'` (everything else) — NOT real response coverage
 * For a stubbed channel the driver runs `request.parse` on the (transported)
 * sampled request, then **substitutes `sampleResponse(channelDef.response)` (run
 * through `response.parse`) instead of invoking the body** — the real handler is
 * NEVER called, the registry is never hit. This proves only "request sample is
 * contract-valid + the response SCHEMA is sampleable+parseable"; it does NOT
 * verify the real response contract (the sampled response is parsed against the
 * same schema that produced it — circular). Callers MUST NOT count stubbed
 * channels as response-verified coverage. The driver sets
 * `REBEL_CONTRACT_HARNESS_PARSE_ONLY` for the duration of a stubbed dispatch so
 * the intent is explicit; the global seam decorator does NOT read that flag (it
 * only ever parses-around the real body — Stage 2), so the side-effect avoidance
 * is scoped to the harness and leaves the rest of the `NODE_ENV==='test'` suite
 * untouched.
 *
 * ## Routing decision (DOCUMENTED GAP — GPT-general-F4 / PLAN Stage 5 option ii)
 * The harness installs a `MapHandlerRegistry`, so executed channels dispatch via
 * `MapHandlerRegistry.invokeWithRouting` — **local-handler dispatch only**. It
 * does NOT model `ElectronHandlerRegistry.executeWithRouting`'s dual-write /
 * cloud-routing / payload-size / latency logic, which is Electron-only and needs
 * a real `cloudRouter`. This is the explicit, named gap: **the harness covers
 * contract SHAPE, not Electron routing semantics.** `MapHandlerRegistry.
 * invokeWithRouting` is intentionally a thin `get(channel)` + invoke, so it is
 * the closest faithful local model; we do NOT silently imply full routing.
 *
 * ## Vacuous responses (F2 carry-in)
 * Some channels declare `z.any()` / `z.unknown()` responses (e.g. the desktop
 * voice channels) whose `response.parse` is VACUOUS — it asserts nothing. The
 * driver still round-trips them but a caller / Stage 6 should consult
 * {@link isVacuousResponse} and NOT count them as strong response coverage.
 */

import type { z } from 'zod';

import { allChannels, ipcContract } from '@shared/ipc/contracts';
import type { AnyChannelDef } from '../../../../preload/ipcBridgeBuilder';
import { channelToMethodName, makeDomainApi } from '../../../../preload/ipcBridgeBuilder';

import { transport } from './transport';
import { sampleRequest, sampleResponse } from './sampleRequest';
import { requestOverrides } from './requestOverrides';
import { isExecuteSafe } from '../../utils/registerContractHandler';

/** Harness-only flag the driver sets to advertise parse-only intent for a stubbed dispatch. */
export const HARNESS_PARSE_ONLY_FLAG = 'REBEL_CONTRACT_HARNESS_PARSE_ONLY';

/**
 * The honest outcome of a driven channel:
 *  - `'executed'` — the REAL handler body ran and its REAL response was parsed
 *    against the contract (genuine response coverage).
 *  - `'stubbed'`  — the body was NOT run; a sampled response was substituted and
 *    parsed against its own schema (request-valid + schema-sampleable only; NOT
 *    real-response coverage).
 */
export type RoundTripMode = 'executed' | 'stubbed';

/** A driven-channel result: the parsed response + how it was obtained. */
export interface RoundTripResult {
  readonly mode: RoundTripMode;
  readonly response: unknown;
}

// ---------------------------------------------------------------------------
// channel → domain-group index (so we drive the REAL per-domain makeDomainApi)
// ---------------------------------------------------------------------------

type ChannelDefLike = {
  type: 'invoke' | 'sync';
  channel: string;
  request: z.ZodTypeAny;
  response: z.ZodTypeAny;
};

/** Map every channel id to the `ipcContract` domain group it belongs to. */
const CHANNEL_DOMAIN = ((): ReadonlyMap<string, keyof typeof ipcContract> => {
  const m = new Map<string, keyof typeof ipcContract>();
  for (const [domain, group] of Object.entries(ipcContract)) {
    for (const channel of Object.keys(group)) {
      m.set(channel, domain as keyof typeof ipcContract);
    }
  }
  return m;
})();

function channelDef(channel: string): ChannelDefLike {
  const def = (allChannels as Record<string, ChannelDefLike>)[channel];
  if (!def) {
    throw new Error(`roundTrip: channel '${channel}' is not in allChannels`);
  }
  return def;
}

/** Is a channel's response schema vacuous (`z.any()`/`z.unknown()` → parse asserts nothing)? */
export function isVacuousResponse(channel: string): boolean {
  const def = (allChannels as Record<string, ChannelDefLike>)[channel];
  if (!def) return false;
  const t = (def.response as { _zod?: { def?: { type?: string } } })?._zod?.def?.type;
  return t === 'any' || t === 'unknown';
}

// ---------------------------------------------------------------------------
// The fake-ipcRenderer dispatch sink (the real makeDomainApi calls into this)
// ---------------------------------------------------------------------------

/**
 * The mode of the most recent {@link harnessInvoke} dispatch. The fake
 * `ipcRenderer.invoke` returns only the response value (it models the real
 * single-value IPC return), so the driver reads the mode back from here rather
 * than threading it through the preload API signature.
 */
let lastInvokeMode: RoundTripMode = 'stubbed';

/**
 * The invoke implementation the test's `vi.mock('electron')` delegates to. This
 * IS the wire the fake `ipcRenderer` models: it transports the request (the
 * faithful structured-clone the renderer→main boundary applies), and — for an
 * {@link isExecuteSafe} channel — dispatches via the local `MapHandlerRegistry`,
 * then transports the REAL response back.
 *
 * SAFE-BY-CONSTRUCTION: a channel NOT on the allowlist is stubbed — it never
 * reaches the registry; the body is skipped and a sampled, contract-valid
 * response is substituted (proving no side-effecting body ran). The mode is
 * surfaced via {@link lastInvokeMode} so the public driver can report it.
 */
export async function harnessInvoke(channel: string, request: unknown): Promise<unknown> {
  const def = channelDef(channel);

  // Wire #2: the request crosses the (faithful) transport into "main".
  const wireRequest = transport(request);

  if (!isExecuteSafe(channel)) {
    // STUB (default = safe): parse the request that crossed the seam (proves
    // request shape), then substitute a sampled, schema-valid response — never
    // invoke the real body, never hit the registry. Advertise parse-only intent
    // via the harness flag for the duration of this dispatch.
    const hadFlag = process.env[HARNESS_PARSE_ONLY_FLAG];
    process.env[HARNESS_PARSE_ONLY_FLAG] = '1';
    try {
      lastInvokeMode = 'stubbed';
      def.request.parse(wireRequest);
      const sampled = sampleResponse(def.response);
      const parsed = def.response.parse(sampled);
      return transport(parsed);
    } finally {
      if (hadFlag === undefined) {
        delete process.env[HARNESS_PARSE_ONLY_FLAG];
      } else {
        process.env[HARNESS_PARSE_ONLY_FLAG] = hadFlag;
      }
    }
  }

  // EXECUTE: local-handler dispatch of the REAL body (routing gap documented in
  // the module docstring). Resolve the registry via DYNAMIC import so the driver
  // lands on the same live (possibly post-`vi.resetModules()`) module graph the
  // boot helper installed the registry on — the Stage-3 DEVIATION graph-fork
  // hazard (a static import here would see a different `getHandlerRegistry`).
  lastInvokeMode = 'executed';
  const { getHandlerRegistry } = await import('@core/handlerRegistry');
  const registry = getHandlerRegistry();
  const result = await registry.invokeWithRouting(channel, /* event */ null, wireRequest);

  // Wire #3: the response crosses the (faithful) transport back to "renderer".
  return transport(result);
}

// ---------------------------------------------------------------------------
// The public driver
// ---------------------------------------------------------------------------

/**
 * Drive one cloud-safe channel through the full real-preload → transport → seam
 * → handler → transport → `response.parse` path and return the parsed response
 * plus its honest {@link RoundTripMode}.
 *
 * The request is `transport(request.parse(sampleRequest(...)))` — a contract-
 * valid sample, parsed driver-side (proving the sample conforms) and transported,
 * then handed to the REAL per-domain `makeDomainApi[method]`. For an
 * {@link isExecuteSafe} channel the seam ALSO parses request-in / response-out
 * around the REAL body (`mode: 'executed'`, genuine response coverage); every
 * other channel is stubbed (`mode: 'stubbed'`, request-valid + schema-sampleable
 * only — NOT real-response coverage; see the module docstring).
 *
 * @param channel - a fully-qualified channel id (e.g. `'inbox:load'`).
 * @param requestOverride - optional pre-built request (skips the sampler), e.g.
 *   to reproduce a specific existing case with a known fixture.
 */
export async function roundTrip(channel: string, requestOverride?: unknown): Promise<RoundTripResult> {
  const def = channelDef(channel);
  if (def.type !== 'invoke') {
    throw new Error(`roundTrip: channel '${channel}' is type '${def.type}', only 'invoke' is supported`);
  }

  // Resolve the request: explicit override > curated override map > sampler.
  // `requestOverrides` is keyed by `IpcChannelName`; index via a string view.
  const overrides = requestOverrides as Record<string, unknown>;
  const rawRequest =
    requestOverride !== undefined
      ? requestOverride
      : channel in overrides
        ? overrides[channel]
        : sampleRequest(def.request);

  // Driver-side request.parse: prove the sample/override is contract-valid before
  // it crosses the wire (the seam will parse again on the main side).
  const parsedRequest = def.request.parse(rawRequest);
  // Wire #1: structured-clone the request the way the renderer serialises it.
  const wireRequest = transport(parsedRequest);

  // Drive through the REAL per-domain makeDomainApi (NOT a hand-rolled caller,
  // NOT one mega-API). The fake ipcRenderer.invoke = harnessInvoke (set up by the
  // test's vi.mock('electron')).
  const domain = CHANNEL_DOMAIN.get(channel);
  if (!domain) {
    throw new Error(`roundTrip: channel '${channel}' has no ipcContract domain group`);
  }
  const api = makeDomainApi(ipcContract[domain] as Record<string, AnyChannelDef>) as Record<
    string,
    (request?: unknown) => Promise<unknown>
  >;
  const method = channelToMethodName(channel);
  const fn = api[method];
  if (typeof fn !== 'function') {
    throw new Error(`roundTrip: makeDomainApi('${domain}') has no method '${method}' for channel '${channel}'`);
  }

  const wireResponse = await fn(wireRequest);
  // harnessInvoke set the mode for this dispatch (executed vs stubbed).
  const mode = lastInvokeMode;

  // Final driver-side response.parse — the contract assertion. For an executed
  // channel this is against the REAL handler output; for a stubbed channel it is
  // against the sampled response (vacuous for z.any()/z.unknown(); see
  // isVacuousResponse). The `mode` makes that distinction explicit to callers.
  const response = def.response.parse(wireResponse);
  return { mode, response };
}
