import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthOrchestrator,
  unregisterAuthOrchestrator,
  type AuthOrchestratorContext,
} from '../mcpService';
import { registerSlackApiAuthOrchestrator, runSlackAuthOrchestrator } from '../slackAuthOrchestrator';
import { resolveOAuthCredentials } from '../oauthCredentials';
import { startSlackAuth } from '../slackAuthService';

vi.mock('../oauthCredentials', () => ({
  resolveOAuthCredentials: vi.fn(),
  slackCredentialSource: { provider: 'slack' },
}));

vi.mock('../slackAuthService', () => ({
  startSlackAuth: vi.fn(),
}));

const TEST_CONTEXT: AuthOrchestratorContext = {
  serverId: 'Slack-mindstone',
  toolName: 'authenticate_slack_workspace',
  authApi: 'slackApi',
  userAction: {
    id: 'slack.connect_workspace',
    instruction: 'Connect a Slack workspace to continue.',
  },
  agentAction: {
    instruction: 'Use the connect flow and retry the request.',
  },
};

describe('registerSlackApiAuthOrchestrator', () => {
  beforeEach(() => {
    vi.mocked(resolveOAuthCredentials).mockReturnValue({
      clientId: 'slack-client-id',
      clientSecret: 'slack-client-secret',
    });
    vi.mocked(startSlackAuth).mockReturnValue({
      authUrl: 'https://slack.com/oauth/v2/authorize?client_id=slack-client-id&state=test',
      completion: new Promise(() => undefined),
    });
  });

  afterEach(() => {
    unregisterAuthOrchestrator('slackApi');
    vi.clearAllMocks();
  });

  it('registers the production slackApi orchestrator', async () => {
    registerSlackApiAuthOrchestrator();

    const orchestrator = getAuthOrchestrator('slackApi');
    expect(orchestrator).toBeDefined();
    if (!orchestrator) {
      throw new Error('Expected slackApi orchestrator to be registered');
    }

    const result = await orchestrator(TEST_CONTEXT);
    expect(result).toEqual({
      success: true,
      authUrl: 'https://slack.com/oauth/v2/authorize?client_id=slack-client-id&state=test',
    });
    expect(startSlackAuth).toHaveBeenCalledWith(
      'slack-client-id',
      'slack-client-secret',
      expect.objectContaining({ autoOpen: false }),
    );
  });

  it('returns structured setupGuidance (not a bare string) when oauth credentials are missing', async () => {
    vi.mocked(resolveOAuthCredentials).mockReturnValue(null);

    const result = await runSlackAuthOrchestrator(TEST_CONTEXT);

    expect(result.success).toBe(false);
    // F1 (Stage 3 refinement): the agent/setup-tool auth path must surface the same structured
    // guidance the user-initiated start-auth handler returns — not a bare "not configured" string.
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
    expect(result.setupGuidance?.provider).toBe('slack');
    expect(result.setupGuidance?.envVars).toContain('SLACK_CLIENT_ID');
    // The human error is kept and sourced from the structured guidance message (no drift).
    expect(result.error).toBe(result.setupGuidance?.message);
    expect(startSlackAuth).not.toHaveBeenCalled();
  });

  it('returns fail-loud error when startSlackAuth throws', async () => {
    vi.mocked(startSlackAuth).mockImplementation(() => {
      throw new Error('REDIRECT_URI_MISMATCH');
    });

    const result = await runSlackAuthOrchestrator(TEST_CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error).toContain('REDIRECT_URI_MISMATCH');
  });
});
