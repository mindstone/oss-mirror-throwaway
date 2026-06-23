import semver, { type SemVer } from 'semver';

import { fetchIssueDetail } from '../sentryRest.ts';
import { getCurrentRelease } from './currentRelease.ts';
import type { TriageGate } from './index.ts';

interface ParsedIssueRelease {
  display: string;
  semver: SemVer;
}

function logWarn(data: Record<string, unknown> = {}, message: string): void {
  console.warn(JSON.stringify({ level: 'warn', component: 'sentry-autopilot-release-gate', message, ...data }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseReleaseString(value: unknown): ParsedIssueRelease | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = semver.parse(value.trim());
  if (!parsed) {
    return null;
  }

  return { display: `v${parsed.version}`, semver: parsed };
}

function releaseFromUnknown(value: unknown): ParsedIssueRelease | null {
  if (typeof value === 'string') {
    return parseReleaseString(value);
  }

  if (!isRecord(value)) {
    return null;
  }

  return parseReleaseString(value.shortVersion) ?? parseReleaseString(value.version);
}

function minorLineLag(current: SemVer, issue: SemVer): number {
  return (current.major - issue.major) * 1000 + (current.minor - issue.minor);
}

export const releaseGate: TriageGate = async (issue, ctx) => {
  const config = ctx.config;
  if (!config?.releaseGateEnabled) {
    return { decision: 'dispatch' };
  }

  let currentRelease: string | null;
  try {
    currentRelease = await getCurrentRelease(config);
  } catch (error) {
    logWarn(
      {
        gate: 'release',
        sentryId: issue.sentryId,
        fail_reason: 'current_release_lookup_failed',
        error: errorMessage(error),
      },
      'Release gate failed open because current release lookup failed',
    );
    return { decision: 'dispatch' };
  }

  const currentSemver = semver.parse(currentRelease ?? '');
  if (!currentRelease || !currentSemver) {
    logWarn(
      { gate: 'release', sentryId: issue.sentryId, fail_reason: 'current_release_unparseable' },
      'Release gate failed open because current release is unavailable or unparseable',
    );
    return { decision: 'dispatch' };
  }

  let detail: Awaited<ReturnType<typeof fetchIssueDetail>>;
  try {
    detail = await fetchIssueDetail(issue.sentryId, config);
  } catch (error) {
    logWarn(
      {
        gate: 'release',
        sentryId: issue.sentryId,
        fail_reason: 'issue_detail_fetch_failed',
        error: errorMessage(error),
      },
      'Release gate failed open because Sentry issue detail fetch failed',
    );
    return { decision: 'dispatch' };
  }

  const issueRelease = releaseFromUnknown(detail.lastRelease) ?? releaseFromUnknown(detail.firstRelease);
  if (!issueRelease) {
    logWarn(
      { gate: 'release', sentryId: issue.sentryId, fail_reason: 'issue_release_unparseable' },
      'Release gate failed open because issue lastRelease/firstRelease is unavailable or unparseable',
    );
    return { decision: 'dispatch' };
  }

  const lag = minorLineLag(currentSemver, issueRelease.semver);
  const tolerance = config.releaseLagToleranceMinor ?? 0;
  if (lag <= tolerance) {
    return { decision: 'dispatch' };
  }

  return {
    decision: 'skip',
    gate: 'release',
    reason: `release-aware-skip:lag=${lag}:current=${currentRelease}:issue=${issueRelease.display}`,
  };
};
