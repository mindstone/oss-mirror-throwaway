/**
 * Codex OAuth mode types — extracted to avoid circular dependency
 * (types.ts → openaiClient.ts → openaiTranslators.ts → openaiTypes.ts).
 *
 * Consumed by: types.ts (AgentToolContext), queryRouter.ts, rebelCoreQuery.ts,
 * clientFactory.ts, and openaiClient.ts.
 */

/**
 * Codex mode config — injected by the executor when Codex OAuth is connected
 * and no dedicated API key is present. Routes all requests through the Codex
 * Responses endpoint (chatgpt.com) using the user's ChatGPT subscription
 * instead of consuming pay-as-you-go API credits.
 *
 * Callbacks are used instead of direct imports to keep src/core/ free of
 * Electron dependencies (the auth service lives in src/main/).
 */
export interface CodexModeConfig {
  /** The Codex Responses API endpoint URL */
  endpointUrl: string;
  /** Check whether Codex OAuth tokens are still present before starting work */
  isConnected?: () => boolean;
  /** Get a valid access token (auto-refreshes if expiring) */
  getAccessToken: () => Promise<string | null>;
  /** Get the ChatGPT account ID for the organization header */
  getAccountId: () => string | null;
  /** Force-refresh the access token (e.g., after a 401) */
  forceRefreshToken: () => Promise<string | null>;
}
