import type { AutopilotConfig } from './config.ts';
import type { SentryIssueResponse } from './poller.ts';
import type { StackFrame } from './triage/fingerprint.ts';

const SENTRY_API_BASE_URL = process.env.SENTRY_API_BASE_URL || 'https://us.sentry.io';
const REQUEST_TIMEOUT_MS = 30_000;

export interface SentryResponseCheck {
  rateLimitApproaching: boolean;
}

export function assertSentryResponseOk(response: Response, url: string, body: string): SentryResponseCheck {
  const remaining = response.headers.get('x-sentry-rate-limit-remaining');
  const retryAfter = response.headers.get('retry-after');
  const rateLimits = response.headers.get('x-sentry-rate-limits');

  if (response.status === 429) {
    throw new Error(
      `Sentry API rate limit exceeded${
        retryAfter ? `; retry after ${retryAfter}s` : ''
      }${rateLimits ? `; limits: ${rateLimits}` : ''}${body ? `; body: ${body.slice(0, 500)}` : ''}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Sentry API request failed (${response.status} ${response.statusText}) for ${url}: ${body}`);
  }

  if (remaining === '0') {
    const reset = response.headers.get('x-sentry-rate-limit-reset');
    console.warn(
      JSON.stringify({
        level: 'warn',
        component: 'sentry-autopilot-poller',
        message: 'Sentry API quota exhausted after current page; stopping pagination gracefully',
        reset,
      }),
    );
    return { rateLimitApproaching: true };
  }

  return { rateLimitApproaching: false };
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

async function fetchSentryJson(url: URL, config: AutopilotConfig, description: string): Promise<unknown> {
  const urlString = url.toString();
  const response = await fetchWithTimeout(urlString, config);
  const body = await response.text();
  assertSentryResponseOk(response, urlString, body);

  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(
      `Unexpected Sentry API response for ${description}: invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isSentryIssueResponse(value: unknown): value is SentryIssueResponse {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stackFramesFromUnknown(value: unknown): StackFrame[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const frames: StackFrame[] = [];
  for (const frame of value) {
    if (!isRecord(frame)) {
      continue;
    }
    const filename = typeof frame.filename === 'string' ? frame.filename : undefined;
    const functionName = typeof frame.function === 'string' ? frame.function : undefined;
    const rawLine = frame.lineno;
    const lineno = typeof rawLine === 'number' && Number.isInteger(rawLine) ? rawLine : undefined;
    frames.push({ filename, function: functionName, lineno });
  }

  return frames.length > 0 ? frames : null;
}

function extractFramesFromExceptionValues(values: unknown): StackFrame[] | null {
  if (!Array.isArray(values)) {
    return null;
  }

  for (const value of values) {
    if (!isRecord(value)) {
      continue;
    }
    const stacktrace = value.stacktrace;
    if (!isRecord(stacktrace)) {
      continue;
    }
    const frames = stackFramesFromUnknown(stacktrace.frames);
    if (frames) {
      return frames;
    }
  }

  return null;
}

function extractFramesFromEntries(entries: unknown): StackFrame[] | null {
  if (!Array.isArray(entries)) {
    return null;
  }

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const data = entry.data;
    if (!isRecord(data)) {
      continue;
    }
    const frames = extractFramesFromExceptionValues(data.values);
    if (frames) {
      return frames;
    }
  }

  return null;
}

function extractFramesRecursively(value: unknown, seen = new Set<unknown>()): StackFrame[] | null {
  if (!isRecord(value) && !Array.isArray(value)) {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (isRecord(value)) {
    const directFrames = stackFramesFromUnknown(value.frames);
    if (directFrames) {
      return directFrames;
    }

    for (const child of Object.values(value)) {
      const frames = extractFramesRecursively(child, seen);
      if (frames) {
        return frames;
      }
    }
    return null;
  }

  for (const child of value) {
    const frames = extractFramesRecursively(child, seen);
    if (frames) {
      return frames;
    }
  }
  return null;
}

export function extractStackFrames(sentryDetail: unknown): StackFrame[] {
  if (!isRecord(sentryDetail)) {
    return [];
  }

  const latestEvent = sentryDetail.latestEvent;
  if (isRecord(latestEvent)) {
    const frames =
      extractFramesFromEntries(latestEvent.entries) ??
      extractFramesFromExceptionValues(latestEvent.exception && isRecord(latestEvent.exception)
        ? latestEvent.exception.values
        : undefined);
    if (frames) {
      return frames;
    }
  }

  return (
    extractFramesFromEntries(sentryDetail.entries) ??
    extractFramesFromExceptionValues(
      sentryDetail.exception && isRecord(sentryDetail.exception) ? sentryDetail.exception.values : undefined,
    ) ??
    extractFramesRecursively(sentryDetail) ??
    []
  );
}

export async function fetchIssueDetail(
  sentryId: string,
  config: AutopilotConfig,
): Promise<SentryIssueResponse> {
  const url = new URL(`/api/0/issues/${encodeURIComponent(sentryId)}/`, SENTRY_API_BASE_URL);
  const payload = await fetchSentryJson(url, config, `issue "${sentryId}"`);

  if (!isSentryIssueResponse(payload)) {
    throw new Error(`Unexpected Sentry API response for issue "${sentryId}": expected an object`);
  }

  return payload;
}

export async function fetchIssueLatestEvent(
  sentryId: string,
  config: AutopilotConfig,
): Promise<unknown> {
  const url = new URL(
    `/api/0/issues/${encodeURIComponent(sentryId)}/events/latest/`,
    SENTRY_API_BASE_URL,
  );
  return fetchSentryJson(url, config, `latest event for issue "${sentryId}"`);
}

export async function fetchIssueEvents(
  sentryId: string,
  config: AutopilotConfig,
  opts: { limit?: number; full?: boolean } = {},
): Promise<unknown[]> {
  const url = new URL(`/api/0/issues/${encodeURIComponent(sentryId)}/events/`, SENTRY_API_BASE_URL);
  url.searchParams.set('full', String(opts.full ?? true));
  url.searchParams.set('limit', String(opts.limit ?? 10));

  const payload = await fetchSentryJson(url, config, `events for issue "${sentryId}"`);
  if (!isUnknownArray(payload)) {
    throw new Error(`Unexpected Sentry API response for events for issue "${sentryId}": expected an array`);
  }
  return payload;
}

export async function fetchIssueHashes(
  sentryId: string,
  config: AutopilotConfig,
): Promise<unknown[]> {
  const url = new URL(`/api/0/issues/${encodeURIComponent(sentryId)}/hashes/`, SENTRY_API_BASE_URL);
  const payload = await fetchSentryJson(url, config, `hashes for issue "${sentryId}"`);
  if (!isUnknownArray(payload)) {
    throw new Error(`Unexpected Sentry API response for hashes for issue "${sentryId}": expected an array`);
  }
  return payload;
}

export async function fetchReleases(
  config: AutopilotConfig,
  opts: { org?: string; perPage?: number } = {},
): Promise<unknown[]> {
  const org = opts.org ?? config.sentryOrg;
  const url = new URL(
    `/api/0/organizations/${encodeURIComponent(org)}/releases/`,
    SENTRY_API_BASE_URL,
  );
  url.searchParams.set('per_page', String(opts.perPage ?? 20));

  const payload = await fetchSentryJson(url, config, `releases for organization "${org}"`);
  if (!isUnknownArray(payload)) {
    throw new Error(`Unexpected Sentry API response for releases for organization "${org}": expected an array`);
  }
  return payload;
}
