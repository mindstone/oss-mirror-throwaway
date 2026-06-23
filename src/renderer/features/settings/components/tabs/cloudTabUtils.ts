/**
 * CloudTab Utilities
 *
 * Pure utility functions, constants, and validation logic extracted from CloudTab.tsx.
 * These are testable in isolation and will be shared across CloudTab and its future hooks.
 */

import { categorize, type CloudErrorCategory } from '@core/services/cloud/cloudErrorCategory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Update/rollback status reported by the cloud's `/api/health` (`cloudUpdate`
 * field — see cloud-service `computeCloudUpdateStatus`). `recently-rolled-back`
 * means the pre-bootstrap watchdog rejected a bad image and the cloud is now
 * running its last-known-good (older but stable) build.
 */
export interface CloudUpdateHealth {
  status: 'ok' | 'recently-rolled-back';
  quarantinedTags: string[];
  lastKnownGoodImageTag?: string;
  currentImageTag?: string;
}

export interface CloudHealthInfo {
  version: string;
  buildCommit: string;
  buildDate: string;
  uptimeSeconds: number;
  cloudUpdate?: CloudUpdateHealth;
}

/** Defensively parse the `/api/health` `cloudUpdate` field (additive; absent on older clouds). */
export function parseCloudUpdateHealth(raw: unknown): CloudUpdateHealth | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const status =
    obj.status === 'recently-rolled-back' ? 'recently-rolled-back'
      : obj.status === 'ok' ? 'ok'
        : undefined;
  if (!status) return undefined;
  const quarantinedTags = Array.isArray(obj.quarantinedTags)
    ? obj.quarantinedTags.filter((t): t is string => typeof t === 'string')
    : [];
  return {
    status,
    quarantinedTags,
    lastKnownGoodImageTag: typeof obj.lastKnownGoodImageTag === 'string' ? obj.lastKnownGoodImageTag : undefined,
    currentImageTag: typeof obj.currentImageTag === 'string' ? obj.currentImageTag : undefined,
  };
}

export interface CloudRollbackNotice {
  tone: 'info' | 'warning';
  title: string;
  body: string;
}

/**
 * User-facing notice when the cloud auto-recovered from a bad update (the
 * watchdog rolled back to the last-known-good image; the cloud is running fine
 * on an earlier build). Returns null when there's nothing to surface (status
 * `ok` / field absent on an older cloud). Copy honors the silent-update
 * philosophy: managed users get a soft, reassuring "we're handling it"; BYOK
 * users get the same transparency plus a nudge that they can retry the update.
 *
 * `canCheckForUpdates` gates the "use Check for updates below" wording on the
 * affordance actually being rendered — a non-managed *manual-connect* user
 * (no auto-provisioned update controls) gets the transparency without a
 * reference to a button that isn't there.
 */
export function getCloudRollbackNotice(
  isManaged: boolean,
  cloudUpdate: CloudUpdateHealth | undefined,
  opts: { canCheckForUpdates?: boolean } = {},
): CloudRollbackNotice | null {
  if (!cloudUpdate || cloudUpdate.status !== 'recently-rolled-back') return null;
  if (isManaged) {
    return {
      tone: 'info',
      title: 'Cloud auto-recovered from a bad update',
      body: 'A recent update didn’t start cleanly, so your cloud automatically rolled back to the last working version and is running normally. Mindstone is handling it — your cloud will update again automatically once a fix ships. No action needed.',
    };
  }
  const retryHint = opts.canCheckForUpdates
    ? ' — or use “Check for updates” below to retry now'
    : '';
  return {
    tone: 'warning',
    title: 'Cloud auto-recovered from a bad update',
    body: `A recent update didn’t start cleanly, so your cloud automatically rolled back to the last working version and is running normally on an earlier build. It’ll move forward automatically when a newer image is published${retryHint}.`,
  };
}

// ---------------------------------------------------------------------------
// Status Constants
// ---------------------------------------------------------------------------

