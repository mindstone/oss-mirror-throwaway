/**
 * MCP Instance Utilities
 * 
 * Shared utilities for multi-instance MCP support.
 * Used by both main and renderer processes.
 */

/**
 * Generate a collision-resistant instance ID from MCP name and email.
 * Format: {MCPName}-{email-slug} (e.g., "GoogleWorkspace-greg-work-com")
 * 
 * Slugging rules:
 * - Lowercase
 * - Only [a-z0-9-] characters allowed
 * - Replace ALL non-alphanumeric chars with `-` (including @, ., +, etc.)
 * - Collapse consecutive dashes
 * - Remove leading/trailing dashes
 * 
 * @example
 * generateInstanceId('GoogleWorkspace', '[external-email]') // 'GoogleWorkspace-greg-work-com'
 * generateInstanceId('HubSpot', '[external-email]') // 'HubSpot-sales-acme-com'
 * generateInstanceId('GoogleWorkspace', '[external-email]') // 'GoogleWorkspace-user-tag-gmail-com'
 */
export const generateInstanceId = (mcpName: string, email: string): string => {
  const slug = email
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-') // Replace ALL non-alphanumeric with dash
    .replace(/-+/g, '-') // Collapse consecutive dashes
    .replace(/^-|-$/g, ''); // Remove leading/trailing dashes
  return `${mcpName}-${slug}`;
};

/**
 * Extract email slug from an instance ID.
 * Inverse of generateInstanceId (approximate - loses @ vs . distinction).
 * 
 * @example
 * extractEmailSlug('GoogleWorkspace-greg-work-com') // 'greg-work-com'
 */
export const extractEmailSlug = (instanceId: string, baseName: string): string | null => {
  if (!instanceId.startsWith(`${baseName}-`)) {
    return null;
  }
  return instanceId.slice(baseName.length + 1);
};

/**
 * Parse an email slug back to approximate email format.
 * Note: This is an approximation since slugging loses @ vs . distinction.
 * 
 * @example
 * parseEmailFromSlug('greg-work-com') // '[external-email]' (approximate)
 */
export const parseEmailFromSlug = (slug: string): string => {
  const parts = slug.split('-');
  if (parts.length >= 3) {
    const local = parts[0];
    const domain = parts.slice(1).join('.');
    return `${local}@${domain}`;
  }
  return slug;
};

/**
 * Generate a collision-resistant instance ID from MCP name and workspace name.
 * Format: {MCPName}-{workspace-slug} (e.g., "Slack-mindstone", "Slack-acme-corp")
 * 
 * Uses same slugging rules as generateInstanceId for consistency.
 * 
 * @example
 * generateWorkspaceInstanceId('Slack', 'Mindstone') // 'Slack-mindstone'
 * generateWorkspaceInstanceId('Slack', 'Acme Corp') // 'Slack-acme-corp'
 */
export const generateWorkspaceInstanceId = (mcpName: string, workspaceName: string): string => {
  const slug = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-') // Replace ALL non-alphanumeric with dash
    .replace(/-+/g, '-') // Collapse consecutive dashes
    .replace(/^-|-$/g, ''); // Remove leading/trailing dashes
  return `${mcpName}-${slug}`;
};

/**
 * List of MCP connector types that support multiple instances via email identity.
 * These connectors use email address as the account identifier.
 *
 * Microsoft 365 has 5 base names (one per service) because each service is a separate
 * MCP server, unlike Google which uses a single GoogleWorkspace server per account.
 */
export const EMAIL_INSTANCE_CONNECTOR_TYPES = [
  'GoogleWorkspace',
  'HubSpot',
  'Salesforce',
  'Fathom',
  'EmailImap',
  'Microsoft365Mail',
  'Microsoft365Calendar',
  'Microsoft365Files',
  'Microsoft365Teams',
  'Microsoft365SharePoint',
] as const;

/**
 * List of MCP connector types that support multiple instances via workspace identity.
 * These connectors use workspace/team name as the account identifier.
 */
export const WORKSPACE_INSTANCE_CONNECTOR_TYPES = ['Slack', 'Linear'] as const;

export type EmailInstanceConnectorType = typeof EMAIL_INSTANCE_CONNECTOR_TYPES[number];
export type WorkspaceInstanceConnectorType = typeof WORKSPACE_INSTANCE_CONNECTOR_TYPES[number];

/**
 * Check if a connector type uses email-based instance identity.
 */
export const isEmailInstanceConnector = (connectorName: string): boolean => {
  return EMAIL_INSTANCE_CONNECTOR_TYPES.includes(connectorName as EmailInstanceConnectorType);
};

/**
 * Check if a server name is a multi-instance server and extract info.
 * Handles both email-based instances (GoogleWorkspace, HubSpot, Salesforce)
 * and workspace-based instances (Slack, Linear).
 * 
 * @returns Object with isInstance flag and parsed info, or null values if not an instance
 */
export const parseMultiInstanceServer = (serverName: string): {
  isInstance: boolean;
  baseName: string | null;
  emailSlug: string | null;
  workspaceSlug: string | null;
  instanceType: 'email' | 'workspace' | null;
} => {
  // Check email-based instances first
  for (const baseName of EMAIL_INSTANCE_CONNECTOR_TYPES) {
    if (serverName.startsWith(`${baseName}-`) && serverName.length > baseName.length + 1) {
      const emailSlug = serverName.slice(baseName.length + 1);
      return { isInstance: true, baseName, emailSlug, workspaceSlug: null, instanceType: 'email' };
    }
  }
  // Check workspace-based instances
  for (const baseName of WORKSPACE_INSTANCE_CONNECTOR_TYPES) {
    if (serverName.startsWith(`${baseName}-`) && serverName.length > baseName.length + 1) {
      const workspaceSlug = serverName.slice(baseName.length + 1);
      return { isInstance: true, baseName, emailSlug: null, workspaceSlug, instanceType: 'workspace' };
    }
  }
  return { isInstance: false, baseName: null, emailSlug: null, workspaceSlug: null, instanceType: null };
};
