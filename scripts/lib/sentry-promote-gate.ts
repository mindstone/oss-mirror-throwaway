/**
 * Basic deterministic Sentry promote gate for the overnight release chain (S-SENTRY).
 *
 * Pure + dependency-injected: the caller supplies env and HTTP dependencies, so
 * tests exercise no live Sentry/network path. Unknown evidence fails closed to
 * `sentryClean: null`; determinate blocking evidence returns `false`.
 */

export type SentryStatsPeriod = '24h' | '14d';

export interface FetchSentryInit {
  headers?: Record<string, string>;
}

export type FetchSentryResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status?: number; error: string };

export type FetchSentry = (url: string, init?: FetchSentryInit) => Promise<FetchSentryResult>;

export interface SentryPromoteGateDeps {
  fetchSentry: FetchSentry;
  getEnv: (key: string) => string | undefined;
  baseUrl?: string;
  orgSlug?: string;
  projectSlug?: string;
}

export interface EvaluateSentryGateOptions {
  betaPublishedVersion: string;
  sinceIso?: string;
  statsPeriod?: SentryStatsPeriod;
}

export interface SentryPromoteGateResult {
  /** `null` means "could not determine", which is a blocking result. */
  sentryClean: boolean | null;
  releaseObserved: boolean | null;
  blockingIssues: number | null;
  reasons: string[];
}

interface SentryIssue {
  id?: unknown;
  shortId?: unknown;
  level?: unknown;
  title?: unknown;
}

const DEFAULT_BASE_URL = 'https://us.sentry.io';
const DEFAULT_ORG_SLUG = 'mindstone';
const DEFAULT_PROJECT_SLUG = 'rebel';
const SENTRY_AUTH_TOKEN = 'SENTRY_AUTH_TOKEN';

/**
 * Deterministic threshold: >=1 unresolved error/fatal issue on the exact beta
 * release tag blocks production promotion. Zero matching issues is only "no
 * blocking signal in this window"; it is not evidence of safety or exposure.
 */
export async function evaluateSentryGate(
  deps: SentryPromoteGateDeps,
  opts: EvaluateSentryGateOptions
): Promise<SentryPromoteGateResult> {
  const inputReasons = validateInputs(opts);
  if (inputReasons.length > 0) {
    return {
      sentryClean: null,
      releaseObserved: null,
      blockingIssues: null,
      reasons: inputReasons,
    };
  }

  const token = deps.getEnv(SENTRY_AUTH_TOKEN)?.trim();
  if (!token) {
    return {
      sentryClean: null,
      releaseObserved: null,
      blockingIssues: null,
      reasons: ['Missing SENTRY_AUTH_TOKEN; Sentry promote gate cannot determine release health.'],
    };
  }

  const release = buildBetaSentryRelease(opts.betaPublishedVersion.trim());
  const config = {
    baseUrl: normalizeBaseUrl(deps.baseUrl),
    orgSlug: deps.orgSlug ?? DEFAULT_ORG_SLUG,
    projectSlug: deps.projectSlug ?? DEFAULT_PROJECT_SLUG,
    token,
  };

  const observed = await readReleaseObserved(deps.fetchSentry, config, release);
  if (observed.kind === 'unknown') {
    return {
      sentryClean: null,
      releaseObserved: null,
      blockingIssues: null,
      reasons: [observed.reason],
    };
  }

  if (!observed.releaseObserved) {
    return {
      sentryClean: false,
      releaseObserved: false,
      blockingIssues: null,
      reasons: [
        observed.reason,
        'No observed release tag means Sentry may not have ingested this beta yet; this is no signal, not safety.',
      ],
    };
  }

  const blocking = await readBlockingIssues(deps.fetchSentry, config, {
    release,
    statsPeriod: opts.sinceIso ? undefined : (opts.statsPeriod ?? '24h'),
    sinceIso: opts.sinceIso,
  });
  if (blocking.kind === 'unknown') {
    return {
      sentryClean: null,
      releaseObserved: true,
      blockingIssues: null,
      reasons: [
        'Sentry release tag is observed.',
        blocking.reason,
      ],
    };
  }

  if (blocking.count > 0) {
    return {
      sentryClean: false,
      releaseObserved: true,
      blockingIssues: blocking.count,
      reasons: [
        `Sentry release tag is observed, but ${blocking.count} unresolved error/fatal issue(s) match the exact beta release.`,
        'Threshold is deterministic: one or more unresolved error/fatal issues blocks promotion.',
      ],
    };
  }

  return {
    sentryClean: true,
    releaseObserved: true,
    blockingIssues: 0,
    reasons: [
      'Sentry release tag is observed.',
      'No unresolved error/fatal issues matched the exact beta release in the Sentry issues window.',
      'This is pass-no-blocking-signal only: soak/exposure is NOT evaluated, and morning review remains the response window.',
    ],
  };
}

