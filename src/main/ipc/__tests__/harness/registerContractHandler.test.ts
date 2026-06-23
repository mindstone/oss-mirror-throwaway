/**
 * Stage-2 DoD tests for the dev/test-gated contract-parse seam decorator.
 *
 * Asserts the seam's four load-bearing behaviours:
 *  1. Gate ON (NODE_ENV==='test'): malformed input → ZodError BEFORE the body;
 *     contract-violating response → ZodError AFTER the body.
 *  2. Gate OFF (prod-simulated: NODE_ENV/REBEL_CONTRACT_ENFORCE unset): the
 *     identical registration + invoke is an untouched no-op pass — the explicit
 *     "ships disabled in prod" proof.
 *  3. The decorator ALWAYS runs the real body — NO body-skip. A side-effecting
 *     channel (NOT on the harness EXECUTE_SAFE allowlist) under plain
 *     NODE_ENV==='test' still runs its real body here (spy-proven). The body-skip
 *     for non-EXECUTE_SAFE channels lives in the Stage-5 DRIVER, not this seam.
 *  4. A channel not in `allChannels` registers unwrapped without error.
 *
 * The seam is exercised THROUGH the real `registerHandler` chokepoint so the
 * production wiring (not just the helper in isolation) is under test.
 */

import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { feedbackChannels } from '@shared/ipc/channels/feedback';
import { MapHandlerRegistry } from '@core/handlerRegistry/mapHandlerRegistry';
import { setHandlerRegistry, getHandlerRegistry } from '@core/handlerRegistry';

import { registerHandler } from '../../utils/registerHandler';
import {
  isContractEnforcementOn,
  wrapHandlerWithContractParse,
  isExecuteSafe,
} from '../../utils/registerContractHandler';

const RATE_CHANNEL = feedbackChannels['feedback:conversation-rate'].channel; // 'feedback:conversation-rate'

const VALID_RATE_REQUEST = {
  sessionId: 'session-x',
  rating: 4, // ConversationVoteRatingSchema = z.number().int().min(1).max(5)
  comment: 'great',
  chips: [], // chips are strings
};

const VALID_RATE_RESPONSE = {
  success: true,
  voteId: 'vote-123',
};

beforeEach(() => {
  setHandlerRegistry(new MapHandlerRegistry());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('isContractEnforcementOn (fail-safe-off gate)', () => {
  it('is ON under NODE_ENV==="test"', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
    expect(isContractEnforcementOn()).toBe(true);
  });

  it('is ON via the allowlisted opt-in flag ONLY under an explicit development env', () => {
    // The flag requires a POSITIVE 'development' signal — not merely "!== production".
    vi.stubEnv('NODE_ENV', 'development');
    for (const v of ['1', 'true', 'TRUE', ' true ']) {
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', v);
      expect(isContractEnforcementOn()).toBe(true);
    }
  });

  it('KILL-BY-CONSTRUCTION: production + opt-in flag → OFF (no prod-enforce backdoor pre-shape-B)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const v of ['1', 'true', 'TRUE']) {
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', v);
      expect(isContractEnforcementOn()).toBe(false);
    }
  });

  it('KILL-BY-CONSTRUCTION: unset NODE_ENV (packaged-prod default) + opt-in flag → OFF', () => {
    // Packaged Electron leaves NODE_ENV UNSET (neither 'production' nor
    // 'development'). A "!== production" gate would wrongly let the flag flip
    // enforcement ON here — the regression this test guards. We require a
    // positive 'development'/'test' signal, so the packaged-prod default cannot
    // be flipped on by REBEL_CONTRACT_ENFORCE.
    vi.stubEnv('NODE_ENV', undefined as unknown as string);
    for (const v of ['1', 'true', 'TRUE', ' true ']) {
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', v);
      expect(isContractEnforcementOn()).toBe(false);
    }
  });

  it('is OFF for unset / unknown env with no enabling flag (fail-safe default)', () => {
    // Truly unset NODE_ENV + unset flag — the packaged-prod default.
    vi.stubEnv('NODE_ENV', undefined as unknown as string);
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', undefined as unknown as string);
    expect(isContractEnforcementOn()).toBe(false);

    vi.stubEnv('NODE_ENV', 'development');
    expect(isContractEnforcementOn()).toBe(false);

    vi.stubEnv('NODE_ENV', 'staging-unknown');
    expect(isContractEnforcementOn()).toBe(false);
  });

  it('treats ambiguous / falsy flag values as OFF (normalize-then-allowlist)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const v of ['', ' ', '0', '0 ', 'false', 'FALSE', 'off', 'no']) {
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', v);
      expect(isContractEnforcementOn()).toBe(false);
    }
  });
});

