import { createScopedLogger } from '@core/logger';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import { registerAuthOrchestrator, type AuthOrchestratorContext, type AuthOrchestratorResult } from './mcpService';
import { resolveOAuthCredentials, slackCredentialSource } from './oauthCredentials';
import { startSlackAuth } from './slackAuthService';

const log = createScopedLogger({ service: 'slack-auth-orchestrator' });

/**
 * Host-side OAuth orchestrator dispatched when the npx-spawned Slack MCP
 * subprocess returns a structured `auth_required` response from
 * `authenticate_slack_workspace`. The catalog's `bundledConfig.authApi`
 * key is `'slackApi'`; `invokeStdioAuthenticateTool` looks up the
 * orchestrator registered under that key and calls it with the agent's
 * tool-call context.
 *
 * Asymmetry with HubSpot: Slack OAuth is workspace-agnostic at flow start
 * (the user picks the workspace inside Slack's own UI during the OAuth
 * handshake), so this orchestrator ignores `ctx.email`. We pass
 * `autoOpen: false` so the caller can render the URL as a clickable link
 * via the `authUrl` field rather than spawning a browser ourselves —
 * matches the `auth_required` user_action contract.
 */
export async function runSlackAuthOrchestrator(
  ctx: AuthOrchestratorContext,
): Promise<AuthOrchestratorResult> {
  const credentials = resolveOAuthCredentials(slackCredentialSource);
  if (!credentials) {
    const guidance = describeMissingOAuthCredentials('slack');
    return {
      success: false,
      error: guidance.message,
      setupGuidance: guidance,
    };
  }

  try {
    const { authUrl } = startSlackAuth(credentials.clientId, credentials.clientSecret, {
      autoOpen: false,
    });
    return { success: true, authUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      { err: message, authApi: ctx.authApi, userActionId: ctx.userAction.id },
      'Slack host OAuth orchestrator failed',
    );
    return { success: false, error: message };
  }
}

export function registerSlackApiAuthOrchestrator(): void {
  registerAuthOrchestrator('slackApi', runSlackAuthOrchestrator);
}