export function buildBetaSentryRelease(betaPublishedVersion: string): string {
  return `mindstone-rebel-beta@${betaPublishedVersion}`;
}

export function buildBlockingIssuesQuery(release: string): string {
  return `is:unresolved release:${release} level:[error,fatal]`;
}

function validateInputs(opts: EvaluateSentryGateOptions): string[] {
  const reasons: string[] = [];
  if (typeof opts.betaPublishedVersion !== 'string' || opts.betaPublishedVersion.trim().length === 0) {
    reasons.push('Beta published version is required for the Sentry promote gate.');
  }
  if (opts.statsPeriod !== undefined && opts.statsPeriod !== '24h' && opts.statsPeriod !== '14d') {
    reasons.push('Sentry statsPeriod must be 24h or 14d.');
  }
  if (opts.sinceIso !== undefined && Number.isNaN(Date.parse(opts.sinceIso))) {
    reasons.push('sinceIso must be a parseable ISO timestamp when provided.');
  }
  return reasons;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function projectApiBase(config: {
  baseUrl: string;
  orgSlug: string;
  projectSlug: string;
}): string {
  return `${config.baseUrl}/api/0/projects/${encodeURIComponent(config.orgSlug)}/${encodeURIComponent(config.projectSlug)}`;
}

async function readReleaseObserved(
  fetchSentry: FetchSentry,
  config: {
    baseUrl: string;
    orgSlug: string;
    projectSlug: string;
    token: string;
  },
  release: string
): Promise<{ kind: 'ok'; releaseObserved: true; reason: string } | { kind: 'ok'; releaseObserved: false; reason: string } | { kind: 'unknown'; reason: string }> {
  const url = `${projectApiBase(config)}/releases/${encodeURIComponent(release)}/`;
  const response = await safeFetch(fetchSentry, url, config.token);

  if (!response.ok) {
    if (response.status === 404) {
      return {
        kind: 'ok',
        releaseObserved: false,
        reason: `Sentry does not report the exact beta release tag ${release}.`,
      };
    }
    return { kind: 'unknown', reason: describeFetchFailure('Sentry release observation check', response) };
  }

  if (!isObject(response.json) || response.json.version !== release) {
    return {
      kind: 'unknown',
      reason: 'Sentry release observation check returned an unexpected response shape.',
    };
  }

  return { kind: 'ok', releaseObserved: true, reason: `Sentry reports exact beta release tag ${release}.` };
}

async function readBlockingIssues(
  fetchSentry: FetchSentry,
  config: {
    baseUrl: string;
    orgSlug: string;
    projectSlug: string;
    token: string;
  },
  params: {
    release: string;
    statsPeriod?: SentryStatsPeriod;
    sinceIso?: string;
  }
): Promise<{ kind: 'ok'; count: number } | { kind: 'unknown'; reason: string }> {
  const url = new URL(`${projectApiBase(config)}/issues/`);
  url.searchParams.set('query', buildBlockingIssuesQuery(params.release));
  // Sentry treats relative statsPeriod and absolute start/end windows as mutually exclusive.
  if (params.sinceIso) {
    url.searchParams.set('start', params.sinceIso);
  } else {
    url.searchParams.set('statsPeriod', params.statsPeriod ?? '24h');
  }
  url.searchParams.set('limit', '100');

  const response = await safeFetch(fetchSentry, url.toString(), config.token);
  if (!response.ok) {
    return { kind: 'unknown', reason: describeFetchFailure('Sentry blocking issues query', response) };
  }

  if (!Array.isArray(response.json)) {
    return {
      kind: 'unknown',
      reason: 'Sentry blocking issues query returned an unexpected response shape.',
    };
  }

  if (!response.json.every(isSentryIssueLike)) {
    return {
      kind: 'unknown',
      reason: 'Sentry blocking issues query returned issue rows with an unexpected shape.',
    };
  }

  return { kind: 'ok', count: response.json.length };
}

async function safeFetch(
  fetchSentry: FetchSentry,
  url: string,
  token: string
): Promise<FetchSentryResult> {
  try {
    return await fetchSentry(url, { headers: authHeaders(token) });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function describeFetchFailure(label: string, response: Extract<FetchSentryResult, { ok: false }>): string {
  if (response.status === 401) {
    return `${label} failed with HTTP 401; SENTRY_AUTH_TOKEN is invalid or expired.`;
  }
  if (response.status === 403) {
    return `${label} failed with HTTP 403; SENTRY_AUTH_TOKEN may not have permission for this project-scoped read.`;
  }
  if (typeof response.status === 'number') {
    return `${label} failed with HTTP ${response.status}: ${response.error}`;
  }
  return `${label} failed: ${response.error}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSentryIssueLike(value: unknown): value is SentryIssue {
  if (!isObject(value)) return false;
  const id = value.id;
  const shortId = value.shortId;
  const title = value.title;
  return (
    (typeof id === 'string' || typeof shortId === 'string') &&
    (title === undefined || typeof title === 'string')
  );
}
