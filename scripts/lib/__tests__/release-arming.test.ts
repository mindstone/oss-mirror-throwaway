import { describe, expect, it } from 'vitest';

import type { CandidateBinding, DispatchedBetaRun } from '../release-candidate-binding';
import {
  DEFAULT_ARMING_TTL_MS,
  NO_SOAK_NO_PAGING_RISK_ACCEPTANCE,
  verifyArming,
  type ReleaseArmingFlags,
  type VerifyArmingOptions,
} from '../release-arming';

// SAFETY: S-ARM is pure. Every test injects the clock and never touches git/gh/network/main.

const SHA = '428259cb83e22a32fdcc36bf538002f81fdd9fa8';
const OTHER_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOURCE_VERSION = '0.4.49';
const BETA_VERSION = '0.4.494282';
const NOW_ISO = '2026-06-21T12:00:00.000Z';
const ARMED_AT_ISO = '2026-06-21T06:00:00.000Z';

function releaseRun(overrides: Partial<DispatchedBetaRun> = {}): DispatchedBetaRun {
  return {
    runId: 27803427419,
    databaseId: 27803427419,
    event: 'workflow_dispatch',
    branch: 'dev',
    headSha: SHA,
    createdAt: '2026-06-21T12:02:00Z',
    status: 'completed',
    conclusion: 'success',
    displayTitle: 'Release Build and Publish',
    ...overrides,
  };
}

function binding(overrides: Partial<CandidateBinding> = {}): CandidateBinding {
  return {
    devHeadSha: SHA,
    releaseRun: releaseRun(),
    sourcePackageVersion: SOURCE_VERSION,
    betaPublishedVersion: BETA_VERSION,
    gcsManifestPath: 'https://storage.googleapis.com/mindstone-rebel/releases-beta/latest.json',
    ...overrides,
  };
}

function fullFlags(overrides: Partial<ReleaseArmingFlags> = {}): ReleaseArmingFlags {
  return {
    armProduction: true,
    candidateSha: SHA,
    confirmChangelogCurrent: SOURCE_VERSION,
    attestS8aGreenInCi: true,
    attestPolicySignedOff: true,
    acceptNoSoakNoPaging: true,
    ...overrides,
  };
}

function flagsWithUnknownOverrides(overrides: Record<string, unknown>): ReleaseArmingFlags {
  return {
    ...fullFlags(),
    ...overrides,
  } as unknown as ReleaseArmingFlags;
}

function fullFlagsWithExtraKeys(): ReleaseArmingFlags {
  const flags = Object.assign(Object.create(null), fullFlags(), {
    ignoredExtraKey: 'ignored',
  }) as ReleaseArmingFlags & Record<string, unknown>;

  Object.defineProperty(flags, '__proto__', {
    value: { armProduction: false, attestS8aGreenInCi: false },
    enumerable: true,
    configurable: true,
  });

  return flags;
}

function malformedBindingWithExtraKeys(): CandidateBinding {
  const malformedBinding = Object.assign(Object.create(null), binding(), {
    releaseRun: releaseRun({ headSha: '' }),
    ignoredExtraKey: 'ignored',
  }) as CandidateBinding & Record<string, unknown>;

  Object.defineProperty(malformedBinding, '__proto__', {
    value: { releaseRun: releaseRun({ headSha: SHA }) },
    enumerable: true,
    configurable: true,
  });

  return malformedBinding;
}

function deps(nowIso = NOW_ISO) {
  return { now: () => new Date(nowIso) };
}

function verify(overrides: VerifyArmingOptions = {}) {
  return verifyArming(deps(), {
    flags: fullFlags(),
    binding: binding(),
    armedAtIso: ARMED_AT_ISO,
    ...overrides,
  });
}

function expectNotArmedWithReason(result: ReturnType<typeof verifyArming>, expectedReason: string) {
  expect(result.armed).toBe(false);
  expect(result.reasons.join('\n')).toContain(expectedReason);
}

