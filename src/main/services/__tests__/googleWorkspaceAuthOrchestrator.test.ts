import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthOrchestrator,
  unregisterAuthOrchestrator,
  type AuthOrchestratorContext,
} from '../mcpService';
import {
  registerGoogleWorkspaceApiAuthOrchestrator,
  runGoogleWorkspaceAuthOrchestrator,
} from '../googleWorkspaceAuthOrchestrator';
import { resolveOAuthCredentials } from '../oauthCredentials';
import { startGoogleAuth } from '../googleWorkspaceAuthService';

vi.mock('../oauthCredentials', () => ({
  resolveOAuthCredentials: vi.fn(),
  googleCredentialSource: { provider: 'google' },
}));

vi.mock('../googleWorkspaceAuthService', () => ({
  startGoogleAuth: vi.fn(),
}));

const TEST_CONTEXT: AuthOrchestratorContext = {
  serverId: 'GoogleWorkspace-teammember-mindstone-com',
  toolName: 'authenticate_workspace_account',
  authApi: 'googleWorkspaceApi',
  email: '[Mindstone-email]',
  userAction: {
    id: 'google.connect_account',
    instruction: 'Connect Google Workspace to continue.',
  },
  agentAction: {
    instruction: 'Use the connect flow and retry the request.',
  },
};

describe('registerGoogleWorkspaceApiAuthOrchestrator', () => {
  beforeEach(() => {
    vi.mocked(resolveOAuthCredentials).mockReturnValue({
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
    });
    vi.mocked(startGoogleAuth).mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=test');
  });

  afterEach(() => {
    unregisterAuthOrchestrator('googleWorkspaceApi');
    vi.clearAllMocks();
  });

  it('registers the production googleWorkspaceApi orchestrator', async () => {
    registerGoogleWorkspaceApiAuthOrchestrator();

    const orchestrator = getAuthOrchestrator('googleWorkspaceApi');
    expect(orchestrator).toBeDefined();
    if (!orchestrator) {
      throw new Error('Expected googleWorkspaceApi orchestrator to be registered');
    }

    const result = await orchestrator(TEST_CONTEXT);
    expect(result).toEqual({
      success: true,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=test',
    });
    expect(startGoogleAuth).toHaveBeenCalledWith(
      'google-client-id',
      'google-client-secret',
      expect.objectContaining({
        targetEmail: '[Mindstone-email]',
        returnMode: 'authUrl',
      }),
    );
  });

  it('returns structured setupGuidance when oauth credentials are missing', async () => {
    vi.mocked(resolveOAuthCredentials).mockReturnValue(null);

    const result = await runGoogleWorkspaceAuthOrchestrator(TEST_CONTEXT);

    expect(result.success).toBe(false);
    // F1 (Stage 3 refinement): structured guidance, not a bare "not configured" string.
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
    expect(result.setupGuidance?.provider).toBe('google');
    expect(result.error).toBe(result.setupGuidance?.message);
    expect(startGoogleAuth).not.toHaveBeenCalled();
  });

  it('returns fail-loud error when the auth service rejects', async () => {
    vi.mocked(startGoogleAuth).mockRejectedValue(new Error('Auth cancelled - new auth started'));

    const result = await runGoogleWorkspaceAuthOrchestrator(TEST_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Auth cancelled - new auth started');
  });

  it('preserves cancel-first concurrent-flow behavior from the auth service', async () => {
    vi.mocked(startGoogleAuth)
      .mockRejectedValueOnce(new Error('Auth cancelled - new auth started'))
      .mockResolvedValueOnce('https://accounts.google.com/o/oauth2/v2/auth?state=second');

    const first = await runGoogleWorkspaceAuthOrchestrator(TEST_CONTEXT);
    const second = await runGoogleWorkspaceAuthOrchestrator(TEST_CONTEXT);

    expect(first).toMatchObject({
      success: false,
      error: 'Auth cancelled - new auth started',
    });
    expect(second).toEqual({
      success: true,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=second',
    });
    expect(startGoogleAuth).toHaveBeenCalledTimes(2);
  });
});
