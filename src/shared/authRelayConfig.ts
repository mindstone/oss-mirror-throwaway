/**
 * Auth Relay Provider Configuration
 *
 * Single source of truth for the provider-to-path mapping used by the auth
 * relay system.  Three consumers share this mapping:
 *
 * - `cloud-service/src/routes/auth.ts`          – receives relayed tokens
 * - `src/main/services/cloud/cloudTokenRelay.ts` – watches & relays tokens
 * - `src/main/services/bundledMcpCloudRegistration.ts` – discovers OAuth MCPs
 *
 * Previously each file maintained its own copy with "must match" comments.
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

/** All providers supported by the auth relay system. */
export type RelayProvider =
  | 'super-mcp'
  | 'freshdesk'
  | 'google-workspace'
  | 'slack'
  | 'hubspot'
  | 'salesforce'
  | 'microsoft';

/** OAuth providers — all relay providers except super-mcp. */
export type OAuthRelayProvider = Exclude<RelayProvider, 'super-mcp'>;

/** All known relay provider names (useful for runtime validation). */
export const RELAY_PROVIDERS: readonly RelayProvider[] = [
  'super-mcp',
  'freshdesk',
  'google-workspace',
  'slack',
  'hubspot',
  'salesforce',
  'microsoft',
] as const;

// ---------------------------------------------------------------------------
// Provider → base path mapping
// ---------------------------------------------------------------------------

/**
 * Relative directory segments for each OAuth provider under the data path.
 * super-mcp is excluded because it uses the user home directory instead.
 */
const OAUTH_PROVIDER_PATH_SEGMENTS: Record<OAuthRelayProvider, readonly string[]> = {
  'freshdesk': ['mcp', 'freshdesk'],
  'google-workspace': ['google-workspace-mcp'],
  'slack': ['mcp', 'slack'],
  'hubspot': ['mcp', 'hubspot'],
  'salesforce': ['mcp', 'salesforce'],
  'microsoft': ['microsoft-mcp'],
};

/**
 * Resolve the base filesystem path for a given auth relay provider.
 *
 * - **super-mcp**: tokens live under `<homedir>/.super-mcp/oauth-tokens`
 * - **all others**: credentials live under `<dataPath>/<provider-subdir>`
 *
 * @param provider - The relay provider identifier
 * @param dataPath - App data directory (`/data` on cloud, `app.getPath('userData')` on desktop)
 * @param homedir  - User home directory (only needed for super-mcp)
 */
export function resolveProviderBasePath(
  provider: RelayProvider,
  dataPath: string,
  homedir: string,
): string {
  if (provider === 'super-mcp') {
    return path.join(homedir, '.super-mcp', 'oauth-tokens');
  }
  return path.join(dataPath, ...OAUTH_PROVIDER_PATH_SEGMENTS[provider]);
}

// ---------------------------------------------------------------------------
// Path safety validation
// ---------------------------------------------------------------------------

/**
 * Validate that a relative path is safe for use in auth relay operations.
 * Guards against directory traversal (`..`), absolute paths, and colon-based
 * scheme prefixes (e.g. `C:\` on Windows).
 */
export function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.trim().length === 0) return false;
  if (path.isAbsolute(relativePath)) return false;
  if (relativePath.includes(':')) return false;

  const segments = relativePath.split(/[\\/]+/);
  return !segments.some((segment) => segment === '..');
}
