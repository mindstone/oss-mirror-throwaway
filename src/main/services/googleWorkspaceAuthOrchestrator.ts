import { createScopedLogger } from '@core/logger';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import { registerAuthOrchestrator, type AuthOrchestratorContext, type AuthOrchestratorResult } from './mcpService';
import { resolveOAuthCredentials, googleCredentialSource } from './oauthCredentials';
import { startGoogleAuth } from './googleWorkspaceAuthService';

const log = createScopedLogger({ service: 'google-workspace-auth-orchestrator' });

export async function runGoogleWorkspaceAuthOrchestrator(
  ctx: AuthOrchestratorContext,
): Promise<AuthOrchestratorResult> {
  const credentials = resolveOAuthCredentials(googleCredentialSource);
  if (!credentials) {
    const guidance = describeMissingOAuthCredentials('google');
    return {
      success: false,
      error: guidance.message,
      setupGuidance: guidance,
    };
  }

  try {
    const authUrl = await startGoogleAuth(
      credentials.clientId,
      credentials.clientSecret,
      {
        targetEmail: ctx.email,
        returnMode: 'authUrl',
      },
    );
    return { success: true, authUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      { err: message, authApi: ctx.authApi, userActionId: ctx.userAction.id, hasEmail: Boolean(ctx.email) },
      'Google Workspace host OAuth orchestrator failed',
    );
    return { success: false, error: message };
  }
}

export function registerGoogleWorkspaceApiAuthOrchestrator(): void {
  registerAuthOrchestrator('googleWorkspaceApi', runGoogleWorkspaceAuthOrchestrator);
}
