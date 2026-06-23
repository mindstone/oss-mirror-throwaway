import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingSource } from '@shared/utils/billingSource';
import {
  PROVIDER_CREDENTIAL_SOURCES,
  PROVIDER_ROUTE_PROVIDERS,
  type ProviderCredentialSource,
  type ProviderRouteProvider,
  type ProviderRouteTransport,
} from '@shared/types/providerRoute';
import { billingSourceForCredentialSource } from './providerBillingSource';
import type { ProviderRouteRole } from './providerRouteDecision';

/**
 * Route-tag integrity helper (WS1a deliverable #2) — PURE, ADDITIVE, NOT YET WIRED.
 *
 * Purpose: give the localhost proxy boundary a tamper-evident, anti-stale way to
 * verify that the request it is about to egress matches the route the executor
 * actually decided. Today the proxy RE-decides provider/billing/credential from
 * loose wire headers + `body.model` (the WS1 god-object problem); WS1b will have
 * the executor EMIT this tag and the proxy TRUST it (fail-closed if absent). This
 * module only builds + exports the tag/verify primitives.
 *
 * Trust model: this is a LOCALHOST process boundary (executor ↔ in-process proxy
 * server), NOT a crypto-adversarial network boundary. The goal is correctness and
 * staleness detection (did a header get dropped / does the body model still match
 * the decided wire model?), not defending against a motivated forger. We therefore
 * use a plain SHA-256 over canonicalized fields — dependency-light, deterministic,
 * and stable across processes — rather than an HMAC/secret scheme. If WS1b decides
 * it needs unforgeability, swap the digest fn for an HMAC keyed on the existing
 * `x-proxy-auth` token without changing the field set or the tag string shape.
 */

/** Tag scheme version — bump if the canonical field set or hashing changes. */
export const ROUTE_TAG_SCHEME_VERSION = 1;

/** Prefix on the emitted tag string so a verifier can reject foreign/old schemes. */
const ROUTE_TAG_PREFIX = `rt${ROUTE_TAG_SCHEME_VERSION}`;

/**
 * The canonical route FACTS a tag is computed over. These are exactly the facts
 * the proxy must NOT re-derive: identity (turn/route), the resolved wire model the
 * body must match, and the provider/transport/credential/billing/role/profile the
 * egress decision depends on.
 */
export interface RouteTagFacts {
  /** Turn id (route-table dispatch) or a stable route id. Identity anchor. */
  readonly routeId: string;
  readonly provider: ProviderRouteProvider;
  readonly transport: ProviderRouteTransport;
  /** The RESOLVED wire model the request body's `model` must equal. */
  readonly wireModelId: string;
  readonly credentialSource: ProviderCredentialSource;
  readonly billingSource: BillingSource | null;
  readonly role: ProviderRouteRole;
  readonly profileId: string | null;
}

/**
 * Why a tag failed verification. `absent` = no tag present (caller decides
 * fail-open vs fail-closed); `integrity-fail` = the tag does not match the facts
 * presented (spoofed digest OR a stale/changed field); `model-mismatch` = the
 * tag's facts are internally consistent but the request `body.model` ≠ the tagged
 * `wireModelId`; `stale` = a recognised scheme tag whose embedded version is older
 * than the current verifier (reserved for future scheme bumps).
 */
export type RouteTagMismatchReason =
  | 'absent'
  | 'integrity-fail'
  | 'model-mismatch'
  | 'stale';

export type RouteTagVerification =
  | { ok: true }
  | { ok: false; reason: RouteTagMismatchReason };

/**
 * Canonicalize the facts into a stable, order-independent string. Field ORDER is
 * fixed here (not via object key iteration) so the digest cannot drift on JS
 * engine key-ordering quirks, and `null` is encoded explicitly so an absent
 * profile/billing can't collide with a literal `"null"` string value.
 */
