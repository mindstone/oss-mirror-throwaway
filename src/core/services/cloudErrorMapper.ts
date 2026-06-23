/**
 * Cloud Error Mapper
 *
 * Maps raw provider error strings into user-friendly, actionable error info.
 * Lives in @core — no renderer imports. Returns a `helpKey` string that
 * the renderer resolves to a URL via cloudProviders.config.ts.
 *
 * Pattern-matching approach: match known substrings/patterns in raw error
 * strings and use context (failedStep, phase, httpStatus) to disambiguate.
 */

import { categorize } from '@core/services/cloud/cloudErrorCategory';

export type CloudErrorCategory =
  | 'auth_invalid'
  | 'auth_insufficient'
  | 'sso_required'
  | 'billing_required'
  | 'rate_limited'
  | 'capacity'
  | 'resource_creation_failed'
  | 'dns_timeout'
  | 'dns_resolution_failed'
  | 'cert_issuance_failed'
  | 'service_boot_failed'
  | 'health_check_timeout'
  | 'network_unreachable'
  | 'manifest_error'
  | 'machine_not_started'
  | 'image_pull_transient'
  | 'cleanup_failed'
  | 'cloudflare_missing'
  | 'managed_not_signed_in'
  | 'managed_unavailable'
  | 'managed_self_service_rejected'
  | 'managed_update_interrupted'
  | 'unknown';

export type CloudErrorHelpKey =
  | 'token_help'
  | 'sso_token_help'
  | 'provider_dashboard'
  | 'provider_billing'
  | 'dns_setup'
  | 'export_diagnostics'
  | 'rate_limit_wait'
  | 'cloudflare_setup'
  | undefined;

export interface CloudErrorInfo {
  category: CloudErrorCategory;
  userMessage: string;
  guidance: string;
  helpKey: CloudErrorHelpKey;
  severity: 'warning' | 'error';
  technicalDetail: string;
  /**
   * Optional extra context extracted from the raw error (e.g. Fly org slug
   * embedded in a `[cloud:billing_required:<orgSlug>]` marker). Renderers
   * use this to deep-link to the right billing page.
   */
  providerContext?: { orgSlug?: string };
  /**
   * If the raw provider error is human-readable and we fell back to the
   * `unknown` category, this echoes the provider's own message so the user
   * still gets actionable detail. Empty/undefined when the raw error was
   * JSON/HTTP-code-ish and would leak noise to the UI.
   */
  providerDetail?: string;
}

export interface CloudErrorContext {
  providerId?: string;
  phase?: string;
  failedStep?: number;
  httpStatus?: number;
}

interface ErrorRule {
  test: (raw: string, ctx: CloudErrorContext) => boolean;
  category: CloudErrorCategory;
  userMessage: string;
  guidance: string;
  helpKey: CloudErrorHelpKey;
  severity: 'warning' | 'error';
}

