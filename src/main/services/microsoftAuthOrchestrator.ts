import { createScopedLogger } from '@core/logger';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import { registerAuthOrchestrator, type AuthOrchestratorContext, type AuthOrchestratorResult } from './mcpService';
import { resolveMicrosoftClientId, microsoftCredentialSource } from './oauthCredentials';
import {
  beginMicrosoftAuthFlow,
  getMicrosoftAccounts,
  getExtraScopesForAccount,
  MICROSOFT_SHAREPOINT_SCOPES,
} from './microsoftAuthService';

const log = createScopedLogger({ service: 'microsoft-auth-orchestrator' });

const SETUP_TOOL_BASE = 'authenticate_microsoft_account';
const SETUP_TOOL_SHAREPOINT = 'authenticate_sharepoint';

export async function runMicrosoftApiAuthOrchestrator(
  ctx: AuthOrchestratorContext,
): Promise<AuthOrchestratorResult> {
  const clientId = resolveMicrosoftClientId(microsoftCredentialSource);
  if (!clientId) {
    const guidance = describeMissingOAuthCredentials('microsoft');
    return {
      success: false,
      error: guidance.message,
      setupGuidance: guidance,
    };
  }

  try {
    switch (ctx.toolName) {
      case SETUP_TOOL_BASE: {
        // Base-scopes path. On reconnection, preserve previously-granted extras
        // (e.g. Sites.Read.All) so the user doesn't silently regress from
        // org/SharePoint back to personal OneDrive only — matches
        // microsoftHandlers.ts:110 + inboxBridgeStateMachine.ts:1928 semantics.
        const accounts = await getMicrosoftAccounts();
        const existingAccount = accounts.find((a) => a.status === 'active') ?? accounts[0];
        let additionalScopes: string[] | undefined;
        let loginHint: string | undefined;
        if (existingAccount) {
          const extras = await getExtraScopesForAccount(existingAccount.email);
          if (extras.length > 0) {
            additionalScopes = extras;
            loginHint = existingAccount.email;
          }
        }
        const { authUrl } = await beginMicrosoftAuthFlow(clientId, {
          ...(additionalScopes ? { scopes: additionalScopes } : {}),
          ...(loginHint ? { loginHint } : {}),
        });
        return { success: true, authUrl };
      }
      case SETUP_TOOL_SHAREPOINT: {
        // SharePoint incremental-consent path: layer Sites.Read.All on top of
        // base scopes and target the active account so the picker is skipped.
        const accounts = await getMicrosoftAccounts();
        const activeAccount = accounts.find((a) => a.status === 'active') ?? accounts[0];
        if (!activeAccount) {
          return {
            success: false,
            error:
              'No active Microsoft account found. Connect a Microsoft 365 account first, ' +
              'then retry the SharePoint setup.',
          };
        }
        const { authUrl } = await beginMicrosoftAuthFlow(clientId, {
          scopes: MICROSOFT_SHAREPOINT_SCOPES,
          loginHint: ctx.email ?? activeAccount.email,
          incremental: true,
        });
        return { success: true, authUrl };
      }
      default:
        // Defensive: never silently dispatch on an unrecognised setup tool.
        // The catalog declares exactly two setupToolName values for microsoftApi
        // (`authenticate_microsoft_account` and `authenticate_sharepoint`);
        // anything else means the catalog and the host have drifted apart.
        throw new Error(`Unrecognised microsoftApi setupToolName: ${ctx.toolName}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      {
        err: message,
        authApi: ctx.authApi,
        toolName: ctx.toolName,
        userActionId: ctx.userAction.id,
        hasEmail: Boolean(ctx.email),
      },
      'Microsoft host OAuth orchestrator failed',
    );
    return { success: false, error: message };
  }
}

export function registerMicrosoftApiAuthOrchestrator(): void {
  registerAuthOrchestrator('microsoftApi', runMicrosoftApiAuthOrchestrator);
}
