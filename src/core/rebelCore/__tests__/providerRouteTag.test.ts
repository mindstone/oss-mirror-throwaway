import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ROUTE_FACTS_SCHEME_VERSION,
  ROUTE_TAG_SCHEME_VERSION,
  computeRouteTag,
  inspectRouteTag,
  signRouteFacts,
  verifyRouteFacts,
  verifyRouteTag,
  type RouteTagFacts,
} from '../providerRouteTag';

/**
 * Proxy-contract tests for the WS1a route-tag integrity helper (deliverable #4).
 *
 * The helper is the executor↔proxy anti-staleness boundary WS1b will wire: the
 * executor EMITs the tag, the proxy TRUSTs it (fail-closed if absent). These tests
 * pin the four verdicts the proxy will branch on — present-and-valid, absent,
 * stale/spoofed (integrity-fail), and body-model drift (model-mismatch).
 */

function facts(overrides: Partial<RouteTagFacts> = {}): RouteTagFacts {
  return {
    routeId: 'turn-abc',
    provider: 'anthropic',
    transport: 'anthropic-direct',
    wireModelId: 'claude-sonnet-4-6',
    credentialSource: 'anthropic-api-key',
    billingSource: 'pay-per-use',
    role: 'execution',
    profileId: null,
    ...overrides,
  };
}

describe('providerRouteTag: computeRouteTag', () => {
  it('is deterministic for identical facts', () => {
    expect(computeRouteTag(facts())).toBe(computeRouteTag(facts()));
  });

  it('emits the versioned scheme prefix', () => {
    expect(computeRouteTag(facts())).toMatch(new RegExp(`^rt${ROUTE_TAG_SCHEME_VERSION}\\.[0-9a-f]{64}$`));
  });

  it('changes when any field changes (non-vacuous coverage of each field)', () => {
    const base = computeRouteTag(facts());
    const mutations: Partial<RouteTagFacts>[] = [
      { routeId: 'turn-xyz' },
      { provider: 'openrouter' },
      { transport: 'openrouter-proxy' },
      { wireModelId: 'claude-opus-4-7' },
      { credentialSource: 'mindstone-managed-key' },
      { billingSource: 'subscription' },
      { role: 'bts' },
      { profileId: 'profile-1' },
    ];
    for (const mutation of mutations) {
      expect(computeRouteTag(facts(mutation)), `mutation ${JSON.stringify(mutation)}`).not.toBe(base);
    }
  });

  it('distinguishes null billing/profile from the literal string "null"', () => {
    const withNull = computeRouteTag(facts({ billingSource: null, profileId: null }));
    const withStringNull = computeRouteTag(facts({ profileId: 'null' }));
    expect(withNull).not.toBe(withStringNull);
  });
});

describe('providerRouteTag: verifyRouteTag', () => {
  it('present-and-valid tag with matching body model → ok', () => {
    const tag = computeRouteTag(facts());
    expect(verifyRouteTag(tag, facts(), 'claude-sonnet-4-6')).toEqual({ ok: true });
  });

  it('absent tag → reason "absent" (caller decides fail-open/closed)', () => {
    expect(verifyRouteTag(null, facts(), 'claude-sonnet-4-6')).toEqual({ ok: false, reason: 'absent' });
    expect(verifyRouteTag(undefined, facts(), 'claude-sonnet-4-6')).toEqual({ ok: false, reason: 'absent' });
    expect(verifyRouteTag('', facts(), 'claude-sonnet-4-6')).toEqual({ ok: false, reason: 'absent' });
  });

  it('stale: a field changed since the tag was minted → integrity-fail', () => {
    // Tag minted against the original facts; verifier now holds DIFFERENT facts
    // (e.g. credentialSource flipped) → the digest no longer matches.
    const tag = computeRouteTag(facts());
    const verifierFacts = facts({ credentialSource: 'mindstone-managed-key' });
    expect(verifyRouteTag(tag, verifierFacts, 'claude-sonnet-4-6')).toEqual({
      ok: false,
      reason: 'integrity-fail',
    });
  });

  it('spoofed: digest does not match the facts presented → integrity-fail', () => {
    const spoofed = `rt${ROUTE_TAG_SCHEME_VERSION}.${'0'.repeat(64)}`;
    expect(verifyRouteTag(spoofed, facts(), 'claude-sonnet-4-6')).toEqual({
      ok: false,
      reason: 'integrity-fail',
    });
  });

  it('malformed/unparseable tag → integrity-fail', () => {
    expect(verifyRouteTag('not-a-tag', facts(), 'claude-sonnet-4-6')).toEqual({
      ok: false,
      reason: 'integrity-fail',
    });
    expect(verifyRouteTag('rt1.', facts(), 'claude-sonnet-4-6')).toEqual({
      ok: false,
      reason: 'integrity-fail',
    });
  });

  it('older scheme version → stale', () => {
    // A tag from a hypothetical earlier scheme (version 0). Integrity-valid in its
    // own scheme is irrelevant — the verifier rejects the old scheme as stale.
    const oldTag = `rt0.${'a'.repeat(64)}`;
    expect(verifyRouteTag(oldTag, facts(), 'claude-sonnet-4-6')).toEqual({ ok: false, reason: 'stale' });
  });

  it('body.model ≠ tagged wireModelId → model-mismatch', () => {
    const tag = computeRouteTag(facts());
    expect(verifyRouteTag(tag, facts(), 'claude-opus-4-7')).toEqual({
      ok: false,
      reason: 'model-mismatch',
    });
    expect(verifyRouteTag(tag, facts(), null)).toEqual({ ok: false, reason: 'model-mismatch' });
  });

  it('integrity is checked BEFORE the body-model match (a spoofed tag with a wrong body model still reads integrity-fail)', () => {
    const spoofed = `rt${ROUTE_TAG_SCHEME_VERSION}.${'0'.repeat(64)}`;
    // Even though the body model is also wrong, integrity is the more fundamental
    // failure and must win — the proxy must never trust a spoofed tag's facts.
    expect(verifyRouteTag(spoofed, facts(), 'some-other-model')).toEqual({
      ok: false,
      reason: 'integrity-fail',
    });
  });
});