const RULES: ErrorRule[] = [
  // Managed cloud — not signed in
  {
    test: (raw, ctx) =>
      ctx.providerId === 'mindstone' &&
      /not signed in/i.test(raw),
    category: 'managed_not_signed_in',
    userMessage: 'Please sign in to use Mindstone Cloud.',
    guidance: 'Sign in with your Mindstone account and try again.',
    helpKey: undefined,
    severity: 'error',
  },

  // Managed cloud — temporarily unavailable
  {
    test: (raw, ctx) =>
      ctx.providerId === 'mindstone' &&
      /temporarily unavailable/i.test(raw),
    category: 'managed_unavailable',
    userMessage: 'Mindstone Cloud is temporarily unavailable. We\'re on it.',
    guidance: 'Wait a few minutes and try again.',
    helpKey: undefined,
    severity: 'warning',
  },

  // Managed cloud — repair/update self-service rejected
  {
    test: (raw) =>
      /managed instances are maintained automatically/i.test(raw),
    category: 'managed_self_service_rejected',
    userMessage: 'Managed cloud keeps itself up to date. No action needed here.',
    guidance: 'If something seems off, try "Check status" in Cloud Sync, or contact support.',
    helpKey: undefined,
    severity: 'warning',
  },

  // Managed cloud — automatic update was interrupted and will retry
  {
    test: (raw) =>
      /reset from stale updating state/i.test(raw) ||
      /worker interrupted before completion/i.test(raw),
    category: 'managed_update_interrupted',
    userMessage: "An update didn't finish cleanly. We've reset and will try again on the next cycle.",
    guidance: "Nothing to do — managed cloud retries itself. If you'd rather not wait, click \"Update now\".",
    helpKey: undefined,
    severity: 'warning',
  },

  // SSO required — Fly org requires Single Sign On for token creation.
  // Must precede auth_invalid because the raw error typically still mentions
  // "token" and would otherwise match the generic auth rule.
  {
    test: (raw) =>
      /\[cloud:sso_required[:\]]/i.test(raw) ||
      /single sign[- ]on/i.test(raw) ||
      /requires sso/i.test(raw) ||
      /sso[- ]required/i.test(raw),
    category: 'sso_required',
    userMessage: "Your Fly organization requires SSO, so personal access tokens don't work here.",
    guidance: 'Create an org-scoped token instead — in a terminal, run `fly tokens create org --org <your-org-slug>`, then paste the output here.',
    helpKey: 'sso_token_help',
    severity: 'error',
  },

  // Billing required — provider refuses to create resources without a
  // payment method on file (most common Fly first-setup failure, plus DO
  // and Hetzner equivalents and generic HTTP 402).
  {
    test: (raw, ctx) =>
      ctx.httpStatus === 402 ||
      /\b402\b/.test(raw) ||
      /\[cloud:billing_required[:\]]/i.test(raw) ||
      /payment method/i.test(raw) ||
      /billing\s+(required|not set up|is required)/i.test(raw) ||
      /add (a )?credit card/i.test(raw) ||
      /payment verification/i.test(raw),
    category: 'billing_required',
    userMessage: 'Your cloud provider needs a payment method on file before it can create your storage.',
    guidance: "Add a card in your provider's billing settings — they only charge for what you use, not the reserved volume size. Then try again.",
    helpKey: 'provider_billing',
    severity: 'error',
  },

  // Image pull — manifest unauthorized (cloud image moved or is private).
  // Matches the 0.4.34 GHCR org-rename failure and any future image-config
  // drift where Fly receives a 401/unauthorized fetching the manifest.
  // Must run BEFORE the generic `auth_invalid` rule (which would otherwise
  // match `\b401\b` and route the user to "regenerate your token") because
  // the unauthorized response here is from the image registry, not the
  // user's Fly token — so the fix is "update Rebel", not "regenerate token".
  // Gated on resource-creation steps (3-6) so token-validation 401s at
  // step 1 still flow into `auth_invalid`.
  {
    test: (raw, ctx) =>
      ctx.failedStep !== undefined &&
      ctx.failedStep >= 3 &&
      ctx.failedStep <= 6 &&
      /failed to get manifest/i.test(raw) &&
      (/unauthorized/i.test(raw) || /\b401\b/.test(raw)),
    category: 'manifest_error',
    userMessage: "The cloud image isn't available right now.",
    guidance: 'This usually means Rebel needs an update — update the app and try again. If you are already on the latest version, contact support.',
    helpKey: 'export_diagnostics',
    severity: 'error',
  },

  // Image pull — transient TCP failure between the provider and the
  // container registry CDN (e.g. "connection reset by peer" mid-blob
  // download). Not auth, not config — a third-party network glitch that
  // typically clears on retry. Severity is warning because the user's
  // setup is fine; they just got unlucky on this attempt.
  {
    test: (raw, ctx) =>
      (ctx.failedStep !== undefined && ctx.failedStep >= 3 && ctx.failedStep <= 6) &&
      (/failed to get (blob|manifest)/i.test(raw) || /failed to launch/i.test(raw)) &&
      (/connection reset by peer/i.test(raw) ||
        /read tcp [^\n]*: read:/i.test(raw) ||
        /i\/o timeout/i.test(raw) ||
        /connection refused/i.test(raw)),
    category: 'image_pull_transient',
    userMessage: 'A network glitch interrupted setup.',
    guidance: 'This is usually transient — try again in a moment.',
    helpKey: undefined,
    severity: 'warning',
  },

  // Auth — 401 / invalid token
  {
    test: (raw, ctx) =>
      ctx.httpStatus === 401 ||
      /\b401\b/.test(raw) ||
      /invalid.*token/i.test(raw) ||
      /Invalid (Fly\.io|DigitalOcean|Hetzner).*token/i.test(raw),
    category: 'auth_invalid',
    userMessage: "That token didn't work. Double-check it — it may have expired or lack the right permissions.",
    guidance: 'Generate a new token from your provider dashboard and try again.',
    helpKey: 'token_help',
    severity: 'error',
  },

  // Auth — insufficient permissions (403 or permission-related)
  {
    test: (raw, ctx) =>
      ctx.httpStatus === 403 ||
      /\b403\b/.test(raw) ||
      /permission/i.test(raw) ||
      /may not have permission/i.test(raw),
    category: 'auth_insufficient',
    userMessage: 'Your token works but lacks the required permissions.',
    guidance: 'Create a new token with read + write access.',
    helpKey: 'token_help',
    severity: 'error',
  },

  // Cloudflare credentials missing
  {
    test: (raw) => /cloudflare credentials/i.test(raw),
    category: 'cloudflare_missing',
    userMessage: 'DNS configuration is not available for this provider.',
    guidance: 'This provider requires DNS setup via Cloudflare. Contact support if this is unexpected.',
    helpKey: 'cloudflare_setup',
    severity: 'error',
  },

  // Rate limiting
  {
    test: (raw, ctx) =>
      ctx.httpStatus === 429 ||
      /\b429\b/.test(raw) ||
      /rate.?limit/i.test(raw) ||
      /too many requests/i.test(raw),
    category: 'rate_limited',
    userMessage: "We're being rate-limited. Give it a few minutes and try again.",
    guidance: 'Wait 2-3 minutes, then retry.',
    helpKey: 'rate_limit_wait',
    severity: 'warning',
  },

  // Region capacity — the provider has no host in the chosen region that can
  // satisfy the request (Fly: 422 "capacity", or 412 "insufficient resources
  // to create new machine with existing volume"). This is actionable, not a
  // transient blip: retrying the same region keeps failing. Must run BEFORE
  // the generic resource_creation_failed rule so the user gets the
  // "try a different region" guidance instead of "wait and try again".
  {
    test: (raw) =>
      /not enough capacity in region/i.test(raw) ||
      /insufficient resources to create new machine/i.test(raw) ||
      /\bcapacity\b/i.test(raw),
    category: 'capacity',
    userMessage: "That region doesn't have capacity for this size right now.",
    guidance: 'Pick a different region and try again — capacity varies by location.',
    helpKey: 'provider_dashboard',
    severity: 'error',
  },

  // DNS resolution failed (bracketed marker from Stage 4)
  {
    test: (raw) => /\[cloud:dns_resolution_failed\]/i.test(raw),
    category: 'dns_resolution_failed',
    userMessage: "DNS isn't resolving for your cloud instance yet.",
    guidance: "This usually resolves within a few minutes. If it doesn't, check your domain settings.",
    helpKey: 'dns_setup',
    severity: 'warning',
  },

  // Certificate issuance failed (bracketed marker from Stage 4)
  {
    test: (raw) => /\[cloud:cert_issuance_failed\]/i.test(raw),
    category: 'cert_issuance_failed',
    userMessage: "HTTPS certificate hasn't been issued yet.",
    guidance: 'This can take up to 5 minutes with a new domain. Sit tight.',
    helpKey: 'dns_setup',
    severity: 'warning',
  },

  // Service boot failed (bracketed marker from Stage 4)
  {
    test: (raw) => /\[cloud:service_boot_failed\]/i.test(raw),
    category: 'service_boot_failed',
    userMessage: 'The server is running but the cloud service has not started.',
    guidance: 'Check your cloud provider dashboard for server logs.',
    helpKey: 'provider_dashboard',
    severity: 'error',
  },

  // DNS timeout (bracketed marker or legacy message)
  {
    test: (raw) =>
      /\[cloud:dns_timeout\]/i.test(raw) ||
      /dns.*propagat/i.test(raw) ||
      /DNS or certificate setup may have failed/i.test(raw),
    category: 'dns_timeout',
    userMessage: "DNS is still propagating. This can take a few minutes — sit tight.",
    guidance: 'Wait 5-10 minutes. If it still fails, check your provider dashboard.',
    helpKey: 'dns_setup',
    severity: 'warning',
  },

  // Health check timeout (generic)
  {
    test: (raw) =>
      /did not become healthy/i.test(raw) ||
      /health.*timed?\s*out/i.test(raw) ||
      /not yet healthy/i.test(raw),
    category: 'health_check_timeout',
    userMessage: 'Your cloud instance was created but is taking a while to start. This usually resolves in a few minutes.',
    guidance: 'Wait a minute, then check the status again from Settings.',
    helpKey: 'provider_dashboard',
    severity: 'warning',
  },

  // Machine/server not active (Fly machine not started, DO droplet not active, Hetzner server not ready)
  {
    test: (raw) =>
      /did not become active/i.test(raw) ||
      /did not become ready/i.test(raw) ||
      /machine.*not.*started/i.test(raw),
    category: 'machine_not_started',
    userMessage: 'The server was created but did not start in time.',
    guidance: 'Try again in a few minutes. If the problem persists, check your provider dashboard.',
    helpKey: 'provider_dashboard',
    severity: 'error',
  },

  // Manifest errors (GHCR)
  {
    test: (raw) =>
      /manifest unknown/i.test(raw) ||
      /manifest.*not found/i.test(raw),
    category: 'manifest_error',
    userMessage: 'Could not find the cloud service image.',
    guidance: 'This may be a temporary issue. Try again in a few minutes.',
    helpKey: 'export_diagnostics',
    severity: 'error',
  },

  // Network unreachable
  {
    test: (raw) => categorize(raw).kind === 'network',
    category: 'network_unreachable',
    userMessage: "Can't reach the server. Check your internet connection.",
    guidance: 'Make sure you are online and try again.',
    helpKey: undefined,
    severity: 'error',
  },

  // Resource creation failures (generic, matched by failedStep context)
  {
    test: (raw, ctx) =>
      (ctx.failedStep !== undefined && ctx.failedStep >= 3 && ctx.failedStep <= 6 &&
        /failed to (create|launch)/i.test(raw)),
    category: 'resource_creation_failed',
    userMessage: 'Failed to set up a cloud resource.',
    guidance: 'This may be a temporary provider issue. Wait a few minutes and try again.',
    helpKey: 'provider_dashboard',
    severity: 'error',
  },
];