function canonicalizeFacts(facts: RouteTagFacts): string {
  const ordered: ReadonlyArray<readonly [string, string]> = [
    ['routeId', facts.routeId],
    ['provider', facts.provider],
    ['transport', facts.transport],
    ['wireModelId', facts.wireModelId],
    ['credentialSource', facts.credentialSource],
    ['billingSource', facts.billingSource ?? '\x00null'],
    ['role', facts.role],
    ['profileId', facts.profileId ?? '\x00null'],
  ];
  // `'\x1f'` (unit separator) cannot appear in any of these enum/id values, so it
  // is an unambiguous field delimiter.
  return ordered.map(([key, value]) => `${key}=${value}`).join('\x1f');
}

function digestFacts(facts: RouteTagFacts): string {
  return createHash('sha256').update(canonicalizeFacts(facts), 'utf8').digest('hex');
}

/**
 * Compute the tamper-evident route tag string for a set of route facts. Shape:
 * `rt<version>.<sha256-hex>`. Stable for identical facts; any field change yields a
 * different tag.
 */
export function computeRouteTag(facts: RouteTagFacts): string {
  return `${ROUTE_TAG_PREFIX}.${digestFacts(facts)}`;
}

/**
 * Scheme-level inspection of a presented tag WITHOUT the route facts.
 *
 * `verifyRouteTag` needs the full `RouteTagFacts` to recompute the digest — a check
 * the localhost proxy CANNOT perform at ingress today (it cannot re-derive
 * role/profileId/credentialSource/billingSource; full re-derivation needs a signed
 * fact-carrier — deferred to WS4). This helper gives a consumer the HONEST,
 * fact-free signals it *can* assert: was a tag sent at all, is it a recognised &
 * current scheme, or is it garbled? It deliberately does NOT compare the digest, so
 * a `current` result means "executor→proxy header propagation confirmed + scheme
 * current", NOT "the 8-field route decision is integrity-verified".
 *
 *  - `absent`    — no tag header.
 *  - `malformed` — present but not a parseable `rt<version>.<digest>` shape.
 *  - `stale`     — a recognised scheme tag whose version is older than the verifier.
 *  - `current`   — a parseable tag at the current scheme version.
 */
export type RouteTagInspection = 'absent' | 'malformed' | 'stale' | 'current';

export function inspectRouteTag(tag: string | null | undefined): RouteTagInspection {
  if (tag === null || tag === undefined || tag.length === 0) {
    return 'absent';
  }
  const parsed = parseTag(tag);
  if (!parsed) {
    return 'malformed';
  }
  if (parsed.version < ROUTE_TAG_SCHEME_VERSION) {
    return 'stale';
  }
  return 'current';
}

function parseTag(tag: string): { version: number; digest: string } | null {
  const dot = tag.indexOf('.');
  if (dot <= 0) return null;
  const scheme = tag.slice(0, dot);
  const digest = tag.slice(dot + 1);
  if (!scheme.startsWith('rt')) return null;
  const version = Number.parseInt(scheme.slice(2), 10);
  if (!Number.isInteger(version) || digest.length === 0) return null;
  return { version, digest };
}

/**
 * Verify a presented tag against the facts the verifier independently holds AND
 * the actual request `body.model`. Returns `ok` only when the tag is present,
 * integrity-valid for these facts, and the body model matches the tagged wire
 * model.
 *
 * Verification ORDER is deliberate:
 *  1. absent → `absent` (caller chooses fail-open/closed).
 *  2. unrecognised/older scheme → `stale`.
 *  3. digest ≠ recomputed(facts) → `integrity-fail` (spoof OR a changed/stale field).
 *  4. body model ≠ tagged wire model → `model-mismatch`.
 *
 * @internal Shipped-ahead seam reserved for WS4's signed fact-carrier (the only consumer able to
 * supply the full RouteTagFacts at the proxy ingress). Currently exercised only by its unit test —
 * WS1b-2 uses `inspectRouteTag` instead. Drop this `@internal` tag when WS4 wires it into production.
 */