describe('providerRouteTag: inspectRouteTag (WS1b-2 fact-free scheme inspection)', () => {
  it('absent: missing/empty tag → absent', () => {
    expect(inspectRouteTag(null)).toBe('absent');
    expect(inspectRouteTag(undefined)).toBe('absent');
    expect(inspectRouteTag('')).toBe('absent');
  });

  it('current: a freshly computed tag (no facts needed) → current', () => {
    // The whole point: the proxy can assert scheme currency WITHOUT the route
    // facts — a `current` result confirms header propagation + scheme, NOT the
    // 8-field decision digest.
    expect(inspectRouteTag(computeRouteTag(facts()))).toBe('current');
    // A spoofed-but-well-formed current-scheme tag is still scheme-`current`:
    // inspectRouteTag deliberately does NOT verify the digest.
    expect(inspectRouteTag(`rt${ROUTE_TAG_SCHEME_VERSION}.${'0'.repeat(64)}`)).toBe('current');
  });

  it('malformed: unparseable shapes → malformed', () => {
    expect(inspectRouteTag('not-a-tag')).toBe('malformed');
    expect(inspectRouteTag('rt1.')).toBe('malformed');
    expect(inspectRouteTag('foo.deadbeef')).toBe('malformed');
  });

  it('stale: an older recognised scheme → stale', () => {
    expect(inspectRouteTag(`rt0.${'a'.repeat(64)}`)).toBe('stale');
  });
});