/**
 * Parse optional bracketed context markers from the raw error, e.g.
 * `[cloud:billing_required:my-org]` or `[cloud:sso_required:fly]`. Returns
 * an orgSlug when present, so the renderer can deep-link to the right
 * billing / token page.
 */
function extractProviderContext(raw: string): { orgSlug?: string } | undefined {
  const match = raw.match(/\[cloud:(?:billing_required|sso_required):([^\]]+)\]/i);
  if (!match) return undefined;
  const slug = match[1].trim();
  if (!slug || slug === 'fly' || slug === 'digitalocean' || slug === 'hetzner') {
    // Marker exists but no org slug was supplied (provider-only marker).
    return undefined;
  }
  return { orgSlug: slug };
}

/**
 * Heuristic: is this raw error string human-readable enough to show as a
 * "provider said..." hint under an unknown fallback? We want to avoid
 * leaking raw JSON, HTTP codes, or stack traces into the UI.
 */
function isHumanReadableProviderDetail(raw: string): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (trimmed.length < 8) return false;
  if (trimmed.length > 400) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  if (/^\s*HTTP\s+\d{3}/i.test(trimmed)) return false;
  if (/^[A-Z_]+:\s/.test(trimmed)) return false; // e.g. "ENOTFOUND: ..."
  // Strip URLs before scanning for 4xx/5xx codes (we want the message
  // "... at fly.io/dashboard/..." to still count as readable).
  const scrubbed = trimmed.replace(/https?:\/\/\S+/g, '');
  if (/\b[45]\d{2}\b/.test(scrubbed)) return false;
  if (/\{[^}]*\}/.test(scrubbed)) return false;
  return true;
}

export function mapCloudError(rawError: string, context: CloudErrorContext = {}): CloudErrorInfo {
  const providerContext = extractProviderContext(rawError);
  for (const rule of RULES) {
    if (rule.test(rawError, context)) {
      return {
        category: rule.category,
        userMessage: rule.userMessage,
        guidance: rule.guidance,
        helpKey: rule.helpKey,
        severity: rule.severity,
        technicalDetail: rawError,
        ...(providerContext && { providerContext }),
      };
    }
  }

  const providerDetail = isHumanReadableProviderDetail(rawError) ? rawError : undefined;

  return {
    category: 'unknown',
    userMessage: "Setup stalled on something we didn't recognize.",
    guidance: 'Try again. If the issue persists, export diagnostics from Settings.',
    helpKey: 'export_diagnostics',
    severity: 'error',
    technicalDetail: rawError,
    ...(providerDetail && { providerDetail }),
  };
}