export const STATUS_DOT: Record<string, string> = {
  running: 'var(--color-success)',
  warm: 'var(--color-warning)',
  cold: 'var(--color-text-muted)',
  provisioning: 'var(--color-accent)',
  error: 'var(--color-destructive)',
};

export const STATUS_LABEL: Record<string, string> = {
  running: 'Up to date',
  warm: 'Syncing',
  cold: 'Offline (queued)',
  provisioning: 'Syncing',
  error: 'Needs attention',
};

export const STATUS_BLURB: Record<string, string> = {
  running: 'Continuity is on and current.',
  warm: 'Continuity is catching up. Give it a moment.',
  cold: 'Cloud is offline for now. Changes queue until it wakes.',
  provisioning: "We're setting up continuity. Hang tight.",
  error: '', // Handled dynamically by getErrorBlurb()
};

/**
 * Witty phase descriptions. Dry, self-aware, never silly.
 *
 * `estimate` is intentionally optional: the `workspace` and `extract` phases
 * intentionally have no static estimate because the renderer derives a live
 * ETA from `ThroughputEstimator` samples (see Stage 7 of
 * `docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md`).
 * Keeping a static placeholder would re-introduce the "1\u20135 minutes" lie
 * that Stage 7 was written to remove.
 */
export const PHASE_COPY: Record<string, { label: string; detail: string; estimate?: string | null }> = {
  settings: {
    label: 'Migrating settings',
    detail: 'Shipping your preferences to the cloud. Careful with the fragile ones.',
    estimate: 'A few seconds',
  },
  'mcp-config': {
    label: 'Syncing tools & integrations',
    detail: 'Your MCP servers and OAuth tokens are moving house.',
    estimate: 'A few seconds',
  },
  workspace: {
    label: 'Uploading workspace',
    detail: 'Packing your files into a neat archive. Larger workspaces take longer.',
    // Intentionally no static estimate \u2014 the renderer derives one from real
    // throughput samples (Stage 7) and shows "Estimating..." before it has
    // enough data.
    estimate: null,
  },
  extract: {
    label: 'Extracting on cloud',
    detail: 'The server is unpacking your archive. Almost there.',
    // Same reasoning as `workspace` \u2014 live ETA or nothing.
    estimate: null,
  },
  'app-data': {
    label: 'Uploading app data',
    detail: 'Actions, automations, memory \u2014 the whole filing cabinet.',
    estimate: 'Under a minute',
  },
  sessions: {
    label: 'Migrating conversations',
    detail: 'Every conversation, one at a time. Thorough, not fast.',
    estimate: '1\u20133 minutes for hundreds of sessions',
  },
  complete: {
    label: 'All done',
    detail: 'Your cloud brain is fully loaded. Reloading to pick up the new data.',
    estimate: '',
  },
};

export const PROVISION_PHASE_COPY: Record<string, { label: string; detail: string; estimate?: string }> = {
  validating: { label: 'Checking credentials', detail: 'Making sure your token works.', estimate: 'A few seconds' },
  'creating-app': { label: 'Creating your instance', detail: 'Setting up a private cloud space just for you.' },
  'setting-secrets': { label: 'Securing access', detail: 'Configuring encryption and access keys.' },
  'creating-volume': { label: 'Setting up storage', detail: 'Creating a persistent home for your data.' },
  'creating-machine': { label: 'Launching', detail: 'Spinning up your cloud machine. Almost there.', estimate: '1\u20132 minutes' },
  waiting: { label: 'Starting up', detail: 'Waiting for everything to come online. First launch takes the longest.', estimate: '1\u20133 minutes' },
  'health-check': { label: 'Final check', detail: 'Making sure everything is running smoothly.' },
  complete: { label: 'Ready to go', detail: 'Your cloud is live. Syncing your data now.' },
  failed: { label: 'Something went wrong', detail: 'We hit a snag. Any created resources were cleaned up.' },
};

