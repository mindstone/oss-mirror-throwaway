/**
 * Shared auth-hint derivation for connector cards.
 *
 * The Settings UI (`McpToolList`) renders different affordances based on `authHint`:
 * - `'oauth'` -> "Re-authenticate" button when the server is unavailable
 * - `'api-key'` -> "Your API key may be invalid or expired." message
 * - `'none'` -> generic "The service may be unavailable." message
 *
 * Historically this was derived from catalog metadata only. That broke custom
 * (non-catalog) OAuth MCPs: after a user (or Rebel acting on their behalf)
 * manually added an OAuth entry to `super-mcp-router.json`, the renderer had no
 * catalog metadata to consult, so the card showed the generic "service may be
 * unavailable" message with no way to re-authenticate.
 *
 * This helper augments the catalog-based derivation with a fallback that reads
 * `serverPreview.oauth` (which mirrors the persisted `oauth: true` config field).
 * Custom OAuth connectors now render the OAuth affordance, giving users a
 * recoverable path into the browser auth flow.
 *
 * @see docs-private/investigations/260424_REBEL-1H7_custom_mcp_oauth_not_triggering.md
 */

import type { ConnectorCatalogEntry } from '@shared/types/mcp';

export type ConnectorAuthHint = 'oauth' | 'api-key' | 'none';

interface ConnectorAuthHintInputs {
  catalogEntry?: ConnectorCatalogEntry | undefined;
  serverPreview?: { oauth?: boolean } | undefined;
}

export function deriveConnectorAuthHint(inputs: ConnectorAuthHintInputs): ConnectorAuthHint {
  const { catalogEntry, serverPreview } = inputs;

  // Catalog-based derivation takes precedence (it carries the most accurate auth metadata).
  if (
    catalogEntry?.mcpConfig?.oauth === true ||
    catalogEntry?.bundledConfig?.authType === 'oauth' ||
    catalogEntry?.bundledConfig?.authType === 'oauth-user-provided'
  ) {
    return 'oauth';
  }
  if (catalogEntry?.bundledConfig?.authType === 'api-key') {
    return 'api-key';
  }

  // Fallback: trust the persisted server config for custom (non-catalog) connectors.
  // Only `true` is meaningful — avoids false positives for non-OAuth servers.
  if (serverPreview?.oauth === true) {
    return 'oauth';
  }

  return 'none';
}