describe('verifyArming', () => {
  it('defaults to not armed when no flags are supplied', () => {
    const result = verifyArming(deps(), {
      binding: binding(),
      armedAtIso: ARMED_AT_ISO,
    });

    expect(result.armed).toBe(false);
    expect(result.reasons.join('\n')).toContain('Arming flags are absent or malformed.');
    expect(result.reasons.join('\n')).toContain('armProduction must be explicitly true.');
  });

  it('arms only when exact candidate flags, TTL, and all attestations agree', () => {
    const result = verify();

    expect(result).toEqual({
      armed: true,
      reasons: [],
      attestation: {
        attestS8aGreenInCi: true,
        attestPolicySignedOff: true,
        acceptNoSoakNoPaging: true,
        noSoakNoPagingRiskAcceptance: NO_SOAK_NO_PAGING_RISK_ACCEPTANCE,
        armedAtIso: ARMED_AT_ISO,
        evaluatedAtIso: NOW_ISO,
        expiresAtIso: '2026-06-21T18:00:00.000Z',
        ttlMs: DEFAULT_ARMING_TTL_MS,
        candidateSha: SHA,
        confirmChangelogCurrent: SOURCE_VERSION,
        boundCandidateSha: SHA,
        boundSourcePackageVersion: SOURCE_VERSION,
      },
    });
  });

  it('ignores extra flag keys, including an own __proto__ key, on a valid armed set', () => {
    const flags = fullFlagsWithExtraKeys();

    expect(Object.prototype.hasOwnProperty.call(flags, '__proto__')).toBe(true);

    const result = verify({ flags });

    expect(result.armed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it.each<[string, boolean | undefined]>([
    ['false', false],
    ['absent', undefined],
  ])('does not arm when armProduction is %s', (_label, armProduction) => {
    const result = verify({ flags: fullFlags({ armProduction }) });

    expectNotArmedWithReason(result, 'armProduction must be explicitly true.');
  });

  it.each<[string, unknown]>([
    ['string "true"', 'true'],
    ['number 1', 1],
    ['string "yes"', 'yes'],
  ])('does not coerce armProduction when set to %s', (_label, armProduction) => {
    const result = verify({ flags: flagsWithUnknownOverrides({ armProduction }) });

    expectNotArmedWithReason(result, 'armProduction must be explicitly true.');
    expect(result.attestation).toMatchObject({
      attestS8aGreenInCi: true,
      attestPolicySignedOff: true,
      acceptNoSoakNoPaging: true,
    });
  });

  it('does not arm when candidateSha differs from the frozen candidate head SHA', () => {
    const result = verify({ flags: fullFlags({ candidateSha: OTHER_SHA }) });

    expectNotArmedWithReason(result, 'candidateSha does not match the frozen candidate head SHA.');
  });

  it('does not arm when confirmChangelogCurrent differs from the source package version', () => {
    const result = verify({ flags: fullFlags({ confirmChangelogCurrent: BETA_VERSION }) });

    expectNotArmedWithReason(
      result,
      'confirmChangelogCurrent does not match the frozen source package version.'
    );
    expect(result.attestation.boundSourcePackageVersion).toBe(SOURCE_VERSION);
  });

  it('does not arm when the TTL has expired', () => {
    const result = verifyArming(deps('2026-06-21T12:00:01.001Z'), {
      flags: fullFlags(),
      binding: binding(),
      armedAtIso: '2026-06-21T12:00:00.000Z',
      ttlMs: 1_000,
    });

    expectNotArmedWithReason(result, 'Arming TTL has expired.');
  });

  it('arms at the exact TTL boundary', () => {
    const result = verifyArming(deps('2026-06-21T12:00:01.000Z'), {
      flags: fullFlags(),
      binding: binding(),
      armedAtIso: '2026-06-21T12:00:00.000Z',
      ttlMs: 1_000,
    });

    expect(result.armed).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.attestation.expiresAtIso).toBe('2026-06-21T12:00:01.000Z');
  });

  it.each<[string, Partial<ReleaseArmingFlags>, string]>([
    [
      'S8a merged and green in CI',
      { attestS8aGreenInCi: undefined },
      'S8a is merged and green in CI',
    ],
    [
      'policy/go-live sign-off',
      { attestPolicySignedOff: undefined },
      'policy/go-live sign-off is present',
    ],
    [
      'no-soak/no-paging risk acceptance',
      { acceptNoSoakNoPaging: undefined },
      'no-soak/no-paging risk clause',
    ],
  ])('does not arm when the %s attestation is missing', (_label, flagOverride, expectedReason) => {
    const result = verify({ flags: fullFlags(flagOverride) });

    expectNotArmedWithReason(result, expectedReason);
  });

  it.each<
    [
      'attestS8aGreenInCi' | 'attestPolicySignedOff' | 'acceptNoSoakNoPaging',
      unknown,
      string,
    ]
  >([
    ['attestS8aGreenInCi', 'true', 'S8a is merged and green in CI'],
    ['attestS8aGreenInCi', 1, 'S8a is merged and green in CI'],
    ['attestPolicySignedOff', 'true', 'policy/go-live sign-off is present'],
    ['attestPolicySignedOff', 1, 'policy/go-live sign-off is present'],
    ['acceptNoSoakNoPaging', 'true', 'no-soak/no-paging risk clause'],
    ['acceptNoSoakNoPaging', 1, 'no-soak/no-paging risk clause'],
  ])('does not coerce %s when set to %s', (flagName, value, expectedReason) => {
    const result = verify({ flags: flagsWithUnknownOverrides({ [flagName]: value }) });

    expectNotArmedWithReason(result, expectedReason);
    expect(result.attestation[flagName]).toBe(false);
  });

  it('records false attestations in the returned attestation object', () => {
    const result = verify({
      flags: fullFlags({
        attestS8aGreenInCi: false,
        attestPolicySignedOff: false,
        acceptNoSoakNoPaging: false,
      }),
    });

    expect(result.armed).toBe(false);
    expect(result.attestation).toMatchObject({
      attestS8aGreenInCi: false,
      attestPolicySignedOff: false,
      acceptNoSoakNoPaging: false,
      noSoakNoPagingRiskAcceptance: NO_SOAK_NO_PAGING_RISK_ACCEPTANCE,
    });
  });

  it.each<[string, VerifyArmingOptions]>([
    ['empty flags object', { flags: {} }],
    ['malformed flags value', { flags: [] as unknown as ReleaseArmingFlags }],
    ['missing binding', { binding: null }],
    [
      'binding without release head SHA',
      { binding: binding({ releaseRun: releaseRun({ headSha: '' }) }) },
    ],
    ['binding without source package version', { binding: binding({ sourcePackageVersion: '' }) }],
    ['malformed armedAtIso', { armedAtIso: 'not-a-date' }],
    ['empty armedAtIso', { armedAtIso: '' }],
    ['zero TTL', { ttlMs: 0 }],
    ['NaN TTL', { ttlMs: Number.NaN }],
  ])('fails closed on malformed input: %s', (_label, override) => {
    const result = verify(override);

    expect(result.armed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('does not let extra binding keys override a malformed frozen candidate binding', () => {
    const result = verify({
      flags: fullFlagsWithExtraKeys(),
      binding: malformedBindingWithExtraKeys(),
    });

    expectNotArmedWithReason(result, 'Candidate binding is absent or malformed.');
    expect(result.attestation.boundCandidateSha).toBeNull();
  });

  it('fails closed when the options object is null', () => {
    const result = verifyArming(deps(), null);

    expect(result.armed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('fails closed when the injected clock is invalid', () => {
    const result = verifyArming(
      { now: () => new Date('not-a-date') },
      { flags: fullFlags(), binding: binding(), armedAtIso: ARMED_AT_ISO }
    );

    expectNotArmedWithReason(result, 'Injected clock returned an invalid time.');
  });

  it('fails closed when armedAtIso is in the future', () => {
    const result = verifyArming(deps('2026-06-21T12:00:00.000Z'), {
      flags: fullFlags(),
      binding: binding(),
      armedAtIso: '2026-06-21T12:00:00.001Z',
    });

    expectNotArmedWithReason(result, 'Arming timestamp is in the future.');
  });
});
