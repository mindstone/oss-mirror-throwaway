import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { buildChildPath } from './childEnv.ts';
import type { AutopilotConfig } from './config';
import { matchesNoiseTitle } from './noisePatterns.ts';
import { assertSentryResponseOk } from './sentryRest.ts';
import type { StateDB } from './state';

export { assertSentryResponseOk } from './sentryRest.ts';

export interface PolledIssue {
  sentryId: string;
  sentryUrl: string;
  title: string;
  errorType: 'exception' | 'feedback' | 'crash';
  isUserReported: boolean;
  occurrences: number;
  users: number;
  level: string;
  firstSeen: string;
  lastSeen: string;
  userDescription?: string;
  userEmail?: string;
  userName?: string;
}

export interface SentryIssueResponse {
  id?: unknown;
  permalink?: unknown;
  title?: unknown;
  shortId?: unknown;
  level?: unknown;
  count?: unknown;
  userCount?: unknown;
  firstSeen?: unknown;
  lastSeen?: unknown;
  firstRelease?: unknown;
  lastRelease?: unknown;
  latestEvent?: unknown;
  entries?: unknown;
  exception?: unknown;
  issueCategory?: unknown;
  type?: unknown;
  metadata?: unknown;
  isEscalating?: unknown;
  userReportCount?: unknown;
}

const execFileAsync = promisify(execFile);
const SENTRY_API_BASE_URL = process.env.SENTRY_API_BASE_URL || 'https://us.sentry.io';
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_LIMIT = '100';
const RECENT_GIT_WINDOW = '14 days ago';