export function verifyRouteTag(
  tag: string | null | undefined,
  facts: RouteTagFacts,
  bodyModel: string | null | undefined,
): RouteTagVerification {
  if (tag === null || tag === undefined || tag.length === 0) {
    return { ok: false, reason: 'absent' };
  }
  const parsed = parseTag(tag);
  if (!parsed) {
    return { ok: false, reason: 'integrity-fail' };
  }
  if (parsed.version < ROUTE_TAG_SCHEME_VERSION) {
    return { ok: false, reason: 'stale' };
  }
  if (parsed.digest !== digestFacts(facts)) {
    return { ok: false, reason: 'integrity-fail' };
  }
  if ((bodyModel ?? '') !== facts.wireModelId) {
    return { ok: false, reason: 'model-mismatch' };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────
// WS4a — SIGNED, DECODABLE route-facts carrier (additive; NOT YET CONSUMED).
//
// The `x-route-tag` digest above is a tamper-EVIDENT but FACT-OPAQUE witness: the
// proxy can recompute it only if it already holds all 8 facts, which it does not at
// ingress (it lacks role/profileId/credentialSource/billingSource — exactly the
// facts it currently RE-derives, the WS1 god-object problem). WS4a closes that gap
// with a carrier that TRANSPORTS the facts themselves, signed so the proxy can
// trust them without re-deriving (the consumption is WS4b — this stage only
// establishes + tests the carrier; the proxy gate stays telemetry-only).
//
// Trust model: this rides the AUTHENTICATED localhost boundary — the executor and
// the in-process proxy share the random per-session `x-proxy-auth` token, and the
// proxy rejects any request that does not present it (constant-time check) BEFORE
// the carrier is ever read. We therefore key an HMAC-SHA256 on that SAME shared
// secret (fulfilling the swap-the-digest-fn note above): a carrier is unforgeable
// to anyone who does not already hold the localhost auth token, and tamper-evident
// (any flipped fact invalidates the MAC). The secret is NEVER embedded in the
// carrier — only the facts (as canonical JSON) and the MAC over them.
// ───────────────────────────────────────────────────────────────────────────

/** Carrier scheme version — bump if the payload encoding or MAC algorithm changes. */
export const ROUTE_FACTS_SCHEME_VERSION = 1;

/** Prefix so a verifier can reject foreign/old carrier schemes. Shape: `rf<version>.<b64url-facts>.<b64url-mac>`. */
const ROUTE_FACTS_PREFIX = `rf${ROUTE_FACTS_SCHEME_VERSION}`;

/**
 * Why a carrier failed verification.
 *  - `absent`        — no carrier present (caller decides fail-open vs fail-closed).
 *  - `malformed`     — present but not a parseable `rf<version>.<facts>.<mac>` shape,
 *                      a foreign/older scheme, or a payload that does not decode to
 *                      well-formed `RouteTagFacts`.
 *  - `bad-signature` — the MAC does not match the payload under the presented secret
 *                      (a forged/tampered carrier OR a wrong-key verification).
 */
export type RouteFactsFailureReason = 'absent' | 'malformed' | 'bad-signature';

export type RouteFactsVerification =
  | { ok: true; facts: RouteTagFacts }
  | { ok: false; reason: RouteFactsFailureReason };

/**
 * Canonical JSON for the facts payload. Field ORDER is fixed here (not via object
 * key iteration) so the encoded bytes — and therefore the MAC — cannot drift on JS
 * engine key-ordering quirks. `null` is preserved as JSON `null` so an absent
 * profile/billing is unambiguous and round-trips exactly.
 */
function canonicalFactsJson(facts: RouteTagFacts): string {
  // Explicit ordered tuple → object so JSON.stringify emits a stable key order.
  const ordered = {
    routeId: facts.routeId,
    provider: facts.provider,
    transport: facts.transport,
    wireModelId: facts.wireModelId,
    credentialSource: facts.credentialSource,
    billingSource: facts.billingSource ?? null,
    role: facts.role,
    profileId: facts.profileId ?? null,
  };
  return JSON.stringify(ordered);
}

function macForPayload(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64, 'utf8').digest('base64url');
}

/**
 * Produce a signed, decodable facts carrier string for transport over the
 * executor→proxy localhost boundary. Shape: `rf<version>.<b64url(facts-json)>.<b64url(hmac)>`.
 * The MAC is keyed on the shared `x-proxy-auth` secret. Stable for identical
 * (facts, secret); any field or key change yields a different carrier.
 */
export function signRouteFacts(facts: RouteTagFacts, secret: string): string {
  const payloadB64 = Buffer.from(canonicalFactsJson(facts), 'utf8').toString('base64url');
  const mac = macForPayload(payloadB64, secret);
  return `${ROUTE_FACTS_PREFIX}.${payloadB64}.${mac}`;
}

// Validation vocabularies, sourced from the canonical type definitions so they
// cannot drift. `ProviderRouteRole` and `ProviderRouteTransport` have no exported
// const array, so their members are mirrored here:
//   - role       (providerRouteDecision.ts): 'execution' | 'planning' | 'bts' | 'subagent'
//   - transport  (providerRoute.ts, ProviderRouteTransport union, 8 members)
// A compile-time exhaustiveness assertion below pins each mirrored set to its union
// so a new member added to the type forces this list to be updated.
const ROUTE_TAG_PROVIDERS: ReadonlySet<string> = new Set<string>(PROVIDER_ROUTE_PROVIDERS);
// Exhaustive map keyed by the union → a new ProviderRouteRole member fails to
// typecheck here until added (missing key is a compile error on the literal object).
const ROUTE_TAG_ROLE_MAP: Record<ProviderRouteRole, true> = {
  execution: true,
  planning: true,
  bts: true,
  subagent: true,
};
const ROUTE_TAG_ROLES: ReadonlySet<string> = new Set<string>(Object.keys(ROUTE_TAG_ROLE_MAP));
const ROUTE_TAG_CREDENTIAL_SOURCES: ReadonlySet<string> = new Set<string>(PROVIDER_CREDENTIAL_SOURCES);
// Exhaustive map keyed by the union → a new ProviderRouteTransport member fails to
// typecheck here until added (missing key is a compile error on the literal object).
const ROUTE_TAG_TRANSPORT_MAP: Record<ProviderRouteTransport, true> = {
  'anthropic-direct': true,
  'anthropic-compatible-local-proxy': true,
  'openai-compatible-http': true,
  'local-openai-compatible-http': true,
  'codex-proxy': true,
  'openrouter-proxy': true,
  'no-credentials': true,
  'fail-closed-codex-disconnected': true,
};
const ROUTE_TAG_TRANSPORTS: ReadonlySet<string> = new Set<string>(Object.keys(ROUTE_TAG_TRANSPORT_MAP));

// `BillingSource` has no exported const array — exhaustive map keyed by the union so
// a new member fails to typecheck here until added (missing key is a compile error).
const ROUTE_TAG_BILLING_SOURCE_MAP: Record<BillingSource, true> = {
  subscription: true,
  pool: true,
  'pay-per-use': true,
  local: true,
};
const ROUTE_TAG_BILLING_SOURCES: ReadonlySet<string> = new Set<string>(Object.keys(ROUTE_TAG_BILLING_SOURCE_MAP));

/**
 * Narrow an arbitrary decoded object to `RouteTagFacts`. Defensive: a carrier whose
 * payload decodes to JSON but is not a well-formed facts object is treated as
 * `malformed`, never silently coerced. We validate ALL discriminant-bearing fields
 * (provider/role/transport/credentialSource/billingSource) against their canonical
 * vocabularies, and require the string-typed identity fields; `billingSource`/
 * `profileId` are `string | null`.
 *
 * Beyond per-field vocab, we enforce an INTERNAL CONSISTENCY rule: when a non-null
 * `billingSource` is present it MUST equal the canonical billing axis the
 * `credentialSource` implies (`billingSourceForCredentialSource`). A carrier that
 * claims, e.g., a `mindstone-managed-key` credential (→ canonical `subscription`)
 * but carries `billingSource: 'pool'` is internally inconsistent (a hand-crafted /
 * corrupted carrier the executor never emits) and is rejected as `malformed`. A
 * `null` billingSource is always allowed (the executor emits `null` for terminal /
 * missing credential sources, which have no billing identity).
 */
function decodeFacts(value: unknown): RouteTagFacts | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const isStr = (x: unknown): x is string => typeof x === 'string';
  const isStrOrNull = (x: unknown): x is string | null => x === null || typeof x === 'string';
  if (
    !isStr(v.routeId) ||
    !isStr(v.provider) || !ROUTE_TAG_PROVIDERS.has(v.provider) ||
    !isStr(v.transport) || !ROUTE_TAG_TRANSPORTS.has(v.transport) ||
    !isStr(v.wireModelId) ||
    !isStr(v.credentialSource) || !ROUTE_TAG_CREDENTIAL_SOURCES.has(v.credentialSource) ||
    !isStrOrNull(v.billingSource) || (v.billingSource !== null && !ROUTE_TAG_BILLING_SOURCES.has(v.billingSource)) ||
    !isStr(v.role) || !ROUTE_TAG_ROLES.has(v.role) ||
    !isStrOrNull(v.profileId)
  ) {
    return null;
  }
  // Internal consistency: a present billingSource must match the credentialSource's
  // canonical billing axis. (null is always permitted — terminal/missing sources.)
  if (
    v.billingSource !== null &&
    v.billingSource !== billingSourceForCredentialSource(v.credentialSource as ProviderCredentialSource)
  ) {
    return null;
  }
  return {
    routeId: v.routeId,
    provider: v.provider as RouteTagFacts['provider'],
    transport: v.transport as RouteTagFacts['transport'],
    wireModelId: v.wireModelId,
    credentialSource: v.credentialSource as RouteTagFacts['credentialSource'],
    billingSource: v.billingSource as RouteTagFacts['billingSource'],
    role: v.role as RouteTagFacts['role'],
    profileId: v.profileId,
  };
}

