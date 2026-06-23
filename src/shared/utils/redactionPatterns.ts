export const ANTHROPIC_API_KEY_REGEX = /sk-ant-[a-zA-Z0-9_-]+/g;
export const OPENAI_API_KEY_REGEX = /sk-[a-zA-Z0-9_-]{20,}/g;
export const ELEVENLABS_API_KEY_JSON_REGEX = /"elevenlabsApiKey"\s*:\s*"[^"]+"/g;
export const JSON_STRING_KEY_VALUE_REGEX = /"([^"]+)"\s*:\s*"([^"]*)"/g;
export const GENERIC_JSON_SECRET_REGEX = /"(api[_-]?key|apiKey|token|secret|client_secret|signing_secret|slack_signing_secret|bot_token|oauth_code|oauth_state)"\s*:\s*"[^"]+"/gi;

/**
 * Shared SSOT for object key names whose values are secrets.
 *
 * Matching is intentionally substring/non-anchored for the specific secret
 * families that historically relied on that behavior (`apiKey`,
 * `accessToken`, `clientSecret`, `writeKey`, etc.) plus generic secret words
 * such as `password`, `secret`, `credential`, `bearer`, and `authorization`.
 * We do not use broad `/token/` or `/key/` patterns because settings also
 * contain non-secret token/count/key concepts.
 *
 * Included classes:
 * - Provider credential maps: `providerKeys` / `provider_keys` exactly.
 * - API keys: `apiKey`, `api_key`.
 * - OAuth/session tokens: `oauthToken`, `accessToken`, `refreshToken`,
 *   `idToken`, `botToken`, `cloudToken` and snake_case variants.
 * - OAuth authorization codes/state: `oauthCode`, `oauth_state`, and
 *   camelCase/snake_case variants.
 * - Client/signing/private secrets: `clientSecret`, `signingSecret`,
 *   `slackSigningSecret`, `privateKey` and snake_case variants.
 * - Generic secret-bearing names: `password`, `secret`, `credential`,
 *   `bearer`, `authorization`. `secret_settings` is excluded because existing
 *   Sentry tests classify it as non-secret settings metadata.
 * - Event/write credentials and JWTs: `writeKey`, `jwt`.
 * - Request signatures: exact `signature`.
 * - App Bridge credentials: `routerToken`, `routerInternalToken`,
 *   `pairingCode`, `pairCode` and snake_case variants.
 *
 * Deliberately excluded: config-looking URLs/endpoints/IDs such as
 * `dataPlaneUrl`; classify those at the call site or add a specific entry here
 * only after confirming the value is secret.
 */
export const SENSITIVE_KEY_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^providerKeys$/i,
  /^provider_keys$/i,
  /apiKey/i,
  /api_key/i,
  /oauthCode/i,
  /oauth_code/i,
  /oauthState/i,
  /oauth_state/i,
  /oauthToken/i,
  /oauth_token/i,
  /accessToken/i,
  /access_token/i,
  /refreshToken/i,
  /refresh_token/i,
  /idToken/i,
  /id_token/i,
  /botToken/i,
  /bot_token/i,
  /cloudToken/i,
  /cloud_token/i,
  /clientSecret/i,
  /client_secret/i,
  /signingSecret/i,
  /signing_secret/i,
  /slackSigningSecret/i,
  /slack_signing_secret/i,
  /password/i,
  /secret(?!_settings)/i,
  /credential/i,
  /bearer/i,
  /authorization/i,
  /writeKey/i,
  /write_key/i,
  /privateKey/i,
  /private_key/i,
  /jwt/i,
  /^signature$/i,
  /routerToken/i,
  /router_token/i,
  /routerInternalToken/i,
  /router_internal_token/i,
  /pairingCode/i,
  /pairing_code/i,
  /pairCode/i,
  /pair_code/i,
  // SCREAMING_SNAKE env-secret suffixes (e.g. MCP connector env vars like
  // HUBSPOT_PRIVATE_APP_TOKEN, NOTION_API_TOKEN, *_SECRET, *_PASSWORD). Anchored
  // and singular by design: matches `*_TOKEN` but NOT benign token-count
  // telemetry keys (`MAX_TOKENS`, `input_tokens`, `tokenBudget`, …) — broadening
  // to a bare /token/i would over-redact that telemetry. See B5 / cluster
  // telemetry-redaction-parity.
  /_(TOKEN|SECRET|PASSWORD|API_KEY)$/,
];

export function isSensitiveKeyName(key: string): boolean {
  return SENSITIVE_KEY_NAME_PATTERNS.some((pattern) => pattern.test(key));
}

export const MACOS_HOME_DIRECTORY_REGEX = /\/Users\/[^/\s"]+/g;
export const LINUX_HOME_DIRECTORY_REGEX = /\/home\/[^/\s"]+/g;
export const WINDOWS_HOME_DIRECTORY_REGEX = /[A-Z]:\\Users\\[^\\"]+/gi;

/**
 * Email-shaped substrings, including URL-encoded `%40` separators: provider
 * HTTP errors routinely echo request URLs whose path segments are URL-encoded
 * emails (e.g. Google calendarIds in events-path URLs carry
 * `user%40domain.com`). Mirrors the calendar-channel scrub's
 * `EMAIL_SHAPED_SUBSTRING` widening (260611 calendar PII-leak postmortem).
 */
export const EMAIL_ADDRESS_REGEX = /[a-zA-Z0-9._%+-]+(?:@|%40)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Bearer tokens in authorization headers. Covers JWTs (base64url charset)
// and most opaque tokens. The /gi flags ensure case-insensitive, global match.
export const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9_.\-]{20,}/gi;

export const SENSITIVE_URL_PARAM_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /strata_id=[^&\s"']+/gi, replacement: 'strata_id=***REDACTED***' },
  { pattern: /bearer=[^&\s"']+/gi, replacement: 'bearer=***REDACTED***' },
  { pattern: /access_token=[^&\s"']+/gi, replacement: 'access_token=***REDACTED***' },
  { pattern: /refresh_token=[^&\s"']+/gi, replacement: 'refresh_token=***REDACTED***' },
  { pattern: /oauth_code=[A-Za-z0-9.-]{20,}/gi, replacement: 'oauth_code=***REDACTED***' },
  { pattern: /([?&])code=[A-Za-z0-9.-]{20,}/gi, replacement: '$1code=***REDACTED***' },
  { pattern: /oauth_state=[^&\s"']+/gi, replacement: 'oauth_state=***REDACTED***' },
  { pattern: /([?&])state=[^&\s"']+/gi, replacement: '$1state=***REDACTED***' },
  { pattern: /api_key=[^&\s"']+/gi, replacement: 'api_key=***REDACTED***' },
  { pattern: /apikey=[^&\s"']+/gi, replacement: 'apikey=***REDACTED***' },
  { pattern: /token=[^&\s"']+/gi, replacement: 'token=***REDACTED***' },
  { pattern: /bot_token=[^&\s"']+/gi, replacement: 'bot_token=***REDACTED***' },
  { pattern: /signing_secret=[^&\s"']+/gi, replacement: 'signing_secret=***REDACTED***' },
  { pattern: /slack_signing_secret=[^&\s"']+/gi, replacement: 'slack_signing_secret=***REDACTED***' },
  { pattern: /client_secret=[^&\s"']+/gi, replacement: 'client_secret=***REDACTED***' },
  { pattern: /secret=[^&\s"']+/gi, replacement: 'secret=***REDACTED***' },
  { pattern: /:\/\/([^:@/\s"']+):([^@\s"']+)@/gi, replacement: '://$1:***REDACTED***@' },
];