const POLL_QUERIES = [
  'is:unresolved firstSeen:-90m level:[error,fatal]',
  'is:unresolved issueCategory:feedback firstSeen:-90m',
  'is:unresolved is:escalating lastSeen:-24h',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberFromUnknown(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.replace(/,/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function nestedString(record: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return stringFromUnknown(current);
}

function extractUserDescription(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  return (
    nestedString(metadata, ['message']) ??
    nestedString(metadata, ['description']) ??
    nestedString(metadata, ['value']) ??
    nestedString(metadata, ['feedback', 'message']) ??
    nestedString(metadata, ['feedback', 'description'])
  );
}

/**
 * Extracts the reporter email from a Sentry feedback issue's metadata.
 *
 * Only intended for use with `errorType === 'feedback'` (the User Feedback widget).
 * Sentry's payload shape varies across SDK versions; we defensively check the
 * most likely paths. Do NOT call this on non-feedback issues, and never fall
 * back to `event.user.email` (logged-in user context) — that is out of scope.
 */
function extractUserEmail(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  return (
    nestedString(metadata, ['feedback', 'contact_email']) ??
    nestedString(metadata, ['contact_email']) ??
    nestedString(metadata, ['feedback', 'email']) ??
    nestedString(metadata, ['email'])
  );
}

/**
 * Extracts the reporter name from a Sentry feedback issue's metadata.
 *
 * Only intended for use with `errorType === 'feedback'`. Optional — graceful
 * degradation when absent (agent prompt falls back to a generic greeting).
 */
function extractUserName(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  return nestedString(metadata, ['feedback', 'name']) ?? nestedString(metadata, ['name']);
}

function classifyErrorType(issue: SentryIssueResponse): PolledIssue['errorType'] {
  const issueCategory = stringFromUnknown(issue.issueCategory)?.toLowerCase();
  const type = stringFromUnknown(issue.type)?.toLowerCase();
  const level = stringFromUnknown(issue.level)?.toLowerCase();

  if (issueCategory === 'feedback' || type === 'feedback' || type === 'user_report') {
    return 'feedback';
  }

  if (level === 'fatal' || type === 'crash') {
    return 'crash';
  }

  return 'exception';
}

export function mapSentryIssue(config: AutopilotConfig, issue: SentryIssueResponse): PolledIssue | null {
  const sentryId = stringFromUnknown(issue.id);
  if (!sentryId) {
    return null;
  }

  const errorType = classifyErrorType(issue);
  const title = stringFromUnknown(issue.title) ?? stringFromUnknown(issue.shortId) ?? `Sentry issue ${sentryId}`;
  const level = stringFromUnknown(issue.level) ?? 'error';
  const userReportCount = numberFromUnknown(issue.userReportCount);
  const userDescription = extractUserDescription(issue.metadata);
  // Reporter email/name come strictly from the User Feedback widget (errorType === 'feedback').
  // Never fall back to event.user.email — that is the logged-in user context and is out of scope.
  const userEmail = errorType === 'feedback' ? extractUserEmail(issue.metadata) : undefined;
  const userName = errorType === 'feedback' ? extractUserName(issue.metadata) : undefined;

  return {
    sentryId,
    sentryUrl:
      stringFromUnknown(issue.permalink) ??
      `${SENTRY_API_BASE_URL}/organizations/${config.sentryOrg}/issues/${sentryId}/`,
    title,
    errorType,
    isUserReported: errorType === 'feedback' || userReportCount > 0,
    occurrences: numberFromUnknown(issue.count),
    users: numberFromUnknown(issue.userCount),
    level,
    firstSeen: stringFromUnknown(issue.firstSeen) ?? '',
    lastSeen: stringFromUnknown(issue.lastSeen) ?? '',
    ...(userDescription ? { userDescription } : {}),
    ...(userEmail ? { userEmail } : {}),
    ...(userName ? { userName } : {}),
  };
}

function parseNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  for (const rawPart of linkHeader.split(',')) {
    const part = rawPart.trim();
    if (!part.includes('rel="next"') || !part.includes('results="true"')) {
      continue;
    }

    const match = part.match(/<([^>]+)>/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

async function fetchWithTimeout(url: string, config: AutopilotConfig): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.sentryAuthToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Sentry API request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildIssuesUrl(config: AutopilotConfig, query: string): string {
  const url = new URL(
    `/api/0/projects/${encodeURIComponent(config.sentryOrg)}/${encodeURIComponent(
      config.sentryProject,
    )}/issues/`,
    SENTRY_API_BASE_URL,
  );
  url.searchParams.set('query', query);
  url.searchParams.set('limit', PAGE_LIMIT);
  return url.toString();
}

async function fetchIssueQuery(config: AutopilotConfig, query: string): Promise<PolledIssue[]> {
  const issues: PolledIssue[] = [];
  let nextUrl: string | null = buildIssuesUrl(config, query);

  while (nextUrl) {
    const response = await fetchWithTimeout(nextUrl, config);
    const body = await response.text();
    const { rateLimitApproaching } = assertSentryResponseOk(response, nextUrl, body);

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new Error(
        `Unexpected Sentry API response for query "${query}": invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!Array.isArray(payload)) {
      throw new Error(`Unexpected Sentry API response for query "${query}": expected an array`);
    }

    for (const item of payload) {
      if (!isRecord(item)) {
        continue;
      }

      const mapped = mapSentryIssue(config, item);
      if (mapped) {
        issues.push(mapped);
      }
    }

    if (rateLimitApproaching) {
      break;
    }

    nextUrl = parseNextPageUrl(response.headers.get('link'));
  }

  return issues;
}

function uniqueIssues(issues: PolledIssue[]): PolledIssue[] {
  const deduped = new Map<string, PolledIssue>();
  for (const issue of issues) {
    const existing = deduped.get(issue.sentryId);
    if (!existing || (issue.isUserReported && !existing.isUserReported)) {
      deduped.set(issue.sentryId, issue);
    }
  }
  return [...deduped.values()];
}

/**
 * Polls Sentry for newly actionable issues, feedback reports, and escalating issues.
 */
export async function pollSentry(config: AutopilotConfig): Promise<PolledIssue[]> {
  const queryResults = await Promise.all(POLL_QUERIES.map((query) => fetchIssueQuery(config, query)));
  return uniqueIssues(queryResults.flat());
}

/**
 * Applies lightweight autopilot triage and returns whether an issue should be dispatched.
 */
export function triageIssue(issue: PolledIssue): 'dispatch' | 'skip' {
  if (issue.isUserReported || issue.errorType === 'feedback') {
    return 'dispatch';
  }

  // Noise pre-filter: documented per-platform crash/network patterns from
  // docs/project/SENTRY_TRIAGE.md never get dispatched, even when their
  // Sentry level is fatal/crash. Without this gate native Chromium and
  // macOS system crashes — which are level=fatal by default — would burn
  // bug-fixer slots on uninvestigable third-party traces. Caller archives
  // these with substatus=archived_until_escalating, so a sudden volume
  // spike still re-surfaces them.
  if (matchesNoiseTitle(issue.title).match) {
    return 'skip';
  }

  if (issue.level.toLowerCase() === 'fatal' || issue.errorType === 'crash') {
    return 'dispatch';
  }

  if (issue.occurrences > 5 && issue.users > 1) {
    return 'dispatch';
  }

  return 'skip';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commitMentionsIssue(commitSubject: string, issue: PolledIssue | { sentry_id: string; sentry_url: string }): boolean {
  const subject = commitSubject.toLowerCase();
  const sentryId = 'sentryId' in issue ? issue.sentryId : issue.sentry_id;
  const sentryIdPattern = new RegExp(`\\b${escapeRegex(sentryId.toLowerCase())}\\b`);

  return subject.includes('[autopilot]') && sentryIdPattern.test(subject);
}

function parseGitLog(stdout: string): Array<{ hash: string; subject: string }> {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash = '', ...subjectParts] = line.split('\t');
      return { hash, subject: subjectParts.join('\t') };
    })
    .filter((entry) => entry.hash && entry.subject);
}

/**
 * Checks recent commits for tracked Sentry IDs/URLs and marks matching issues completed.
 */
export async function checkCommitResolutions(config: AutopilotConfig, db: StateDB): Promise<void> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    config.repoRoot,
    'log',
    `--since=${RECENT_GIT_WINDOW}`,
    '--format=%H%x09%s',
  ], {
    env: { ...process.env, PATH: buildChildPath(process.env.PATH) },
  });

  const commits = parseGitLog(stdout);
  const trackedIssues = new Map(
    [...db.getPendingIssues(), ...db.getStaleIssues(0)]
      .filter((issue) => issue.status === 'pending' || issue.status === 'skipped' || issue.status === 'deferred')
      .map((issue) => [
        issue.sentry_id,
        issue,
      ]),
  );

  for (const issue of trackedIssues.values()) {
    const matchingCommit = commits.find((commit) => commitMentionsIssue(commit.subject, issue));
    if (matchingCommit) {
      db.markCompleted(issue.sentry_id, 'commit_detected', undefined, matchingCommit.hash);
    }
  }
}

/**
 * Polls Sentry for unresolved issues that have not been seen in seven or more days.
 */
export async function getStaleIssues(config: AutopilotConfig): Promise<PolledIssue[]> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  return fetchIssueQuery(config, `is:unresolved lastSeen:<${cutoff}`);
}
