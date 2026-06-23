/**
 * Redacting console wrapper for the Rebel browser extension.
 *
 * Sensitive values (pairing codes, session tokens) must never land in
 * `chrome.runtime` logs verbatim — developer tools bleed those straight into
 * the background console and we don't want a shared screenshare to leak them.
 *
 * This module is intentionally tiny: a plain console-like surface with a
 * fixed-field redactor that strips known-secret keys from structured data
 * before delegating to the real console. See R29 in the Stage 6a plan.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ConsoleLike {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface LoggerOptions {
  /** Component prefix (e.g. "[offscreen]"). */
  prefix?: string;
  /** Console-compatible backend. Defaults to the global `console`. */
  backend?: ConsoleLike;
  /** Extra sensitive keys to redact, merged with the defaults. */
  extraSecretKeys?: readonly string[];
}

/** Case-insensitive keys whose values are replaced with '[redacted]'. */
const DEFAULT_SECRET_KEYS: readonly string[] = [
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'sessionToken',
  'session_token',
  'authorization',
  'auth',
  'bearer',
  'code',
  'pairCode',
  'pair_code',
  'pairingCode',
  'pairing_code',
  'claimCode',
  'claim_code',
  'oneTimeCode',
  'one_time_code',
  'secret',
  'apiKey',
  'api_key',
  'password',
];

const REDACTED = '[redacted]';

/**
 * Redact secrets from a value before logging.
 *
 * Strings containing JWT-shaped payloads or long hex tokens are redacted
 * wholesale (they may appear as positional args). Objects and arrays are
 * recursively scrubbed, with any key whose lowercase name matches the
 * secret list replaced by '[redacted]'.
 *
 * Depth is bounded to 6 so a malformed cyclic object can't hang logging.
 */
export function redact(
  value: unknown,
  secretKeys: readonly string[] = DEFAULT_SECRET_KEYS,
  depth = 0,
): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, secretKeys, depth + 1));
  }

  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const lowerKeys = secretKeys.map((k) => k.toLowerCase());
    for (const key of Object.keys(src)) {
      if (lowerKeys.includes(key.toLowerCase())) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(src[key], secretKeys, depth + 1);
      }
    }
    return out;
  }

  // primitives: number, boolean, bigint, symbol
  return value;
}

/**
 * Replace JWT-shaped tokens and obvious long opaque codes inside a raw string
 * before it hits the console. This catches the common "I accidentally logged
 * `Bearer <jwt>`" footgun.
 */
function redactString(value: string): string {
  // JWT: three base64url segments joined with dots, each >=10 chars
  const jwtRe = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
  let out = value.replace(jwtRe, REDACTED);
  // Bearer-prefixed opaque token
  out = out.replace(/(Bearer\s+)[A-Za-z0-9_.~+/=-]{12,}/gi, `$1${REDACTED}`);
  // hex/base64 tokens >= 32 chars without surrounding structure
  out = out.replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, REDACTED);
  return out;
}

/**
 * Build a redacting logger. Each call delegates to the backend with the
 * prefix prepended and every argument recursively scrubbed.
 */
export function createLogger(options: LoggerOptions = {}): ConsoleLike {
  const backend: ConsoleLike = options.backend ?? console;
  const prefix = options.prefix ? `[rebel]${options.prefix} ` : '[rebel] ';
  const secretKeys = options.extraSecretKeys
    ? [...DEFAULT_SECRET_KEYS, ...options.extraSecretKeys]
    : DEFAULT_SECRET_KEYS;

  const emit =
    (level: LogLevel) =>
    (...args: unknown[]): void => {
      const scrubbed = args.map((a) => redact(a, secretKeys));
      const method: (...a: unknown[]) => void = backend[level];
      method.call(backend, prefix + level.toUpperCase(), ...scrubbed);
    };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}

/** Exposed for tests — the list of keys we redact by default. */
export const DEFAULT_REDACTED_KEYS: readonly string[] = DEFAULT_SECRET_KEYS;