describe('providerRouteTag: signRouteFacts / verifyRouteFacts (WS4a signed fact-carrier)', () => {
  const SECRET = 'proxy-auth-token-abc';

  it('emits the versioned carrier scheme prefix (rf<version>.<facts>.<mac>)', () => {
    const carrier = signRouteFacts(facts(), SECRET);
    expect(carrier).toMatch(new RegExp(`^rf${ROUTE_FACTS_SCHEME_VERSION}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
  });

  it('is deterministic for identical (facts, secret)', () => {
    expect(signRouteFacts(facts(), SECRET)).toBe(signRouteFacts(facts(), SECRET));
  });

  it('sign → verify roundtrip returns the EXACT facts (all 8 fields, incl. nulls)', () => {
    const original = facts({ billingSource: null, profileId: null });
    const result = verifyRouteFacts(signRouteFacts(original, SECRET), SECRET);
    expect(result).toEqual({ ok: true, facts: original });
  });

  it('roundtrips non-null billing/profile and non-default provider/role/transport', () => {
    const original = facts({
      provider: 'openrouter',
      transport: 'openrouter-proxy',
      role: 'subagent',
      credentialSource: 'openrouter-oauth-token',
      billingSource: 'pool',
      profileId: 'profile-7',
    });
    const result = verifyRouteFacts(signRouteFacts(original, SECRET), SECRET);
    expect(result).toEqual({ ok: true, facts: original });
  });

  it('tamper detection: flipping a fact in the payload → bad-signature', () => {
    // Sign the real facts, then splice the payload of a DIFFERENT-facts carrier onto
    // the original MAC (simulating an attacker editing a fact but keeping the old MAC).
    const realCarrier = signRouteFacts(facts(), SECRET);
    const tamperedCarrier = signRouteFacts(facts({ credentialSource: 'mindstone-managed-key' }), SECRET);
    const [, , realMac] = realCarrier.split('.');
    const [scheme, tamperedPayload] = tamperedCarrier.split('.');
    const forged = `${scheme}.${tamperedPayload}.${realMac}`;
    expect(verifyRouteFacts(forged, SECRET)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('wrong key → bad-signature (cannot verify a carrier signed under a different secret)', () => {
    const carrier = signRouteFacts(facts(), SECRET);
    expect(verifyRouteFacts(carrier, 'a-different-secret')).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('absent carrier → absent', () => {
    expect(verifyRouteFacts(null, SECRET)).toEqual({ ok: false, reason: 'absent' });
    expect(verifyRouteFacts(undefined, SECRET)).toEqual({ ok: false, reason: 'absent' });
    expect(verifyRouteFacts('', SECRET)).toEqual({ ok: false, reason: 'absent' });
  });

  it('malformed carrier shapes → malformed', () => {
    expect(verifyRouteFacts('not-a-carrier', SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyRouteFacts('rf1.onlytwoparts', SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyRouteFacts('rf1..mac', SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyRouteFacts('rf1.payload.', SECRET)).toEqual({ ok: false, reason: 'malformed' });
    // foreign / older scheme prefix
    const carrier = signRouteFacts(facts(), SECRET);
    const [, payload, mac] = carrier.split('.');
    expect(verifyRouteFacts(`rf0.${payload}.${mac}`, SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyRouteFacts(`xx1.${payload}.${mac}`, SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('valid MAC over a non-facts payload → malformed (decode rejects, not silently coerced)', () => {
    // Sign an arbitrary non-facts JSON object with the real secret: MAC is valid but
    // the payload is not well-formed RouteTagFacts.
    const bogusPayload = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8').toString('base64url');
    const mac = createHmac('sha256', SECRET).update(bogusPayload, 'utf8').digest('base64url');
    expect(verifyRouteFacts(`rf${ROUTE_FACTS_SCHEME_VERSION}.${bogusPayload}.${mac}`, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('valid MAC over an unknown provider/role value → malformed (vocabulary enforced)', () => {
    const badRole = Buffer.from(
      JSON.stringify({
        routeId: 'turn-abc', provider: 'anthropic', transport: 'anthropic-direct',
        wireModelId: 'm', credentialSource: 'anthropic-api-key', billingSource: null,
        role: 'not-a-real-role', profileId: null,
      }),
      'utf8',
    ).toString('base64url');
    const mac = createHmac('sha256', SECRET).update(badRole, 'utf8').digest('base64url');
    expect(verifyRouteFacts(`rf${ROUTE_FACTS_SCHEME_VERSION}.${badRole}.${mac}`, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  // Sign an arbitrary facts-shaped object (with the REAL secret so the MAC is valid)
  // to exercise decodeFacts's vocabulary + consistency checks in isolation.
  function signRaw(obj: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
    const mac = createHmac('sha256', SECRET).update(payload, 'utf8').digest('base64url');
    return `rf${ROUTE_FACTS_SCHEME_VERSION}.${payload}.${mac}`;
  }
  const wellFormed = {
    routeId: 'turn-abc', provider: 'anthropic', transport: 'anthropic-direct',
    wireModelId: 'm', credentialSource: 'anthropic-api-key', billingSource: 'pay-per-use',
    role: 'execution', profileId: null,
  };

  it('valid MAC over an unknown TRANSPORT → malformed (transport vocabulary enforced)', () => {
    expect(verifyRouteFacts(signRaw({ ...wellFormed, transport: 'not-a-transport' }), SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('valid MAC over an unknown CREDENTIAL SOURCE → malformed (credentialSource vocabulary enforced)', () => {
    expect(verifyRouteFacts(signRaw({ ...wellFormed, credentialSource: 'not-a-credential' }), SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('valid MAC over an unknown BILLING SOURCE → malformed (billingSource vocabulary enforced)', () => {
    expect(verifyRouteFacts(signRaw({ ...wellFormed, billingSource: 'not-a-billing-axis' }), SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('billingSource INCONSISTENT with credentialSource → malformed (managed-key must not carry "pool")', () => {
    // mindstone-managed-key bills as `subscription` (billingSourceForCredentialSource);
    // a carrier claiming managed-key + `pool` is internally inconsistent → rejected.
    expect(
      verifyRouteFacts(
        signRaw({ ...wellFormed, credentialSource: 'mindstone-managed-key', billingSource: 'pool' }),
        SECRET,
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('billingSource CONSISTENT with credentialSource → ok (managed-key + subscription)', () => {
    const result = verifyRouteFacts(
      signRaw({ ...wellFormed, credentialSource: 'mindstone-managed-key', billingSource: 'subscription' }),
      SECRET,
    );
    expect(result.ok).toBe(true);
  });

  it('billingSource = null is always permitted (terminal/missing sources carry no billing identity)', () => {
    const result = verifyRouteFacts(
      signRaw({ ...wellFormed, credentialSource: 'missing-anthropic', billingSource: null }),
      SECRET,
    );
    expect(result.ok).toBe(true);
  });

  it('the secret is NEVER embedded in the carrier', () => {
    const carrier = signRouteFacts(facts(), SECRET);
    expect(carrier).not.toContain(SECRET);
    // and the decoded payload likewise carries only facts, not the key
    const [, payload] = carrier.split('.');
    expect(Buffer.from(payload, 'base64url').toString('utf8')).not.toContain(SECRET);
  });
});
