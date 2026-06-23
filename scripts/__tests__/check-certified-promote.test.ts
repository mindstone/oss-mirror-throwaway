import { describe, expect, it } from 'vitest';

import {
  isCertifiedPromote,
  parseCertifiedPromoteArgs,
  runCertifiedPromoteCli,
  type CertifiedPromoteInputs,
} from '../check-certified-promote';

const PREV_MAIN = '1111111111111111111111111111111111111111';
const PUSHED = '2222222222222222222222222222222222222222';
const DEV_TIP = '3333333333333333333333333333333333333333';

function baseInputs(overrides: Partial<CertifiedPromoteInputs> = {}): CertifiedPromoteInputs {
  return {
    isProduction: true,
    certifiedShaEnv: PUSHED,
    pushedOid: PUSHED,
    prevOid: PREV_MAIN,
    isAncestor: (ancestor, descendant) => (
      (ancestor === PREV_MAIN && descendant === PUSHED)
      || (ancestor === PUSHED && descendant === DEV_TIP)
    ),
    resolveFreshDevTip: () => DEV_TIP,
    ...overrides,
  };
}

describe('isCertifiedPromote', () => {
  it('returns true for a certified production promote', () => {
    expect(isCertifiedPromote(baseInputs())).toBe(true);
  });

  it('returns false for a fresh main hotfix with no marker', () => {
    expect(isCertifiedPromote(baseInputs({ certifiedShaEnv: undefined }))).toBe(false);
  });

  it('returns false when the marker does not match the pushed oid', () => {
    expect(isCertifiedPromote(baseInputs({ certifiedShaEnv: DEV_TIP }))).toBe(false);
  });

  it('returns false when the fresh dev tip cannot be resolved', () => {
    expect(isCertifiedPromote(baseInputs({ resolveFreshDevTip: () => undefined }))).toBe(false);
  });

  it('returns false when the push is not a fast-forward of current main', () => {
    expect(isCertifiedPromote(baseInputs({
      isAncestor: (ancestor, descendant) => ancestor === PUSHED && descendant === DEV_TIP,
    }))).toBe(false);
  });

  it('returns false for branch creation', () => {
    expect(isCertifiedPromote(baseInputs({ prevOid: '0000000000000000000000000000000000000000' }))).toBe(false);
  });

  it.each([
    ['whitespace', `${PUSHED} `],
    ['wrong length', '222222222222222222222222222222222222222'],
    ['non-hex', 'gggggggggggggggggggggggggggggggggggggggg'],
  ])('returns false when the pushed oid is malformed: %s', (_label, pushedOid) => {
    expect(isCertifiedPromote(baseInputs({
      certifiedShaEnv: pushedOid,
      pushedOid,
    }))).toBe(false);
  });

  it.each([
    ['whitespace', `${PUSHED} `],
    ['wrong length', '222222222222222222222222222222222222222'],
    ['non-hex', 'gggggggggggggggggggggggggggggggggggggggg'],
  ])('returns false when the certified marker is malformed: %s', (_label, certifiedShaEnv) => {
    expect(isCertifiedPromote(baseInputs({
      certifiedShaEnv,
      pushedOid: certifiedShaEnv,
    }))).toBe(false);
  });

  it.each([
    ['whitespace', `${PREV_MAIN} `],
    ['wrong length', '111111111111111111111111111111111111111'],
    ['non-hex', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'],
  ])('returns false when the previous main oid is malformed: %s', (_label, prevOid) => {
    expect(isCertifiedPromote(baseInputs({ prevOid }))).toBe(false);
  });

  it('returns false outside production', () => {
    expect(isCertifiedPromote(baseInputs({ isProduction: false }))).toBe(false);
  });

  it('returns false when an injected git predicate throws', () => {
    expect(isCertifiedPromote(baseInputs({
      isAncestor: () => {
        throw new Error('git failed');
      },
    }))).toBe(false);
  });
});

describe('parseCertifiedPromoteArgs', () => {
  it('parses the hook arguments and defaults remote to origin', () => {
    expect(parseCertifiedPromoteArgs([
      '--is-production',
      '--pushed-oid',
      PUSHED,
      '--prev-oid',
      PREV_MAIN,
    ])).toEqual({
      isProduction: true,
      pushedOid: PUSHED,
      prevOid: PREV_MAIN,
      remote: 'origin',
    });
  });

  it('accepts an explicit remote', () => {
    expect(parseCertifiedPromoteArgs(['--remote', 'upstream'])).toMatchObject({
      remote: 'upstream',
    });
  });
});

describe('runCertifiedPromoteCli', () => {
  it('returns exit code 0 when the CLI inputs classify as certified', () => {
    const result = runCertifiedPromoteCli({
      env: { REBEL_CERTIFIED_PROMOTE_SHA: PUSHED },
      argv: ['--is-production', '--pushed-oid', PUSHED, '--prev-oid', PREV_MAIN, '--remote', 'origin'],
      isAncestor: (ancestor, descendant) => (
        (ancestor === PREV_MAIN && descendant === PUSHED)
        || (ancestor === PUSHED && descendant === DEV_TIP)
      ),
      resolveFreshDevTip: (remote) => (remote === 'origin' ? DEV_TIP : undefined),
    });

    expect(result).toEqual({ exitCode: 0, reason: 'certified promote verified' });
  });

  it('fails safe with exit code 1 when a dependency throws', () => {
    const result = runCertifiedPromoteCli({
      env: { REBEL_CERTIFIED_PROMOTE_SHA: PUSHED },
      argv: ['--is-production', '--pushed-oid', PUSHED, '--prev-oid', PREV_MAIN],
      isAncestor: () => {
        throw new Error('boom');
      },
      resolveFreshDevTip: () => DEV_TIP,
    });

    expect(result.exitCode).toBe(1);
  });
});