describe('seam enforcement ON (NODE_ENV==="test")', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
  });

  it('throws ZodError on a malformed request BEFORE the body runs', async () => {
    const body = vi.fn().mockResolvedValue(VALID_RATE_RESPONSE);
    registerHandler(RATE_CHANNEL, body);
    const handler = getHandlerRegistry().get(RATE_CHANNEL)!;

    // Missing required `comment` → request.parse rejects at the seam.
    const malformed = { sessionId: 's', rating: 4, chips: [] };
    await expect(handler(null, malformed)).rejects.toBeInstanceOf(ZodError);
    expect(body).not.toHaveBeenCalled(); // proves it threw BEFORE the body
  });

  it('throws ZodError on a contract-violating response AFTER the body runs', async () => {
    // Body returns a response missing the required `voteId` → response.parse rejects.
    const body = vi.fn().mockResolvedValue({ success: true });
    registerHandler(RATE_CHANNEL, body);
    const handler = getHandlerRegistry().get(RATE_CHANNEL)!;

    await expect(handler(null, VALID_RATE_REQUEST)).rejects.toBeInstanceOf(ZodError);
    expect(body).toHaveBeenCalledTimes(1); // proves the body DID run (parse is after)
  });

  it('passes a valid request/response round-trip through unchanged', async () => {
    const body = vi.fn().mockResolvedValue(VALID_RATE_RESPONSE);
    registerHandler(RATE_CHANNEL, body);
    const handler = getHandlerRegistry().get(RATE_CHANNEL)!;

    const result = await handler(null, VALID_RATE_REQUEST);
    expect(result).toEqual(VALID_RATE_RESPONSE);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('ALWAYS runs the real body — no body-skip, even for a side-effecting (non-EXECUTE_SAFE) channel', async () => {
    // Pick a side-effecting write channel that is deliberately NOT on the harness
    // EXECUTE_SAFE allowlist — the Stage-5 DRIVER would stub it, but this global
    // seam decorator NEVER does (it only parses around the REAL body — Stage 2).
    const writeChannel = 'library:write-file';
    expect(isExecuteSafe(writeChannel)).toBe(false);
    const body = vi.fn().mockResolvedValue({ result: 'ok', path: 'a.md' });
    registerHandler(writeChannel, body);
    const handler = getHandlerRegistry().get(writeChannel)!;

    await handler(null, { path: 'a.md', content: 'hello' });
    expect(body).toHaveBeenCalledTimes(1); // the real body ran — no stub/skip here
  });
});

describe('seam enforcement OFF (production-simulated) — ships disabled in prod', () => {
  beforeEach(() => {
    // Simulate prod: neither the test env nor the opt-in flag is set.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
  });

  it('is an untouched no-op pass for the IDENTICAL registration + invoke', async () => {
    // Same channel + same registration as the gate-ON malformed test, but the
    // gate is off → the malformed request flows straight to the body, no parse.
    const malformed = { sessionId: 's', rating: 'up', chips: [] };
    const body = vi.fn().mockResolvedValue({ anything: 'goes', notAContract: true });
    registerHandler(RATE_CHANNEL, body);
    const handler = getHandlerRegistry().get(RATE_CHANNEL)!;

    // No ZodError on a malformed request; no ZodError on a non-contract response.
    const result = await handler(null, malformed);
    expect(body).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledWith(null, malformed); // args passed through verbatim
    expect(result).toEqual({ anything: 'goes', notAContract: true });
  });

  it('wrapHandlerWithContractParse returns the SAME handler reference when off', () => {
    const body = vi.fn();
    const wrapped = wrapHandlerWithContractParse(RATE_CHANNEL, body);
    // Fail-safe-off: known channel, gate off → identical reference (true no-op).
    expect(wrapped).toBe(body);
  });
});

describe('channels absent from allChannels', () => {
  it('registers unwrapped without error (gate ON)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const unknownChannel = 'not-a-real:contract-channel';
    const body = vi.fn().mockResolvedValue({ raw: 'value', fn: undefined });

    expect(() => registerHandler(unknownChannel, body)).not.toThrow();
    const handler = getHandlerRegistry().get(unknownChannel)!;

    // No contract → no parse → a non-contract response flows through untouched.
    const result = await handler(null, { whatever: true });
    expect(body).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ raw: 'value', fn: undefined });
  });

  it('wrapHandlerWithContractParse returns the SAME reference for an unknown channel', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const body = vi.fn();
    const wrapped = wrapHandlerWithContractParse('still-not:a-channel', body);
    expect(wrapped).toBe(body); // unwrapped — never throws, never wraps
  });
});
