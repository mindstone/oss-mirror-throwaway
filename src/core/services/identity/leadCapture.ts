/**
 * Best-effort, fire-and-forget lead-capture egress for the OSS build.
 *
 * When an OSS user voluntarily fills in the optional "About you" onboarding
 * block (name + email), the email is POSTed to Mindstone's unauthenticated
 * `POST /api/oss/lead` endpoint as a consented lead capture (disclosed at the
 * point of entry — see the ApiStep "About you" block). This is the ONLY
 * Mindstone network egress in the otherwise analytics-dark OSS build, and it is
 * deliberately separate from RudderStack/Sentry/telemetry.
 *
 * LOAD-BEARING INVARIANT: this helper NEVER throws to its caller. Any network
 * failure, timeout, or non-2xx response is caught and logged (structured, no
 * raw PII), and the function resolves to void. Onboarding must never block,
 * delay, or fail because of this call. The caller fires it without awaiting.
 *
 * Platform-agnostic (electron-free): `appVersion`/`platform` are passed in by
 * the caller (the Electron main handler sources them via `getPlatformConfig()`,
 * NOT from the renderer payload).
 */

/** Minimal structured-logger shape (compatible with the pino-based core logger). */
export interface LeadCaptureLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface OssLeadCaptureInput {
  /** Optional first name (already user-typed; the server re-validates). */
  firstName?: string;
  /** Required email (the endpoint requires it; callers must skip when empty). */
  email: string;
  /** App version, sourced from PlatformConfig in the main handler. */
  appVersion: string;
  /** OS platform, sourced from PlatformConfig in the main handler. */
  platform: string;
}

export interface OssLeadCaptureDeps {
  /** Base Mindstone API URL, e.g. MINDSTONE_API_URL. */
  apiUrl: string;
  /** Structured logger for observable failures. */
  log: LeadCaptureLogger;
  /** Injectable fetch (defaults to global fetch) — eases testing. */
  fetchImpl?: typeof fetch;
  /** Timeout in ms before the request is aborted. Defaults to 5000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * POST a lead to Mindstone. Best-effort + fire-and-forget: resolves to void
 * regardless of outcome; failures are logged, never thrown.
 */
export async function postOssLeadCapture(
  input: OssLeadCaptureInput,
  deps: OssLeadCaptureDeps,
): Promise<void> {
  const { apiUrl, log } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // The endpoint requires an email; a name-only submission must not POST.
  // Callers also guard this, but defend here so the invariant holds everywhere.
  if (!input.email) {
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${apiUrl}/api/oss/lead`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: input.firstName,
        email: input.email,
        source: 'oss-onboarding',
        appVersion: input.appVersion,
        platform: input.platform,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Observable degradation — log status + context, never the email/name.
      log.warn(
        { status: response.status, source: 'oss-onboarding' },
        'OSS lead-capture POST returned a non-2xx status (best-effort; onboarding unaffected)',
      );
    }
  } catch (error) {
    // Network error / timeout / abort. Best-effort: swallow into a structured
    // log (no raw PII), never propagate.
    log.warn(
      {
        err: error instanceof Error ? error.name : 'unknown',
        source: 'oss-onboarding',
      },
      'OSS lead-capture POST failed (best-effort; onboarding unaffected)',
    );
  } finally {
    clearTimeout(timer);
  }
}
