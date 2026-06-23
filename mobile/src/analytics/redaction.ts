/**
 * Analytics event-property redaction (mobile).
 *
 * Analytics events are a SEPARATE stream from Sentry, but the privacy bar is
 * the same: no message content, no raw emails, no raw cloud URLs, no file
 * paths, no secrets. We reuse the shared `redactObjectDeep` so analytics
 * inherits the exact same redaction rules Sentry uses (key-name SSOT + string
 * scrubbing for emails/paths/api-keys/url-params) — no fork.
 *
 * On top of the shared scrub we ENFORCE the analytics privacy contract
 * (`PRIVACY_CONTRACT.md`): a small set of property keys are forbidden outright
 * in analytics payloads (raw urls, emails, message/content bodies, file paths).
 * Forbidden keys are dropped (not just string-scrubbed) so a mis-named property
 * can never smuggle high-risk content into the analytics product, and any
 * session/cloud id is hashed rather than sent raw.
 *
 * `redactSentryEvent` / `redactObjectDeep` / the shared patterns are owned by
 * the cloud team this cycle and consumed here read-only.
 */

import { redactObjectDeep } from '@shared/utils/sentryRedaction';
import { telemetryHash } from '../utils/telemetryHash';

/**
 * Property keys forbidden in analytics payloads. These are dropped wholesale
 * (not string-redacted) because their *presence* — regardless of value — would
 * violate the contract: behavioural analytics never carries content,
 * destinations, identities, or locations as event properties.
 *
 * Identity (`email`) belongs on the SDK-managed identify() channel, never as a
 * track() property; the cloud URL is hashed and travels as `cloudUrlHash`.
 */
const FORBIDDEN_PROPERTY_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^url$/i,
  /^email$/i,
  /^cloudurl$/i,
  /^cloud_url$/i,
  /message/i,
  /content/i,
  /transcript/i,
  /(?:^|[._-])path$/i,
  /filepath/i,
  /file_path/i,
  /^prompt$/i,
  /^body$/i,
];

/** True when a property key is forbidden in analytics payloads. */
export function isForbiddenAnalyticsKey(key: string): boolean {
  return FORBIDDEN_PROPERTY_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/** Id-shaped keys whose raw value is hashed (not dropped) before emission. */
const ID_SHAPED_KEY_REGEX = /^(?:cloudurl|cloud_url|sessionid|session_id)$/i;

/**
 * Stable, non-reversible hash for ids (session ids, cloud urls) so analytics
 * can correlate without storing the raw identifier. Delegates to the shared
 * `telemetryHash` (`mobile/src/utils/telemetryHash.ts`) which Sentry
 * (`setSentryCloudContext`) ALSO calls — so the same cloud URL produces the
 * SAME token across the Sentry + analytics streams (DA #2). Kept as a named
 * export for existing call sites/tests; new code may call `telemetryHash`
 * directly.
 */
export function hashId(value: string): string {
  return telemetryHash(value);
}

/**
 * Recursively strip forbidden keys and hash id-shaped keys at ANY depth.
 *
 * A forbidden key must be dropped wherever it appears — a payload like
 * `{ metadata: { message: "raw", prompt: "..." } }` must not survive just
 * because the offending key is nested. We therefore walk plain objects and
 * arrays applying the same key policy at every level, BEFORE handing the result
 * to the shared deep string-scrub. (The shared scrub only redacts known string
 * patterns; it does not drop keys, so the drop must happen here.)
 */
function stripForbiddenKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripForbiddenKeysDeep(item));
  }

  // Only recurse into plain object bags. Leave class instances / null / scalars
  // as-is (the shared deep scrub handles scalar string content).
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // Hash id-shaped properties rather than carrying them raw. This runs
      // BEFORE the forbidden-key drop because `cloudUrl` is both id-shaped
      // (hash it) and a forbidden raw key (never emit the raw value) — hashing
      // satisfies both.
      if (ID_SHAPED_KEY_REGEX.test(key) && typeof child === 'string') {
        out[`${key}Hash`] = hashId(child);
        continue;
      }

      if (isForbiddenAnalyticsKey(key)) {
        // Drop forbidden keys entirely — at any depth — do not even string-scrub.
        continue;
      }

      out[key] = stripForbiddenKeysDeep(child);
    }
    return out;
  }

  return value;
}

/** True for a plain `{}` object literal (not arrays, class instances, etc.). */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Scrub an analytics event-property bag before it leaves the device:
 *
 *  1. RECURSIVELY drop any forbidden key (url/email/message/content/path/...)
 *     at any depth, and hash any `cloudUrl`/`sessionId`-shaped id into a stable
 *     token.
 *  2. Run the shared deep redaction over the remainder (emails/paths/secrets
 *     in nested strings, sensitive key names).
 *
 * Returns a new object; never mutates the input. Never throws — a redaction
 * failure must not block emission of an already-safe-by-construction event.
 */
export function redactAnalyticsProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = stripForbiddenKeysDeep(properties) as Record<string, unknown>;
  return redactObjectDeep(stripped) as Record<string, unknown>;
}
