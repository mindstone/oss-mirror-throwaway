/**
 * Off-by-default production arming verification for the overnight release chain (S-ARM).
 *
 * This module only DECIDES whether one frozen candidate is armed. It must stay
 * pure and must never import or call the production advance driver. Per A2, the
 * future orchestrator must invoke `scripts/promote-to-production.ts` as a
 * subprocess, not by importing `runPromoteToProduction`.
 */

import type { CandidateBinding } from './release-candidate-binding';

export const DEFAULT_ARMING_TTL_MS = 12 * 60 * 60 * 1000;

export const NO_SOAK_NO_PAGING_RISK_ACCEPTANCE =
  'No beta soak threshold and no automated paging/rollback are evaluated; I accept morning review as the response window.';

export interface ReleaseArmingDeps {
  now: () => Date;
}

export interface ReleaseArmingFlags {
  armProduction?: boolean;
  candidateSha?: string;
  confirmChangelogCurrent?: string;
  attestS8aGreenInCi?: boolean;
  attestPolicySignedOff?: boolean;
  acceptNoSoakNoPaging?: boolean;
}

export interface VerifyArmingOptions {
  flags?: ReleaseArmingFlags | null;
  binding?: CandidateBinding | null;
  armedAtIso?: string | null;
  /**
   * Defaults to 12 hours. Keep this short enough that stale overnight arming
   * cannot drift into a later candidate.
   */
  ttlMs?: number | null;
}

export interface ReleaseArmingAttestation {
  attestS8aGreenInCi: boolean;
  attestPolicySignedOff: boolean;
  acceptNoSoakNoPaging: boolean;
  noSoakNoPagingRiskAcceptance: typeof NO_SOAK_NO_PAGING_RISK_ACCEPTANCE;
  armedAtIso: string | null;
  evaluatedAtIso: string | null;
  expiresAtIso: string | null;
  ttlMs: number | null;
  candidateSha: string | null;
  confirmChangelogCurrent: string | null;
  boundCandidateSha: string | null;
  boundSourcePackageVersion: string | null;
}

export interface VerifyArmingResult {
  armed: boolean;
  reasons: string[];
  attestation: ReleaseArmingAttestation;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function readNowMs(deps: ReleaseArmingDeps): number | null {
  try {
    const now = deps.now();
    const ms = now.getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function isoFromMs(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function resolveTtlMs(value: unknown): number | null {
  if (value === undefined || value === null) return DEFAULT_ARMING_TTL_MS;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function releaseRunHeadSha(binding: CandidateBinding | null | undefined): string | null {
  return stringField(binding?.releaseRun?.headSha);
}

function sourcePackageVersion(binding: CandidateBinding | null | undefined): string | null {
  return stringField(binding?.sourcePackageVersion);
}

export function verifyArming(
  deps: ReleaseArmingDeps,
  opts: VerifyArmingOptions | null = {}
): VerifyArmingResult {
  const input = opts ?? {};
  const reasons: string[] = [];
  const flags = isObjectRecord(input.flags) ? input.flags : null;
  const ttlMs = resolveTtlMs(input.ttlMs);
  const nowMs = readNowMs(deps);
  const armedAtMs = parseIsoMs(input.armedAtIso);
  const boundCandidateSha = releaseRunHeadSha(input.binding);
  const boundSourcePackageVersion = sourcePackageVersion(input.binding);
  const candidateSha = stringField(flags?.candidateSha);
  const confirmChangelogCurrent = stringField(flags?.confirmChangelogCurrent);

  if (flags === null) {
    reasons.push('Arming flags are absent or malformed.');
  }
  if (
    input.binding === null ||
    input.binding === undefined ||
    boundCandidateSha === null ||
    boundSourcePackageVersion === null
  ) {
    reasons.push('Candidate binding is absent or malformed.');
  }
  if (ttlMs === null) {
    reasons.push('Arming TTL is absent or malformed.');
  }
  if (nowMs === null) {
    reasons.push('Injected clock returned an invalid time.');
  }
  if (armedAtMs === null) {
    reasons.push('Arming timestamp is absent or malformed.');
  }

  if (flags?.armProduction !== true) {
    reasons.push('armProduction must be explicitly true.');
  }
  if (candidateSha === null) {
    reasons.push('candidateSha must be present.');
  } else if (boundCandidateSha !== null && candidateSha !== boundCandidateSha) {
    // The authoritative candidate SHA is binding.releaseRun.headSha from the frozen binding.
    reasons.push('candidateSha does not match the frozen candidate head SHA.');
  }
  if (confirmChangelogCurrent === null) {
    reasons.push('confirmChangelogCurrent must be present.');
  } else if (
    boundSourcePackageVersion !== null &&
    confirmChangelogCurrent !== boundSourcePackageVersion
  ) {
    reasons.push('confirmChangelogCurrent does not match the frozen source package version.');
  }

  if (nowMs !== null && armedAtMs !== null && ttlMs !== null) {
    const ageMs = nowMs - armedAtMs;
    if (ageMs < 0) {
      reasons.push('Arming timestamp is in the future.');
    } else if (ageMs > ttlMs) {
      reasons.push('Arming TTL has expired.');
    }
  }

  if (flags?.attestS8aGreenInCi !== true) {
    reasons.push('Operator must attest S8a is merged and green in CI.');
  }
  if (flags?.attestPolicySignedOff !== true) {
    reasons.push('Operator must attest policy/go-live sign-off is present.');
  }
  if (flags?.acceptNoSoakNoPaging !== true) {
    reasons.push(
      `Operator must accept the named no-soak/no-paging risk clause: "${NO_SOAK_NO_PAGING_RISK_ACCEPTANCE}"`
    );
  }

  return {
    armed: reasons.length === 0,
    reasons,
    attestation: {
      attestS8aGreenInCi: flags?.attestS8aGreenInCi === true,
      attestPolicySignedOff: flags?.attestPolicySignedOff === true,
      acceptNoSoakNoPaging: flags?.acceptNoSoakNoPaging === true,
      noSoakNoPagingRiskAcceptance: NO_SOAK_NO_PAGING_RISK_ACCEPTANCE,
      armedAtIso: typeof input.armedAtIso === 'string' ? input.armedAtIso : null,
      evaluatedAtIso: isoFromMs(nowMs),
      expiresAtIso: armedAtMs !== null && ttlMs !== null ? isoFromMs(armedAtMs + ttlMs) : null,
      ttlMs,
      candidateSha,
      confirmChangelogCurrent,
      boundCandidateSha,
      boundSourcePackageVersion,
    },
  };
}
