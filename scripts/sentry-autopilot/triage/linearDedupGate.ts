import { fetchIssueDetail, extractStackFrames } from '../sentryRest.ts';
import { emitCounter } from '../metrics.ts';
import { fingerprintLooseHash } from './fingerprint.ts';
import type { TriageGate, TriageGateResult } from './index.ts';

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LINEAR_RESULTS_PER_QUERY = 50;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;

let consecutiveLinearFailures = 0;

interface LinearDedupCandidate {
  id: string;
  identifier: string;
  status: string;
}

function logWarn(data: Record<string, unknown> = {}, message: string): void {
  console.warn(JSON.stringify({ level: 'warn', component: 'sentry-autopilot-linear-dedup-gate', message, ...data }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resetLinearDedupCircuitBreakerForTests(): void {
  consecutiveLinearFailures = 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function fetchLinearGraphql(apiKey: string, body: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Linear GraphQL request failed (${response.status} ${response.statusText}): ${text.slice(0, 500)}`);
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(
        `Linear GraphQL response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Linear GraphQL request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseLinearCandidates(payload: unknown): LinearDedupCandidate[] {
  if (!isRecord(payload)) {
    throw new Error('Unexpected Linear response: expected object');
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${JSON.stringify(payload.errors).slice(0, 500)}`);
  }

  const data = payload.data;
  if (!isRecord(data)) {
    throw new Error('Unexpected Linear response: missing data');
  }
  const issues = data.issues;
  if (!isRecord(issues) || !Array.isArray(issues.nodes)) {
    throw new Error('Unexpected Linear response: missing data.issues.nodes');
  }

  const candidates: LinearDedupCandidate[] = [];
  for (const node of issues.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string') {
      continue;
    }
    const state = node.state;
    const status = isRecord(state) && typeof state.name === 'string' ? state.name : '';
    candidates.push({
      id: node.id,
      identifier: typeof node.identifier === 'string' ? node.identifier : node.id,
      status,
    });
  }
  return candidates;
}

async function searchLinearDescriptions(apiKey: string, term: string): Promise<LinearDedupCandidate[]> {
  const payload = await fetchLinearGraphql(apiKey, {
    // Verified by unauthenticated Linear schema introspection on 2026-06-07:
    // IssueFilter.description is a NullableStringComparator and supports contains.
    query: `
      query AutopilotLinearDedupSearch($term: String!, $first: Int!) {
        issues(first: $first, filter: { description: { contains: $term } }) {
          nodes {
            id
            identifier
            state {
              name
            }
          }
        }
      }
    `,
    variables: { term, first: MAX_LINEAR_RESULTS_PER_QUERY + 1 },
  });
  return parseLinearCandidates(payload);
}

async function computeLooseFingerprint(issueId: string, ctx: Parameters<TriageGate>[1]): Promise<string | null> {
  if (!ctx.config) {
    return null;
  }

  const detail = await fetchIssueDetail(issueId, ctx.config);
  return fingerprintLooseHash(extractStackFrames(detail));
}

function skipResult(
  reason: string,
  match: LinearDedupCandidate,
  fingerprint?: string,
): TriageGateResult {
  return {
    decision: 'skip',
    gate: 'linear-dedup',
    reason,
    metadata: {
      matchedLinearId: match.identifier,
      matchedLinearStatus: match.status,
      ...(fingerprint ? { fingerprint } : {}),
    },
  };
}

function findAllowedMatch(
  candidates: readonly LinearDedupCandidate[],
  statuses: readonly string[],
): LinearDedupCandidate | null {
  const allowed = new Set(statuses);
  return candidates.find((candidate) => allowed.has(candidate.status)) ?? null;
}

async function runSearchAxis(
  apiKey: string,
  term: string,
  sentryId: string,
  axis: 'by-id' | 'by-fingerprint',
): Promise<LinearDedupCandidate[] | null> {
  let results: LinearDedupCandidate[];
  try {
    results = await searchLinearDescriptions(apiKey, term);
    consecutiveLinearFailures = 0;
  } catch (error) {
    consecutiveLinearFailures += 1;
    emitCounter('reporter.linear_dedup.failure', {
      sentryId,
      axis,
      consecutiveFailures: consecutiveLinearFailures,
    });
    throw error;
  }
  if (results.length > MAX_LINEAR_RESULTS_PER_QUERY) {
    logWarn(
      { gate: 'linear-dedup', sentryId, axis, resultCount: results.length, maxResults: MAX_LINEAR_RESULTS_PER_QUERY },
      'Linear dedup gate failed open because a description query matched too broadly',
    );
    return null;
  }
  return results;
}

export const linearDedupGate: TriageGate = async (issue, ctx) => {
  const config = ctx.config;
  if (!config?.linearDedupEnabled) {
    return { decision: 'dispatch' };
  }

  if (!config.linearApiKey) {
    logWarn(
      { gate: 'linear-dedup', sentryId: issue.sentryId, fail_reason: 'missing_linear_api_key' },
      'Linear dedup gate failed open because LINEAR_API_KEY is not set',
    );
    return { decision: 'dispatch' };
  }

  if (consecutiveLinearFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    logWarn(
      { gate: 'linear-dedup', sentryId: issue.sentryId, consecutiveFailures: consecutiveLinearFailures },
      `Linear dedup gate circuit-breaker engaged after ${consecutiveLinearFailures} consecutive failures`,
    );
    emitCounter('reporter.linear_dedup.circuit_breaker_engaged', {
      sentryId: issue.sentryId,
      consecutiveFailures: consecutiveLinearFailures,
    });
    return { decision: 'dispatch' };
  }

  const statuses = config.linearDedupStatuses ?? ['Done', 'Cancelled', 'Duplicate'];
  const byIdQuery = `sentry-issue-id: ${issue.sentryId}`;

  try {
    const byIdResults = await runSearchAxis(config.linearApiKey, byIdQuery, issue.sentryId, 'by-id');
    if (!byIdResults) {
      return { decision: 'dispatch' };
    }
    const byIdMatch = findAllowedMatch(byIdResults, statuses);
    if (byIdMatch) {
      return skipResult(`linear-already-fixed:${byIdMatch.identifier}`, byIdMatch);
    }
  } catch (error) {
    logWarn(
      { gate: 'linear-dedup', sentryId: issue.sentryId, axis: 'by-id', error: errorMessage(error) },
      'Linear dedup gate failed open because the by-id Linear query failed',
    );
    return { decision: 'dispatch' };
  }

  let fingerprint: string | null = null;
  try {
    fingerprint = await computeLooseFingerprint(issue.sentryId, ctx);
  } catch (error) {
    logWarn(
      { gate: 'linear-dedup', sentryId: issue.sentryId, error: errorMessage(error) },
      'Linear dedup gate failed open because Sentry stack-frame fingerprint extraction failed',
    );
    return { decision: 'dispatch' };
  }

  if (!fingerprint) {
    return { decision: 'dispatch' };
  }

  const byFingerprintQuery = `autopilot-fingerprint: ${fingerprint}`;
  try {
    const byFingerprintResults = await runSearchAxis(
      config.linearApiKey,
      byFingerprintQuery,
      issue.sentryId,
      'by-fingerprint',
    );
    if (!byFingerprintResults) {
      return { decision: 'dispatch' };
    }
    const byFingerprintMatch = findAllowedMatch(byFingerprintResults, statuses);
    if (byFingerprintMatch) {
      return skipResult(
        `linear-fingerprint-match:${fingerprint}:${byFingerprintMatch.identifier}`,
        byFingerprintMatch,
        fingerprint,
      );
    }
  } catch (error) {
    logWarn(
      { gate: 'linear-dedup', sentryId: issue.sentryId, axis: 'by-fingerprint', error: errorMessage(error) },
      'Linear dedup gate failed open because the by-fingerprint Linear query failed',
    );
    return { decision: 'dispatch' };
  }

  return { decision: 'dispatch' };
};
