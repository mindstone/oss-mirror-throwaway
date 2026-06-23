/**
 * Stage 3 behavioural test: `github:start-auth` classifies the not-configured case BEFORE calling
 * startGitHubAuth() and returns STRUCTURED setup guidance, leaving the service's
 * getGitHubCredentialsOrThrow() throw contract untouched as the internal safety net.
 *
 * Asserts: when resolveOAuthCredentials(githubCredentialSource) returns null, the handler returns
 * { success: false, setupGuidance.code === 'oauth-credentials-not-configured', provider: 'github' }
 * and never invokes startGitHubAuth().
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('@core/handlerRegistry', () => ({
  getHandlerRegistry: () => ({
    register: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  }),
}));

const mockStartGitHubAuth = vi.fn();
const mockGetGitHubStatus = vi.fn();
const mockRemoveGitHubAccount = vi.fn();
vi.mock('../../services/githubAuthService', () => ({
  startGitHubAuth: (...args: unknown[]) => mockStartGitHubAuth(...args),
  getGitHubStatus: (...args: unknown[]) => mockGetGitHubStatus(...args),
  removeGitHubAccount: (...args: unknown[]) => mockRemoveGitHubAccount(...args),
}));

const mockResolveOAuthCredentials = vi.fn<() => { clientId: string; clientSecret: string } | null>();
vi.mock('../../services/oauthCredentials', () => ({
  resolveOAuthCredentials: () => mockResolveOAuthCredentials(),
  githubCredentialSource: {},
}));

import { registerGitHubHandlers } from '../githubHandlers';

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  registerGitHubHandlers();
});

describe('github:start-auth — not-configured returns structured setupGuidance (classify-before)', () => {
  it('returns setupGuidance for github and never calls startGitHubAuth()', async () => {
    mockResolveOAuthCredentials.mockReturnValue(null);

    const handler = handlers.get('github:start-auth');
    expect(handler).toBeDefined();
    const result = (await handler!({})) as {
      success: boolean;
      error?: string;
      setupGuidance?: { code: string; provider: string; message: string; envVars: string[] };
    };

    expect(result.success).toBe(false);
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
    expect(result.setupGuidance?.provider).toBe('github');
    expect(result.error).toBe(result.setupGuidance?.message);
    expect(result.setupGuidance?.envVars).toContain('GITHUB_CLIENT_ID');
    expect(mockStartGitHubAuth).not.toHaveBeenCalled();
  });

  it('calls startGitHubAuth() when credentials ARE configured (no guidance)', async () => {
    mockResolveOAuthCredentials.mockReturnValue({ clientId: 'id', clientSecret: 'secret' });
    mockStartGitHubAuth.mockResolvedValue(undefined);

    const handler = handlers.get('github:start-auth');
    const result = (await handler!({})) as { success: boolean; setupGuidance?: unknown };

    expect(result.success).toBe(true);
    expect(result.setupGuidance).toBeUndefined();
    expect(mockStartGitHubAuth).toHaveBeenCalledTimes(1);
  });
});
