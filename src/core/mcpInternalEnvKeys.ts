/**
 * Env keys that are Rebel-internal plumbing — not user-editable, not user-credential.
 * Filtered from advanced config editor and excluded from migration credential preservation.
 */
export const INTERNAL_ENV_KEYS = new Set<string>([
  'ACCOUNTS_PATH',
  'CREDENTIALS_PATH',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'LOG_MODE',
  'MCP_HOST_BRIDGE_STATE',
  'MCP_MODE',
  // MINDSTONE_REBEL_BRIDGE_STATE retained for migration of pre-rename user configs
  // — strip from settings UI + drop during credential preservation. Remove once
  // we're confident no users have it cached.
  'MINDSTONE_REBEL_BRIDGE_STATE',
  'MINDSTONE_REBEL_CONNECTOR_CATALOG_PATH',
  'NODE_PATH',
]);
