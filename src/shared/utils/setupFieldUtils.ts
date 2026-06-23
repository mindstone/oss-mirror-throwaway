import type { SetupField } from '@shared/types';

/**
 * Build HTTP headers from setup fields that have headerKey defined.
 * Used for direct MCPs that use API key authentication via headers.
 *
 * @example
 * // PostHog: { apiKey: 'phx_123' } → { Authorization: 'Bearer phx_123' }
 */
export function buildHeadersFromSetupFields(
  fields: SetupField[],
  fieldValues: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const field of fields) {
    if (!field.headerKey) continue;
    // Booleans aren't valid header values — skip defensively even if a
    // catalog entry mistakenly pairs `type: 'boolean'` with `headerKey`.
    if (field.type === 'boolean') continue;

    const value = fieldValues[field.id]?.trim();
    if (!value) continue;

    headers[field.headerKey] = (field.headerPrefix || '') + value;
  }

  return headers;
}

/**
 * Build environment variables from setup fields that have envVar defined.
 * Used for community/rebel-oss MCPs that pass credentials and configuration
 * flags via environment.
 *
 * Boolean fields are passed through as the literal strings 'true'/'false'.
 * Their stored shape is already `'true'|'false'`, so we never elide the value
 * on falsy — `'false'` is meaningful and must reach the MCP env.
 */
export function buildEnvFromSetupFields(
  fields: SetupField[],
  fieldValues: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const field of fields) {
    if (!field.envVar) continue;

    const raw = fieldValues[field.id];

    if (field.type === 'boolean') {
      // Booleans are stored as 'true'|'false' strings. An undefined value
      // means "user has not toggled it yet" — fall back to the field default
      // (also a string) so the env var reflects the catalog's stated default
      // even before the user explicitly saves.
      const value = raw ?? field.default;
      if (value === undefined) continue;
      env[field.envVar] = value;
      continue;
    }

    const value = raw?.trim();
    if (!value) continue;

    env[field.envVar] = value;
  }

  return env;
}
