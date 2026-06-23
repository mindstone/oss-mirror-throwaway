import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'toolAuth' });

/**
 * Tool identifier for authentication - can be any tool name
 * The actual serverName is used for connector operations
 */
export type AuthToolType = string;

/**
 * Maps legacy tool types to server names
 * Note: New tools pass serverName directly, this is for backward compatibility
 * 
 * Important: Server names must match connector names exactly:
 * - Gmail: "gmail"
 * - Google Calendar: "google calendar"
 * - Outlook Mail: "outlook mail" (not "outlook")
 * - Outlook Calendar: "outlook calendar"
 * - Microsoft Teams: "microsoft teams"
 */
const TOOL_TO_SERVER: Record<string, string> = {
  email: 'gmail',
  calendar: 'google calendar',
  chat: 'slack',
  // New tool types use their serverName directly
  gmail: 'gmail',
  'google-calendar': 'google calendar',
  slack: 'slack',
  teams: 'microsoft teams',
  // Microsoft/Outlook tools - explicit serverName overrides
  'outlook-mail': 'outlook mail',
  'outlook-calendar': 'outlook calendar',
  // Other connectors
  hubspot: 'hubspot',
  notion: 'notion',
  'google-drive': 'google drive',
  fireflies: 'fireflies',
  mixpanel: 'mixpanel',
  pipedrive: 'pipedrive',
};

/**
 * Result of getting an auth URL
 */
export type GetAuthUrlResult = {
  success: boolean;
  authUrl?: string;
  error?: string;
};

/**
 * Result of verifying tool authentication
 */
export type VerifyAuthResult = {
  success: boolean;
  isAuthenticated: boolean;
  /** True if the tool check failed due to usage limit being exceeded */
  limitExceeded?: boolean;
  error?: string;
};

/**
 * Get the OAuth authentication URL for a specific tool.
 * 
 * @deprecated Use bundled MCP connectors for authentication.
 * This function now returns an error directing users to bundled connectors.
 */
export async function getToolAuthUrl(
  _settings: AppSettings,
  tool: AuthToolType,
  serverNameOverride?: string,
  _companyName?: string
): Promise<GetAuthUrlResult> {
  const serverName = serverNameOverride ?? TOOL_TO_SERVER[tool];
  log.info({ tool, serverName }, 'getToolAuthUrl called - use bundled MCP connectors');
  
  // Direct users to bundled MCP connectors
  return {
    success: false,
    error: 'Please use bundled MCP connectors for authentication.',
  };
}

/**
 * Verify if a tool is authenticated.
 * 
 * @deprecated Use bundled MCP connectors for authentication.
 * This function now returns an error directing users to bundled connectors.
 */
export async function verifyToolAuth(
  _settings: AppSettings,
  tool: AuthToolType,
  serverNameOverride?: string,
  _companyName?: string
): Promise<VerifyAuthResult> {
  const serverName = serverNameOverride ?? TOOL_TO_SERVER[tool];
  log.info({ tool, serverName }, 'verifyToolAuth called - use bundled MCP connectors');
  
  // Direct users to bundled MCP connectors
  return {
    success: false,
    isAuthenticated: false,
    error: 'Please use bundled MCP connectors for authentication.',
  };
}