export const UPDATE_PHASE_COPY: Record<string, { label: string; detail: string }> = {
  deploying: { label: 'Deploying new version...', detail: 'Waiting for restart.' },
  restarting: { label: 'Restarting...', detail: 'Shutting down old version.' },
  starting: { label: 'Starting up...', detail: 'This can take a minute for cold starts.' },
  health_check: { label: 'Almost there...', detail: 'Waiting for health checks.' },
  verifying: { label: 'Verifying...', detail: 'Confirming the new version is live.' },
  stalled: { label: 'Taking longer than expected', detail: 'No progress in a while. You can keep waiting or stop.' },
  backstop: { label: 'Still waiting...', detail: 'This is taking unusually long. Your cloud may still be updating in the background.' },
};

export const MANAGED_REGIONS = [
  { value: 'ams', label: 'Amsterdam (ams)' },
  { value: 'arn', label: 'Stockholm (arn)' },
  { value: 'bom', label: 'Mumbai (bom)' },
  { value: 'cdg', label: 'Paris (cdg)' },
  { value: 'dfw', label: 'Dallas (dfw)' },
  { value: 'ewr', label: 'Newark (ewr)' },
  { value: 'fra', label: 'Frankfurt (fra)' },
  { value: 'gru', label: 'São Paulo (gru)' },
  { value: 'iad', label: 'Washington DC (iad)' },
  { value: 'jnb', label: 'Johannesburg (jnb)' },
  { value: 'lax', label: 'Los Angeles (lax)' },
  { value: 'lhr', label: 'London (lhr)' },
  { value: 'nrt', label: 'Tokyo (nrt)' },
  { value: 'ord', label: 'Chicago (ord)' },
  { value: 'sin', label: 'Singapore (sin)' },
  { value: 'sjc', label: 'San Jose (sjc)' },
  { value: 'syd', label: 'Sydney (syd)' },
  { value: 'yyz', label: 'Toronto (yyz)' },
] as const;

// ---------------------------------------------------------------------------
// Pure Utility Functions
// ---------------------------------------------------------------------------

export function isManagedUpdateInterruptedError(lastError?: string): boolean {
  if (!lastError) {
    return false;
  }

  const lower = lastError.toLowerCase();
  return lower.includes('reset from stale updating') || lower.includes('worker interrupted before completion');
}

export function shouldHideRawErrorDetail(lastError?: string, category?: CloudErrorCategory): boolean {
  if (category) {
    return category.kind !== 'unknown';
  }

  return isManagedUpdateInterruptedError(lastError);
}

function getCategorizedErrorBlurb(category: CloudErrorCategory): string {
  switch (category.kind) {
    case 'network':
      return `Cloud instance isn't responding — it may be asleep, restarting, or the URL may be wrong. Try "Check status" or verify your server is running.`;
    case 'auth':
      if (category.subkind === 'forbidden') {
        return 'Access denied by the cloud instance. The token may have been rotated or revoked.';
      }
      return 'Authentication failed — your access token was rejected. Update it under Advanced troubleshooting > Connection details.';
    case 'cloud_down':
      if (category.subkind === 'reported_unhealthy') {
        return 'Cloud responded but reported itself as unhealthy. It may still be starting up — try "Check status" in a minute.';
      }
      if (category.subkind === 'deprovisioning') {
        return 'Cloud is being reprovisioned. It may need a minute before it responds again.';
      }
      return `Cloud returned a server error. It may be restarting or overloaded — wait a minute, then try "Check status".`;
    case 'unknown':
      if (!category.rawMessage || category.rawMessage === 'undefined') {
        return 'Something went wrong, but no details were captured. Try "Check status" to refresh.';
      }
      return `${category.rawMessage}. Try "Check status" to refresh, or check Troubleshooting below.`;
  }
}

