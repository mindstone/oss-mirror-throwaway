/**
 * OAuth refresh-failure telemetry.
 *
 * Reports refresh failures to Sentry with low-cardinality tags suitable for
 * tenant clustering and error-code distribution analysis — without sending any
 * PII (no email, no account slug, no token, no response body).
 *
 * Designed so it can be reused across providers (Microsoft, Slack, HubSpot,
 * Salesforce, etc.) — Google is the first user. New providers should add their
 * own error-code allowlist and call `recordOAuthRefreshFailure` (or a thin
 * provider-specific wrapper) on their failure path.
 *
 * Background: a Google Workspace refresh token silently failed for one user
 * while two consumer Gmail accounts on the same machine kept refreshing fine.
 * The only signal was an unactionable empty-object pino log. Sentry tags here
 * answer "is this concentrated in one Workspace tenant?" without ever needing
 * raw account identifiers.
 */

import crypto from 'node:crypto';
import { getErrorReporter } from '@core/errorReporter';

/** Allowlist of well-known Google OAuth error codes (RFC 6749 + Google extensions). */
const KNOWN_GOOGLE_ERROR_CODES = new Set([
  'invalid_grant',
  'unauthorized_client',
  'invalid_client',
  'invalid_request',
  'invalid_scope',
  'unsupported_grant_type',
  'access_denied',
]);

export type DomainClass = 'consumer' | 'workspace' | 'unknown';

/**
 * Classify a Google account email as consumer (gmail.com / googlemail.com) or
 * workspace (any other domain — including custom Workspace domains).
 *
 * `unknown` is reserved for callers that cannot determine the email at all
 * (e.g., the credentials file is missing). Pass `consumer` / `workspace`
 * directly when you do know.
 */
export function classifyGoogleEmailDomain(email: string | undefined | null): DomainClass {
  if (!email) return 'unknown';
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return 'unknown';
  return (domain === 'gmail.com' || domain === 'googlemail.com') ? 'consumer' : 'workspace';
}

/**
 * Stable, anonymized cluster key for "is this systemic per-tenant?" queries.
 * SHA-256 of the lowercased email domain, truncated to 16 hex chars.
 *
 * Hashes the domain only (not the full email) so we never receive a per-user
 * identifier — only a per-tenant one. Truncation is intentional: 16 hex chars
 * (64 bits) is plenty to distinguish tenants in a Sentry tag without inflating
 * tag cardinality storage.
 */
export function tenantHashFromDomain(emailDomain: string): string {
  return crypto.createHash('sha256').update(emailDomain.toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Normalize a raw error code from a provider response into a known value or
 * `unknown`. Keeps the `oauth.error_code` Sentry tag low-cardinality and
 * defends against pathologically-shaped responses.
 */
export function normalizeGoogleErrorCode(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  return KNOWN_GOOGLE_ERROR_CODES.has(raw) ? raw : 'unknown';
}

/**
 * Parse and normalize Google's OAuth `error` code from a raw response body.
 *
 * This helper only extracts a low-cardinality code. It performs no logging,
 * no Sentry reporting, and no retry/throttling decisions.
 */
export function parseGoogleErrorCode(responseBodyText: string): string {
  let parsedCode: unknown;
  try {
    parsedCode = JSON.parse(responseBodyText)?.error;
  } catch {
    parsedCode = undefined;
  }
  return normalizeGoogleErrorCode(parsedCode);
}

export interface GoogleRefreshFailureContext {
  /** HTTP status code from the refresh request. */
  httpStatus: number;
  /**
   * Raw response body text, used only locally to extract Google's `error`
   * field via best-effort JSON parse. Never forwarded to Sentry.
   */
  responseBodyText: string;
  /**
   * Email domain only (e.g., `mindstone.com`, `gmail.com`) — never the full
   * email address. Hashed before being sent to Sentry.
   */
  emailDomain: string;
  domainClass: DomainClass;
}

/**
 * Report a Google OAuth refresh failure to Sentry.
 *
 * Contract:
 * - Never throws. Failures inside the reporter (e.g., misconfigured Sentry,
 *   network errors during transport, scope mutator throws) are swallowed so
 *   the original OAuth error path is never masked.
 * - Sends NO PII. Only domain class, hashed domain, normalized error code,
 *   and HTTP status reach Sentry.
 * - Falls back to `captureException` if `captureExceptionWithScope` is not
 *   implemented by the active reporter (the interface declares it optional).
 *
 * Note: per-window reporting throttling is intentionally handled by
 * `oauthRefreshFailureStore`, not this telemetry helper.
 */
export function recordGoogleOAuthRefreshFailure(ctx: GoogleRefreshFailureContext): void {
  try {
    const errorCode = parseGoogleErrorCode(ctx.responseBodyText);
    const tenantHash = tenantHashFromDomain(ctx.emailDomain);
    const reporter = getErrorReporter();

    reporter.addBreadcrumb({
      category: 'oauth.refresh',
      message: 'google refresh failed',
      level: 'warning',
      data: {
        provider: 'google',
        error_code: errorCode,
        http_status: ctx.httpStatus,
        domain_class: ctx.domainClass,
      },
    });

    // Sanitized error message — the raw response body must not appear in the
    // Sentry exception value (beforeSend redacts event.message and event.extra
    // but not exception values, so we keep this constant by construction).
    const sanitizedError = new Error('Google OAuth token refresh failed');

    if (reporter.captureExceptionWithScope) {
      reporter.captureExceptionWithScope(sanitizedError, scope => {
        scope.setTag('oauth.provider', 'google');
        scope.setTag('oauth.error_code', errorCode);
        scope.setTag('oauth.http_status', String(ctx.httpStatus));
        scope.setTag('oauth.domain_class', ctx.domainClass);
        scope.setTag('oauth.tenant_hash', tenantHash);
      });
    } else {
      reporter.captureException(sanitizedError, {
        oauth_provider: 'google',
        oauth_error_code: errorCode,
        oauth_http_status: ctx.httpStatus,
        oauth_domain_class: ctx.domainClass,
        oauth_tenant_hash: tenantHash,
      });
    }
  } catch (err) {
    // Wave 2d (W2D-6) sentinel: re-throw KnownConditionGuardError so the
    // Wave 2c deterministic-CI-failure contract (KNOWN_CONDITION_GUARD_LEVEL=throw
    // in NODE_ENV=test) survives this fail-safe wrapper. Production behaviour
    // is unchanged (env-knob unset → warn; throw-mode outside test → warn).
    // See docs/plans/260503_wave2d_layer2_contract_completion.md (Wave 2d).
    if (
      process.env.NODE_ENV === 'test' &&
      (err as { name?: string } | null)?.name === 'KnownConditionGuardError'
    ) {
      throw err;
    }
    // Reporting must never mask the original OAuth error. Swallowed by
    // contract — the caller will continue to throw / return its existing
    // failure shape.
  }
}
