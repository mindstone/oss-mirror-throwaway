import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthOrchestrator,
  unregisterAuthOrchestrator,
  type AuthOrchestratorContext,
} from '../mcpService';
import {
  registerMicrosoftApiAuthOrchestrator,
  runMicrosoftApiAuthOrchestrator,
} from '../microsoftAuthOrchestrator';
import { resolveMicrosoftClientId } from '../oauthCredentials';
import {
  beginMicrosoftAuthFlow,
  getMicrosoftAccounts,
  getExtraScopesForAccount,
  MICROSOFT_SHAREPOINT_SCOPES,
} from '../microsoftAuthService';

vi.mock('../oauthCredentials', () => ({
  resolveMicrosoftClientId: vi.fn(),
  microsoftCredentialSource: {},
}));

vi.mock('../microsoftAuthService', () => ({
  beginMicrosoftAuthFlow: vi.fn(),
  getMicrosoftAccounts: vi.fn(),
  getExtraScopesForAccount: vi.fn(),
  MICROSOFT_SHAREPOINT_SCOPES: ['Sites.Read.All'],
}));

const BASE_CONTEXT: AuthOrchestratorContext = {
  serverId: 'Microsoft365Mail-teammember-mindstone-ai',
  toolName: 'authenticate_microsoft_account',
  authApi: 'microsoftApi',
  userAction: {
    id: 'microsoft.connect_account',
    instruction: 'Connect Microsoft 365 to continue.',
  },
  agentAction: {
    instruction: 'Open the Microsoft sign-in flow and retry the request.',
  },
};

const SHAREPOINT_CONTEXT: AuthOrchestratorContext = {
  serverId: 'Microsoft365SharePoint-teammember-mindstone-ai',
  toolName: 'authenticate_sharepoint',
  authApi: 'microsoftApi',
  email: '[Mindstone-email]',
  userAction: {
    id: 'microsoft.connect_sharepoint',
    instruction: 'Grant SharePoint access to continue.',
  },
  agentAction: {
    instruction: 'Open the Microsoft consent flow for SharePoint and retry the request.',
  },
};

const FAKE_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=test';