/**
 * Verify + DECODE a presented carrier against the shared secret. Returns the
 * decoded `RouteTagFacts` only when the carrier is present, the scheme is current,
 * the MAC matches under `secret` (constant-time), and the payload decodes to
 * well-formed facts.
 *
 * Verification ORDER:
 *  1. absent → `absent` (caller chooses fail-open/closed).
 *  2. not a parseable current-scheme `rf<v>.<facts>.<mac>` → `malformed`.
 *  3. MAC ≠ recomputed(payload, secret) → `bad-signature` (forged/tampered/wrong-key).
 *  4. payload not well-formed facts → `malformed`.
 *
 * @internal Shipped-ahead seam reserved for WS4b's proxy consumer (the only consumer
 * that holds the shared `x-proxy-auth` secret at ingress and can supply it here).
 * Currently exercised only by its unit test — the WS4a gate stays telemetry-only.
 * Drop this `@internal` tag when WS4b wires it into production.
 */
export function verifyRouteFacts(
  carrier: string | null | undefined,
  secret: string,
): RouteFactsVerification {
  if (carrier === null || carrier === undefined || carrier.length === 0) {
    return { ok: false, reason: 'absent' };
  }
  const parts = carrier.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }
  const [scheme, payloadB64, mac] = parts;
  if (scheme !== ROUTE_FACTS_PREFIX || payloadB64.length === 0 || mac.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  // Constant-time MAC compare. Length-guard first (timingSafeEqual throws on a
  // length mismatch); a wrong-key recompute is the same byte length, so this never
  // short-circuits the real forgery case.
  const expectedMac = macForPayload(payloadB64, secret);
  const presented = Buffer.from(mac);
  const expected = Buffer.from(expectedMac);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const facts = decodeFacts(parsed);
  if (facts === null) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, facts };
}