/** Map a raw error string to a user-friendly blurb for the status panel. */
export function getErrorBlurb(lastError?: string, category?: CloudErrorCategory): string {
  if (category) {
    return getCategorizedErrorBlurb(category);
  }

  if (!lastError) return 'Something went wrong, but no details were captured. Try "Check status" to refresh.';

  if (isManagedUpdateInterruptedError(lastError))
    return `Your last update didn't finish cleanly. Managed cloud will retry automatically — or click "Update now" if you'd rather not wait.`;

  const lower = lastError.toLowerCase();

  if (lower.includes('timeout') || lower.includes('abort') || lower.includes('failed to fetch') || lower.includes('unreachable'))
    return `Cloud instance isn't responding — it may be asleep, restarting, or the URL may be wrong. Try "Check status" or verify your server is running.`;

  if (lower.includes('http 401') || lower.includes('invalid token') || lower.includes('unauthorized'))
    return 'Authentication failed — your access token was rejected. Update it under Advanced troubleshooting > Connection details.';

  if (lower.includes('http 403') || lower.includes('forbidden'))
    return 'Access denied by the cloud instance. The token may have been rotated or revoked.';

  if (lower.includes('http 502') || lower.includes('http 503') || lower.includes('http 504'))
    return `Cloud returned a server error (${lastError}). It may be restarting or overloaded — wait a minute, then try "Check status".`;

  if (lower.includes('http 5'))
    return `Cloud returned an error: ${lastError}. Try "Check status" again in a moment.`;

  if (lower.includes('unhealthy'))
    return 'Cloud responded but reported itself as unhealthy. It may still be starting up — try "Check status" in a minute.';

  return `${lastError}. Try "Check status" to refresh, or check Troubleshooting below.`;
}

// ---------------------------------------------------------------------------
// Update-check error display
// ---------------------------------------------------------------------------

/**
 * How a failed cloud update-check should be presented to the user.
 *
 * `tone: 'muted'` is a calm, non-alarming "still warming up" signal — used for
 * cold-boot network aborts/timeouts where the machine simply hasn't answered
 * yet (continuity is fine; we just couldn't reach it to check for an update).
 * `tone: 'error'` is a genuine failure shown via the sanitized {@link getErrorBlurb}
 * blurb (never the raw `DOMException`/internal string).
 */
export interface UpdateCheckErrorDisplay {
  tone: 'muted' | 'error';
  text: string;
}

/**
 * Decide how to render a failed cloud update-check.
 *
 * Why this exists: the update-check is the only cloud error stream that used to
 * surface its raw `err.message` straight into red destructive text, so a
 * cold-boot `AbortSignal.timeout` ("The operation was aborted due to timeout")
 * leaked to the user as a scary error while continuity was actually fine. This
 * routes that stream through the same {@link categorize} taxonomy + sanitizer as
 * every other stream:
 *
 * - A network abort/timeout is treated as a SOFT "still starting up" signal
 *   (`tone: 'muted'`), not a hard error — on both the auto-check and a
 *   user-initiated check (an abort/timeout means "couldn't check yet", not
 *   "update failed").
 * - Any other failure stays a real error but is shown via {@link getErrorBlurb},
 *   so the raw message never reaches the user.
 *
 * Pass either a pre-computed `category` (preferred — matches the other streams,
 * keeps the raw string for logs) or just the raw `rawError` (it will be
 * categorized here).
 */
export function getUpdateCheckErrorDisplay(
  rawError: string | null | undefined,
  category?: CloudErrorCategory,
): UpdateCheckErrorDisplay {
  const cat = category ?? (rawError ? categorize(rawError) : undefined);

  if (cat && cat.kind === 'network' && (cat.subkind === 'abort' || cat.subkind === 'timeout')) {
    return {
      tone: 'muted',
      text: 'Cloud is still starting up — couldn’t check for updates yet. Try again in a minute.',
    };
  }

  return { tone: 'error', text: getErrorBlurb(rawError ?? undefined, cat) };
}

