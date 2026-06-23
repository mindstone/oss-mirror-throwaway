import { createScopedLogger } from '@core/logger';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import { registerAuthOrchestrator, type AuthOrchestratorContext, type AuthOrchestratorResult } from './mcpService';
import { resolveOAuthCredentials, hubspotCredentialSource } from './oauthCredentials';
import { getStoredScopeTier, startHubSpotAuth } from './hubspotAuthService';
import { emitHubSpotTelemetry } from './hubspotTelemetry';

const log = createScopedLogger({ service: 'hubspot-auth-orchestrator' });

export async function runHubSpotAuthOrchestrator(
  ctx: AuthOrchestratorContext,
): Promise<AuthOrchestratorResult> {
  const credentials = resolveOAuthCredentials(hubspotCredentialSource);
  if (!credentials) {
    const guidance = describeMissingOAuthCredentials('hubspot');
    return {
      success: false,
      error: guidance.message,
      setupGuidance: guidance,
    };
  }

  try {
    const scopeTier = await getStoredScopeTier(ctx.email);
    emitHubSpotTelemetry({
      event: 'hubspot.auth_required.browser_opened',
      accountEmail: ctx.email,
    }).catch((err) => {
      log.error({ err }, 'hubspot.telemetry_emit_failed');
    });
    const authUrl = await startHubSpotAuth(
      credentials.clientId,
      credentials.clientSecret,
      scopeTier,
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
      'HubSpot host OAuth orchestrator failed',
    );
    return { success: false, error: message };
  }
}

export function registerHubSpotApiAuthOrchestrator(): void {
  registerAuthOrchestrator('hubspotApi', runHubSpotAuthOrchestrator);
}
