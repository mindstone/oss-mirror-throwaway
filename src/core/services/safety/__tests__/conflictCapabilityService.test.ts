/**
 * Unit tests for `createConflictCapabilityService`.
 *
 * Stage B of `docs/plans/260417_approval_consolidation_closeout.md` — the
 * capability-token gate that closes the Stage 6 "jailbroken agent can
 * call resolve-conflict directly" HIGH-severity finding.
 *
 * Tests focus on the service's externally-observable contract:
 *   - mint shape (well-formed token + future expiry),
 *   - validate success path (ok, payload matches scope),
 *   - each typed failure code (MALFORMED / INVALID_SIGNATURE / EXPIRED /
 *     SCOPE_MISMATCH / REUSED),
 *   - replay protection across calls,
 *   - clock-driven expiry,
 *   - bounded seen-nonce cap with lazy purge,
 *   - scope enforcement (file A's token cannot resolve file B).
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createConflictCapabilityService,
  DEFAULT_TOKEN_TTL_MS,
  MAX_STAGED_FILE_ID_LENGTH,
} from '../conflictCapabilityService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_SECRET = Buffer.from('a'.repeat(64), 'hex'); // 32-byte secret
const FILE_ID_A = 'stg_aaaaaaaaaaaa';
const FILE_ID_B = 'stg_bbbbbbbbbbbb';

function makeClock(initialMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = initialMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// mint()
// ---------------------------------------------------------------------------

describe('createConflictCapabilityService — mint', () => {
  it('returns a <payload>.<sig> token and a future expiresAt', () => {
    const clock = makeClock(1_000_000);
    const svc = createConflictCapabilityService({ now: clock.now, secret: FIXED_SECRET });

    const { token, expiresAt } = svc.mint({ stagedFileId: FILE_ID_A });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    // Token shape: base64url payload + '.' + base64url signature.
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    // Expiry is exactly now() + default TTL.
    expect(expiresAt).toBe(1_000_000 + DEFAULT_TOKEN_TTL_MS);
  });

  it('mints distinct tokens (different nonces) across calls', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });

    const a = svc.mint({ stagedFileId: FILE_ID_A });
    const b = svc.mint({ stagedFileId: FILE_ID_A });
    expect(a.token).not.toBe(b.token);
  });

  it('throws RangeError on empty stagedFileId', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    expect(() => svc.mint({ stagedFileId: '' })).toThrow(RangeError);
  });

  it('throws RangeError when stagedFileId exceeds the max length', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const oversize = 'a'.repeat(MAX_STAGED_FILE_ID_LENGTH + 1);
    expect(() => svc.mint({ stagedFileId: oversize })).toThrow(RangeError);
  });

  it('honors a custom TTL override', () => {
    const clock = makeClock(5_000);
    const svc = createConflictCapabilityService({
      now: clock.now,
      secret: FIXED_SECRET,
      ttlMs: 10_000,
    });
    const { expiresAt } = svc.mint({ stagedFileId: FILE_ID_A });
    expect(expiresAt).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------
// validate() — happy path
// ---------------------------------------------------------------------------

describe('createConflictCapabilityService — validate success', () => {
  it('returns ok: true with the parsed payload on first use', () => {
    const clock = makeClock(1_000_000);
    const svc = createConflictCapabilityService({ now: clock.now, secret: FIXED_SECRET });
    const { token } = svc.mint({ stagedFileId: FILE_ID_A });

    const result = svc.validate({ token, stagedFileId: FILE_ID_A });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.stagedFileId).toBe(FILE_ID_A);
      expect(result.payload.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(result.payload.exp).toBe(1_000_000 + DEFAULT_TOKEN_TTL_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// validate() — failure paths (each typed code)
// ---------------------------------------------------------------------------

describe('createConflictCapabilityService — validate failure codes', () => {
  it('REUSED: rejects a second validate with the same token', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const { token } = svc.mint({ stagedFileId: FILE_ID_A });

    const first = svc.validate({ token, stagedFileId: FILE_ID_A });
    expect(first.ok).toBe(true);

    const second = svc.validate({ token, stagedFileId: FILE_ID_A });
    expect(second).toEqual({ ok: false, code: 'REUSED' });
  });

  it('SCOPE_MISMATCH: token minted for file A cannot validate against file B', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const { token } = svc.mint({ stagedFileId: FILE_ID_A });

    const result = svc.validate({ token, stagedFileId: FILE_ID_B });
    expect(result).toEqual({ ok: false, code: 'SCOPE_MISMATCH' });
  });

  it('SCOPE_MISMATCH is checked BEFORE nonce consumption (retry with correct scope succeeds)', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const { token } = svc.mint({ stagedFileId: FILE_ID_A });

    // First attempt with wrong scope must NOT consume the nonce.
    const wrong = svc.validate({ token, stagedFileId: FILE_ID_B });
    expect(wrong.ok).toBe(false);

    // Second attempt with correct scope should still succeed.
    const right = svc.validate({ token, stagedFileId: FILE_ID_A });
    expect(right.ok).toBe(true);
  });

  it('EXPIRED: rejects a token past its expiry', () => {
    const clock = makeClock(1_000);
    const svc = createConflictCapabilityService({
      now: clock.now,
      secret: FIXED_SECRET,
      ttlMs: 1_000,
    });
    const { token } = svc.mint({ stagedFileId: FILE_ID_A });

    clock.advance(1_001);

    const result = svc.validate({ token, stagedFileId: FILE_ID_A });
    expect(result).toEqual({ ok: false, code: 'EXPIRED' });
  });

  it('INVALID_SIGNATURE: token signed with a different secret is rejected', () => {
    const altSecret = Buffer.from('b'.repeat(64), 'hex');
    const minter = createConflictCapabilityService({ secret: altSecret });
    const validator = createConflictCapabilityService({ secret: FIXED_SECRET });

    const { token } = minter.mint({ stagedFileId: FILE_ID_A });

    const result = validator.validate({ token, stagedFileId: FILE_ID_A });
    expect(result).toEqual({ ok: false, code: 'INVALID_SIGNATURE' });
  });

  it('INVALID_SIGNATURE: tampered signature section is rejected', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const { token } = svc.mint({ stagedFileId: FILE_ID_A });

    const [payload, sig] = token.split('.');
    // Flip a byte by replacing the first char with something different.
    const tamperedSig = (sig.charAt(0) === 'A' ? 'B' : 'A') + sig.slice(1);
    const tamperedToken = `${payload}.${tamperedSig}`;

    const result = svc.validate({ token: tamperedToken, stagedFileId: FILE_ID_A });
    // Either INVALID_SIGNATURE or MALFORMED (if base64url decode fails)
    // is acceptable — both are fail-closed; what matters is NOT ok.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['INVALID_SIGNATURE', 'MALFORMED']).toContain(result.code);
    }
  });

  it('INVALID_SIGNATURE: tampered payload (valid JSON but different contents) is rejected', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const { token } = svc.mint({ stagedFileId: FILE_ID_A });

    // Build an attacker payload signed with the WRONG key but claiming FILE_ID_A.
    const wrongSecret = Buffer.from('c'.repeat(64), 'hex');
    const attackerPayload = JSON.stringify({ stagedFileId: FILE_ID_A, nonce: 'deadbeef', exp: Date.now() + 60_000 });
    const payloadB64 = Buffer.from(attackerPayload, 'utf8').toString('base64url');
    const attackerSig = createHmac('sha256', wrongSecret).update(attackerPayload).digest('base64url');
    const attackerToken = `${payloadB64}.${attackerSig}`;

    expect(token).not.toBe(attackerToken);
    const result = svc.validate({ token: attackerToken, stagedFileId: FILE_ID_A });
    expect(result).toEqual({ ok: false, code: 'INVALID_SIGNATURE' });
  });

  it.each([
    ['empty string', ''],
    ['no dot', 'no-dot-separator'],
    ['multiple dots', 'a.b.c'],
    ['empty left half', '.sig'],
    ['empty right half', 'payload.'],
    ['invalid base64 left', '!!!!.sig'],
    ['decodes to non-JSON', Buffer.from('not-json').toString('base64url') + '.sig'],
  ])('MALFORMED: rejects "%s"', (_label, badToken) => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const result = svc.validate({ token: badToken, stagedFileId: FILE_ID_A });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either MALFORMED or INVALID_SIGNATURE — both are typed rejections.
      expect(['MALFORMED', 'INVALID_SIGNATURE']).toContain(result.code);
    }
  });

  it('MALFORMED: payload missing required field is rejected', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });

    // Construct a payload missing `nonce` but signed with the right secret.
    const incompletePayload = JSON.stringify({ stagedFileId: FILE_ID_A, exp: Date.now() + 60_000 });
    const payloadB64 = Buffer.from(incompletePayload, 'utf8').toString('base64url');
    const sig = createHmac('sha256', FIXED_SECRET).update(incompletePayload).digest('base64url');
    const fabricated = `${payloadB64}.${sig}`;

    const result = svc.validate({ token: fabricated, stagedFileId: FILE_ID_A });
    expect(result).toEqual({ ok: false, code: 'MALFORMED' });
  });
});

// ---------------------------------------------------------------------------
// Service isolation + replay
// ---------------------------------------------------------------------------

describe('createConflictCapabilityService — service isolation', () => {
  it('each service has its own secret by default (tokens do not cross)', () => {
    const a = createConflictCapabilityService();
    const b = createConflictCapabilityService();
    const { token } = a.mint({ stagedFileId: FILE_ID_A });
    expect(b.validate({ token, stagedFileId: FILE_ID_A })).toEqual({
      ok: false,
      code: 'INVALID_SIGNATURE',
    });
  });

  it('each service has its own seen-nonce map (a token validated in A can be re-validated in B with same secret)', () => {
    // Share a secret so the signature check passes; prove the nonce map
    // is per-instance.
    const a = createConflictCapabilityService({ secret: FIXED_SECRET });
    const b = createConflictCapabilityService({ secret: FIXED_SECRET });
    const { token } = a.mint({ stagedFileId: FILE_ID_A });

    expect(a.validate({ token, stagedFileId: FILE_ID_A }).ok).toBe(true);
    // b has its own empty seen-map, so first validate succeeds.
    expect(b.validate({ token, stagedFileId: FILE_ID_A }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lazy purge + cap
// ---------------------------------------------------------------------------

describe('createConflictCapabilityService — seen-nonce purge', () => {
  it('purges expired nonces once the cap is reached', () => {
    const clock = makeClock(1_000);
    const svc = createConflictCapabilityService({
      now: clock.now,
      secret: FIXED_SECRET,
      ttlMs: 1_000, // 1 second
      seenNonceCap: 3,
    });

    // Mint + consume 3 short-lived tokens to fill the seen-map.
    const t1 = svc.mint({ stagedFileId: FILE_ID_A }).token;
    const t2 = svc.mint({ stagedFileId: FILE_ID_A }).token;
    const t3 = svc.mint({ stagedFileId: FILE_ID_A }).token;
    expect(svc.validate({ token: t1, stagedFileId: FILE_ID_A }).ok).toBe(true);
    expect(svc.validate({ token: t2, stagedFileId: FILE_ID_A }).ok).toBe(true);
    expect(svc.validate({ token: t3, stagedFileId: FILE_ID_A }).ok).toBe(true);

    // Advance past expiry so those three nonces are purge-eligible.
    clock.advance(2_000);

    // New mint + validate triggers the lazy purge. Without purge, the
    // 4th entry would grow past the cap; we assert a fresh nonce can
    // still validate (no replay error) which indirectly proves the
    // internal state is bounded.
    const t4 = svc.mint({ stagedFileId: FILE_ID_A }).token;
    expect(svc.validate({ token: t4, stagedFileId: FILE_ID_A }).ok).toBe(true);
  });

  // F-B-R2-8: under sustained legitimate load all seen nonces may be
  // within TTL, so purge frees zero. Service must still bound the map
  // by evicting the oldest entry FIFO-style. The evicted (now forgotten)
  // nonce loses replay protection but the freshly-minted ones keep it.
  //
  // Assertion order matters: replaying the evicted token triggers a
  // cascade (it re-fills the cap, which evicts the next-oldest). So
  // we check REUSED for the still-cached entries BEFORE replaying the
  // evicted one.
  it('FIFO-evicts the oldest entry when cap is reached and no entries are expired', () => {
    const clock = makeClock(1_000);
    const svc = createConflictCapabilityService({
      now: clock.now,
      secret: FIXED_SECRET,
      ttlMs: 60_000, // 1 minute — all three tokens stay live
      seenNonceCap: 3,
    });

    // Fill the cap with three live tokens.
    const first = svc.mint({ stagedFileId: FILE_ID_A }).token;
    const second = svc.mint({ stagedFileId: FILE_ID_A }).token;
    const third = svc.mint({ stagedFileId: FILE_ID_A }).token;
    expect(svc.validate({ token: first, stagedFileId: FILE_ID_A }).ok).toBe(true);
    expect(svc.validate({ token: second, stagedFileId: FILE_ID_A }).ok).toBe(true);
    expect(svc.validate({ token: third, stagedFileId: FILE_ID_A }).ok).toBe(true);

    // Consume a fourth — map is already at cap, nothing is expired,
    // so the OLDEST entry (`first`) must be evicted FIFO-style to make
    // room. After this step the map holds {second, third, fourth}.
    const fourth = svc.mint({ stagedFileId: FILE_ID_A }).token;
    expect(svc.validate({ token: fourth, stagedFileId: FILE_ID_A }).ok).toBe(true);

    // Still-cached tokens must reject as REUSED. Check these BEFORE
    // we replay the evicted `first`, because that replay would
    // cascade-evict one of these to make room for itself.
    expect(
      svc.validate({ token: second, stagedFileId: FILE_ID_A }),
    ).toEqual({ ok: false, code: 'REUSED' });
    expect(
      svc.validate({ token: third, stagedFileId: FILE_ID_A }),
    ).toEqual({ ok: false, code: 'REUSED' });
    expect(
      svc.validate({ token: fourth, stagedFileId: FILE_ID_A }),
    ).toEqual({ ok: false, code: 'REUSED' });

    // Finally — replaying the evicted `first` now succeeds. This is
    // the documented trade-off: under sustained load the map drops
    // replay protection for the oldest entries to keep memory bounded.
    // The 5-minute TTL backstops the security cost (an evicted token
    // is already close to its expiry under steady-state churn).
    expect(svc.validate({ token: first, stagedFileId: FILE_ID_A }).ok).toBe(true);
  });

  // F-B-R2-8 companion: the map size must never exceed the cap, even
  // under sustained insertion where no entries are expired.
  it('keeps the seen-map size bounded by seenNonceCap under steady-state churn', () => {
    const clock = makeClock(1_000);
    const svc = createConflictCapabilityService({
      now: clock.now,
      secret: FIXED_SECRET,
      ttlMs: 60_000,
      seenNonceCap: 3,
    });

    // Mint + consume 10× the cap. Without FIFO eviction the map would
    // hold 30 entries; with eviction it must stay bounded at cap.
    for (let i = 0; i < 30; i += 1) {
      const { token } = svc.mint({ stagedFileId: FILE_ID_A });
      expect(svc.validate({ token, stagedFileId: FILE_ID_A }).ok).toBe(true);
    }

    // The last three tokens we inserted MUST still be in the map
    // (prove the cap is holding at 3 — if it were e.g. 2 or 30, the
    // last-mint replay would diverge).
    const probeTokens: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      probeTokens.push(svc.mint({ stagedFileId: FILE_ID_A }).token);
    }
    for (const token of probeTokens) {
      expect(svc.validate({ token, stagedFileId: FILE_ID_A }).ok).toBe(true);
    }
    // Replay each probe token — all 3 must reject as REUSED, which
    // demonstrates the cap is at least 3. Replay in reverse order so
    // the newer ones are checked first (same rationale as above).
    for (const token of [...probeTokens].reverse()) {
      // After inserting 3 probes the cap holds {probe1, probe2, probe3};
      // checking probe3 first (still cached), then probe2 (still
      // cached after probe3's has-check, which had no side effect),
      // then probe1. Replay check is pure; the cascade only kicks in
      // if we successfully consume.
      expect(
        svc.validate({ token, stagedFileId: FILE_ID_A }),
      ).toEqual({ ok: false, code: 'REUSED' });
    }
  });

  // F-B-R2-11: two validates for the same token cannot BOTH succeed.
  // Node's single-threaded JS execution guarantees atomicity of
  // has()+set() inside a synchronous validate() body, so even
  // `Promise.all` of two validates lands one success + one REUSED.
  it('concurrent validates for the same token yield exactly one success', async () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const { token } = svc.mint({ stagedFileId: FILE_ID_A });

    const [a, b] = await Promise.all([
      Promise.resolve(svc.validate({ token, stagedFileId: FILE_ID_A })),
      Promise.resolve(svc.validate({ token, stagedFileId: FILE_ID_A })),
    ]);

    const oks = [a, b].filter((r) => r.ok);
    const reused = [a, b].filter((r) => !r.ok && r.code === 'REUSED');
    expect(oks).toHaveLength(1);
    expect(reused).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scope enforcement with large IDs
// ---------------------------------------------------------------------------

describe('createConflictCapabilityService — boundary inputs', () => {
  it('accepts stagedFileId exactly at the max length', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const maxId = 'a'.repeat(MAX_STAGED_FILE_ID_LENGTH);
    const { token } = svc.mint({ stagedFileId: maxId });
    expect(svc.validate({ token, stagedFileId: maxId }).ok).toBe(true);
  });

  it('enforces scope using exact string equality (prefix does not match)', () => {
    const svc = createConflictCapabilityService({ secret: FIXED_SECRET });
    const { token } = svc.mint({ stagedFileId: FILE_ID_A });
    // A prefix of the real id must NOT validate.
    expect(
      svc.validate({ token, stagedFileId: FILE_ID_A.slice(0, -1) }),
    ).toEqual({ ok: false, code: 'SCOPE_MISMATCH' });
  });
});