describe('runMicrosoftApiAuthOrchestrator', () => {
  beforeEach(() => {
    vi.mocked(resolveMicrosoftClientId).mockReturnValue('ms-client-id');
    vi.mocked(beginMicrosoftAuthFlow).mockResolvedValue({
      authUrl: FAKE_AUTH_URL,
      state: 'state-token',
      awaitedEmail: Promise.resolve('[Mindstone-email]'),
    });
    vi.mocked(getMicrosoftAccounts).mockResolvedValue([]);
    vi.mocked(getExtraScopesForAccount).mockResolvedValue([]);
  });

  afterEach(() => {
    unregisterAuthOrchestrator('microsoftApi');
    vi.clearAllMocks();
  });

  it('registers the production microsoftApi orchestrator', () => {
    registerMicrosoftApiAuthOrchestrator();
    const orchestrator = getAuthOrchestrator('microsoftApi');
    expect(orchestrator).toBeDefined();
  });

  // ── authenticate_microsoft_account (base scopes) ──

  describe('authenticate_microsoft_account → base scopes', () => {
    it('returns { success: true, authUrl } when credentials and no preserved scopes', async () => {
      const result = await runMicrosoftApiAuthOrchestrator(BASE_CONTEXT);

      expect(result).toEqual({ success: true, authUrl: FAKE_AUTH_URL });
      expect(beginMicrosoftAuthFlow).toHaveBeenCalledTimes(1);
      expect(beginMicrosoftAuthFlow).toHaveBeenCalledWith('ms-client-id', expect.not.objectContaining({
        scopes: expect.anything(),
        loginHint: expect.anything(),
      }));
    });

    it('preserves extra scopes from the active account on reconnection', async () => {
      vi.mocked(getMicrosoftAccounts).mockResolvedValue([
        { email: '[Mindstone-email]', status: 'active' },
      ]);
      vi.mocked(getExtraScopesForAccount).mockResolvedValue(['Sites.Read.All', 'Files.ReadWrite.All']);

      const result = await runMicrosoftApiAuthOrchestrator(BASE_CONTEXT);

      expect(result).toEqual({ success: true, authUrl: FAKE_AUTH_URL });
      expect(beginMicrosoftAuthFlow).toHaveBeenCalledWith('ms-client-id', expect.objectContaining({
        scopes: ['Sites.Read.All', 'Files.ReadWrite.All'],
        loginHint: '[Mindstone-email]',
      }));
      expect(getExtraScopesForAccount).toHaveBeenCalledWith('[Mindstone-email]');
    });

    it('falls back to the first account when no active account exists', async () => {
      vi.mocked(getMicrosoftAccounts).mockResolvedValue([
        { email: '[Mindstone-email]', status: 'expired' },
      ]);
      vi.mocked(getExtraScopesForAccount).mockResolvedValue(['Sites.Read.All']);

      await runMicrosoftApiAuthOrchestrator(BASE_CONTEXT);

      expect(beginMicrosoftAuthFlow).toHaveBeenCalledWith('ms-client-id', expect.objectContaining({
        scopes: ['Sites.Read.All'],
        loginHint: '[Mindstone-email]',
      }));
    });

    it('does not forward an empty scopes array when no extras exist', async () => {
      vi.mocked(getMicrosoftAccounts).mockResolvedValue([
        { email: '[Mindstone-email]', status: 'active' },
      ]);
      vi.mocked(getExtraScopesForAccount).mockResolvedValue([]);

      await runMicrosoftApiAuthOrchestrator(BASE_CONTEXT);

      const callArgs = vi.mocked(beginMicrosoftAuthFlow).mock.calls[0]?.[1] ?? {};
      expect(callArgs).not.toHaveProperty('scopes');
      expect(callArgs).not.toHaveProperty('loginHint');
    });
  });

  // ── authenticate_sharepoint (incremental consent) ──

  describe('authenticate_sharepoint → incremental Sites.Read.All consent', () => {
    it('returns { success: true, authUrl } and forwards the SharePoint scope-upgrade options', async () => {
      vi.mocked(getMicrosoftAccounts).mockResolvedValue([
        { email: '[Mindstone-email]', status: 'active' },
      ]);

      const result = await runMicrosoftApiAuthOrchestrator(SHAREPOINT_CONTEXT);

      expect(result).toEqual({ success: true, authUrl: FAKE_AUTH_URL });
      expect(beginMicrosoftAuthFlow).toHaveBeenCalledWith('ms-client-id', expect.objectContaining({
        scopes: MICROSOFT_SHAREPOINT_SCOPES,
        loginHint: '[Mindstone-email]',
        incremental: true,
      }));
    });

    it('returns a fail-loud error when no Microsoft account is connected yet', async () => {
      vi.mocked(getMicrosoftAccounts).mockResolvedValue([]);

      const result = await runMicrosoftApiAuthOrchestrator(SHAREPOINT_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no active microsoft account/i);
      expect(beginMicrosoftAuthFlow).not.toHaveBeenCalled();
    });

    it('uses the orchestrator context email when provided (overrides active-account fallback)', async () => {
      vi.mocked(getMicrosoftAccounts).mockResolvedValue([
        { email: '[Mindstone-email]', status: 'active' },
      ]);

      const ctx: AuthOrchestratorContext = {
        ...SHAREPOINT_CONTEXT,
        email: '[Mindstone-email]',
      };

      await runMicrosoftApiAuthOrchestrator(ctx);

      expect(beginMicrosoftAuthFlow).toHaveBeenCalledWith('ms-client-id', expect.objectContaining({
        loginHint: '[Mindstone-email]',
      }));
    });
  });

  // ── Defensive `default:` branch — locked invariant ──

  describe('defensive setupToolName guard', () => {
    it('throws on an unrecognised setupToolName instead of silently dispatching', async () => {
      const ctx: AuthOrchestratorContext = {
        ...BASE_CONTEXT,
        toolName: 'authenticate_some_other_tool',
      };

      const result = await runMicrosoftApiAuthOrchestrator(ctx);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Unrecognised microsoftApi setupToolName: authenticate_some_other_tool/);
      expect(beginMicrosoftAuthFlow).not.toHaveBeenCalled();
    });
  });

  // ── Credential-missing fail-closed ──

  describe('credential resolution', () => {
    it('returns structured setupGuidance when client ID is missing', async () => {
      vi.mocked(resolveMicrosoftClientId).mockReturnValue(null);

      const result = await runMicrosoftApiAuthOrchestrator(BASE_CONTEXT);

      expect(result.success).toBe(false);
      // F1 (Stage 3 refinement): structured guidance, not a bare "not configured" string.
      expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
      expect(result.setupGuidance?.provider).toBe('microsoft');
      expect(result.error).toBe(result.setupGuidance?.message);
      expect(beginMicrosoftAuthFlow).not.toHaveBeenCalled();
    });

    it('propagates beginMicrosoftAuthFlow errors as a fail-loud orchestrator error', async () => {
      vi.mocked(beginMicrosoftAuthFlow).mockRejectedValue(new Error('Failed to open browser for authentication'));

      const result = await runMicrosoftApiAuthOrchestrator(BASE_CONTEXT);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to open browser for authentication');
    });
  });
});
