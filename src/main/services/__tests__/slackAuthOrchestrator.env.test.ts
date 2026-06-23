import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthOrchestratorContext } from '../mcpService';
import { runSlackAuthOrchestrator } from '../slackAuthOrchestrator';
import { startSlackAuth } from '../slackAuthService';

vi.mock('../slackAuthService', () => ({
  startSlackAuth: vi.fn(),
}));

const TEST_CONTEXT: AuthOrchestratorContext = {
  serverId: 'Slack-test',
  toolName: 'authenticate_slack_workspace',
  authApi: 'slackApi',
  userAction: {
    id: 'slack.connect_workspace',
    instruction: 'Connect Slack to continue.',
  },
  agentAction: {
    instruction: 'Use the connect flow and retry the request.',
  },
};

describe('runSlackAuthOrchestrator env credential resolution', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('surfaces structured setup guidance when Slack OAuth env credentials are missing', async () => {
    const result = await runSlackAuthOrchestrator(TEST_CONTEXT);

    // F1 (Stage 3 refinement): the orchestrator now returns the structured guidance (env var NAMES,
    // setup URL, redirect URIs) — not a bare "not configured" string — and keeps the human error
    // sourced from that guidance's message.
    expect(result.success).toBe(false);
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
    expect(result.setupGuidance?.provider).toBe('slack');
    expect(result.setupGuidance?.envVars).toEqual(['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET']);
    expect(result.error).toBe(result.setupGuidance?.message);
    expect(startSlackAuth).not.toHaveBeenCalled();
  });

  it('starts Slack auth when Slack OAuth env credentials are configured', async () => {
    vi.stubEnv('SLACK_CLIENT_ID', 'slack-client-id');
    vi.stubEnv('SLACK_CLIENT_SECRET', 'slack-client-secret');
    vi.mocked(startSlackAuth).mockReturnValue({
      authUrl: 'https://slack.com/oauth/v2/authorize?client_id=slack-client-id&state=test',
      completion: new Promise(() => undefined),
    });

    const result = await runSlackAuthOrchestrator(TEST_CONTEXT);

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
});
