import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthOrchestrator,
  unregisterAuthOrchestrator,
  type AuthOrchestratorContext,
} from '../mcpService';
import { registerHubSpotApiAuthOrchestrator, runHubSpotAuthOrchestrator } from '../hubspotAuthOrchestrator';
import { resolveOAuthCredentials } from '../oauthCredentials';
import { getStoredScopeTier, startHubSpotAuth } from '../hubspotAuthService';

vi.mock('../oauthCredentials', () => ({
  resolveOAuthCredentials: vi.fn(),
  hubspotCredentialSource: { provider: 'hubspot' },
}));

vi.mock('../hubspotAuthService', () => ({
  getStoredScopeTier: vi.fn(),
  startHubSpotAuth: vi.fn(),
}));

const TEST_CONTEXT: AuthOrchestratorContext = {
  serverId: 'HubSpot-test-account',
  toolName: 'authenticate_hubspot_account',
  authApi: 'hubspotApi',
  userAction: {
    id: 'hubspot.connect_account',
    instruction: 'Connect HubSpot to continue.',
  },
  agentAction: {
    instruction: 'Use the connect flow and retry the request.',
  },
};

describe('registerHubSpotApiAuthOrchestrator', () => {
  beforeEach(() => {
    vi.mocked(resolveOAuthCredentials).mockReturnValue({
      clientId: 'hs-client-id',
      clientSecret: 'hs-client-secret',
    });
    vi.mocked(getStoredScopeTier).mockResolvedValue('readonly');
    vi.mocked(startHubSpotAuth).mockResolvedValue('https://app.hubspot.com/oauth/authorize?state=test');
  });

  afterEach(() => {
    unregisterAuthOrchestrator('hubspotApi');
    vi.clearAllMocks();
  });

  it('registers the production hubspotApi orchestrator', async () => {
    registerHubSpotApiAuthOrchestrator();

    const orchestrator = getAuthOrchestrator('hubspotApi');
    expect(orchestrator).toBeDefined();
    if (!orchestrator) {
      throw new Error('Expected hubspotApi orchestrator to be registered');
    }

    const result = await orchestrator(TEST_CONTEXT);
    expect(result).toEqual({
      success: true,
      authUrl: 'https://app.hubspot.com/oauth/authorize?state=test',
    });
    expect(getStoredScopeTier).toHaveBeenCalledWith(undefined);
    expect(startHubSpotAuth).toHaveBeenCalledWith(
      'hs-client-id',
      'hs-client-secret',
      'readonly',
      expect.objectContaining({
        targetEmail: undefined,
        returnMode: 'authUrl',
      }),
    );
  });

  it('returns structured setupGuidance when oauth credentials are missing', async () => {
    vi.mocked(resolveOAuthCredentials).mockReturnValue(null);

    const result = await runHubSpotAuthOrchestrator(TEST_CONTEXT);

    expect(result.success).toBe(false);
    // F1 (Stage 3 refinement): structured guidance, not a bare "not configured" string.
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
    expect(result.setupGuidance?.provider).toBe('hubspot');
    expect(result.error).toBe(result.setupGuidance?.message);
    expect(getStoredScopeTier).not.toHaveBeenCalled();
    expect(startHubSpotAuth).not.toHaveBeenCalled();
  });

  it('returns fail-loud error when stored scope lookup fails for unmatched email', async () => {
    const contextWithEmail: AuthOrchestratorContext = {
      ...TEST_CONTEXT,
      email: 'missing@example.com',
    };
    vi.mocked(getStoredScopeTier).mockRejectedValue(new Error('ACCOUNT_NOT_FOUND'));

    const result = await runHubSpotAuthOrchestrator(contextWithEmail);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ACCOUNT_NOT_FOUND');
    expect(startHubSpotAuth).not.toHaveBeenCalled();
  });
});