/** Format a relative time string from an epoch timestamp. */
export function relativeTime(epochMs: number | undefined): string {
  if (!epochMs) return 'Never';
  const ms = Date.now() - epochMs;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Format uptime seconds into a human-readable string (e.g. "2d 5h", "3h 12m"). */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** Format a build date ISO string into a friendly label (e.g. "Built today", "Built Apr 5"). */
export function formatBuildDate(dateStr: string): string {
  if (!dateStr || dateStr === 'unknown') return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Built today';
    // Use 'en-US' explicitly so the label stays consistent with the hardcoded
    // English "Built" prefix and doesn't become e.g. "Built 5 avr." on non-English
    // systems or CI runners with a different default locale.
    return `Built ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  } catch {
    return '';
  }
}

/** Detect the nearest managed region based on the user's timezone. */
export function detectNearestRegion(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const mapping: Record<string, string> = {
      'America/New_York': 'ewr', 'America/Chicago': 'ord', 'America/Denver': 'dfw',
      'America/Los_Angeles': 'lax', 'America/Toronto': 'yyz', 'America/Sao_Paulo': 'gru',
      'Europe/London': 'lhr', 'Europe/Amsterdam': 'ams', 'Europe/Paris': 'cdg',
      'Europe/Berlin': 'fra', 'Europe/Stockholm': 'arn',
      'Asia/Tokyo': 'nrt', 'Asia/Singapore': 'sin', 'Asia/Kolkata': 'bom', 'Asia/Calcutta': 'bom',
      'Australia/Sydney': 'syd', 'Africa/Johannesburg': 'jnb',
    };
    if (mapping[tz]) return mapping[tz];
    const prefix = tz.split('/')[0];
    if (prefix === 'America') return 'iad';
    if (prefix === 'Europe') return 'fra';
    if (prefix === 'Asia') return 'sin';
    if (prefix === 'Australia' || prefix === 'Pacific') return 'syd';
    if (prefix === 'Africa') return 'jnb';
  } catch { /* ignore */ }
  return 'iad';
}

/** Fetch health info from a cloud instance's /api/health endpoint. */
export async function fetchHealthInfo(cloudUrl: string, signal?: AbortSignal): Promise<CloudHealthInfo | null> {
  try {
    const resp = await fetch(`${cloudUrl.replace(/\/+$/, '')}/api/health`, {
      signal: signal ?? AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;
    const body = await resp.json() as Record<string, unknown>;
    if (body.status !== 'ok') return null;
    return {
      version: String(body.version ?? ''),
      buildCommit: String(body.buildCommit ?? ''),
      buildDate: String(body.buildDate ?? ''),
      uptimeSeconds: typeof body.uptime === 'number' ? body.uptime : 0,
      cloudUpdate: parseCloudUpdateHealth(body.cloudUpdate),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Heuristic shape-check for a Fly.io Personal Access Token (`FlyV1 fm2_...`).
 *
 * We use this to catch a real UX failure mode: users with a Fly cloud often
 * have multiple tokens in their world (cloud bridge token, Fly PAT, Anthropic
 * API key, ...). Pasting the Fly PAT into either the URL or cloud-token field
 * always fails — the cloud bridge token is opaque random bytes, never starts
 * with "FlyV1". Catching it client-side gives a much clearer error than the
 * generic "Invalid token" 401 from `/api/settings`.
 *
 * Conservative match: requires the literal "FlyV1" prefix. Any future token
 * format change on Fly's side just falls through to server-side validation.
 */
export function looksLikeFlyPat(value: string): boolean {
  return /^FlyV1\s+fm2_/i.test(value.trim());
}

/** Validate connect form inputs. Returns error message or null if valid. */
export function validateConnectInputs(url: string, token: string): string | null {
  const trimmedUrl = url.trim().replace(/\/+$/, '');
  if (!trimmedUrl) return 'Enter the server URL.';
  if (looksLikeFlyPat(trimmedUrl)) {
    return 'That looks like a Fly.io access token, not a server URL. The URL should be a https://… address.';
  }
  if (!trimmedUrl.startsWith('http')) return 'URL must start with https:// or http://';
  const trimmedToken = token.trim();
  if (!trimmedToken) return 'Enter the access token.';
  if (looksLikeFlyPat(trimmedToken)) {
    return 'That looks like a Fly.io access token, not a cloud server token. Use "Connect Fly.io access token" under Advanced troubleshooting instead.';
  }
  return null;
}

/** Check if a connect is a token-only reconnect (same URL, new token). */
export function isTokenOnlyReconnect(newUrl: string, existingCloudUrl?: string): boolean {
  return !!existingCloudUrl && newUrl === existingCloudUrl;
}

/**
 * Whether the "Connect Fly.io access token" recovery section should be visible.
 *
 * Two cases unlock the same UI/IPC flow (`cloud:link-fly-token`), since both
 * resolve to "no Fly PAT in safeStorage on this machine":
 *
 *   1. Connected to a *.fly.dev cloud, but BYOK metadata is missing — the
 *      original "promote managed/manual instance to BYOK" path. We can't tell
 *      from settings alone whether the token is actually stored, so we always
 *      offer the form here (handler is idempotent).
 *
 *   2. BYOK metadata is present but `hasFlyToken === false` — the instance was
 *      provisioned by an older build that didn't yet persist the token via
 *      safeStorage, OR a partial deprovision/repair cleared it. Without the
 *      token, tier changes, infra repair, and desktop-side update checks all
 *      fail with "Fly API token not found".
 *
 * `hasFlyToken === null` means we haven't checked yet — don't show the form
 * during the brief loading window to avoid flicker on every Cloud tab open.
 */
export function shouldShowFlyTokenLinkForm(args: {
  isConnected: boolean;
  isManaged: boolean;
  isFlyByok: boolean;
  isFlyUrl: boolean;
  hasFlyToken: boolean | null;
}): boolean {
  const { isConnected, isManaged, isFlyByok, isFlyUrl, hasFlyToken } = args;
  if (!isConnected || isManaged) return false;
  // Case 1: connected to *.fly.dev, BYOK metadata not yet populated.
  if (!isFlyByok && isFlyUrl) return true;
  // Case 2: BYOK metadata present, but local token is known-missing.
  if (isFlyByok && hasFlyToken === false) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Format helpers (Stage 7 \u2014 honest migration progress)
//
// Consumed by `MigrationProgressBar` to render live upload/extract detail
// lines ("3 min \u00b7 27% \u00b7 240/900 MB") without fabricating numbers when
// the underlying data is unavailable.
// ---------------------------------------------------------------------------

/**
 * Format a byte count as a compact string (KB / MB / GB). Returns `'\u2014'`
 * when the value is missing or not finite \u2014 we never fabricate a size.
 */
export function formatMB(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '\u2014';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Format an ETA (in seconds) as a short human string \u2014 `"45s"` for
 * sub-minute estimates, `"3 min"` for longer ones. Returns `'\u2014'` when the
 * value is missing, negative, or not finite (e.g. `Infinity` while stalled).
 */
export function formatEta(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '\u2014';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const min = Math.round(seconds / 60);
  return `${min} min`;
}

/**
 * Compose the compact detail line for a live upload/extract event.
 * Shape: `"3 min \u00b7 27% \u00b7 240/900 MB"` (em-dash middots per brand voice).
 *
 * Individual parts degrade to `'\u2014'` when missing so the overall shape is
 * preserved even before `ThroughputEstimator` has enough samples.
 */
export function formatDetailLine(
  etaSeconds: number | undefined,
  progressPercent: number,
  bytesSent: number | undefined,
  bytesTotal: number | undefined,
): string {
  const eta = formatEta(etaSeconds);
  const safePct = Number.isFinite(progressPercent) ? Math.round(progressPercent) : 0;
  const pct = `${safePct}%`;
  const bytes = bytesTotal != null && Number.isFinite(bytesTotal)
    ? `${formatMB(bytesSent)}/${formatMB(bytesTotal)}`
    : '\u2014';
  return `${eta} \u00b7 ${pct} \u00b7 ${bytes}`;
}
