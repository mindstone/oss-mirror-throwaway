import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

/**
 * Tests for invokeStdioAuthenticateTool — Super-MCP use_tool wrapper unwrapping (FOX-2639).
 *
 * Bug: Salesforce OAuth returns "No auth URL in response" because Super-MCP wraps tool
 * results in a UseToolOutput envelope ({ package_id, tool_id, result: { content: [...] } }).
 * invokeStdioAuthenticateTool parsed the OUTER envelope looking for auth fields that only
 * exist in the INNER tool response.
 *
 * TDD approach:
 * 1. Precondition test — demonstrates what Super-MCP use_tool actually returns
 * 2. Bug reproduction — the exact "No auth URL in response" error from production
 * 3. Regression tests — fix must unwrap the envelope and extract auth status
 */

// Mock the MCP SDK Client — vi.hoisted ensures mocks survive vi.resetModules()
const { mockCallTool, mockConnect, mockClose } = vi.hoisted(() => ({
  mockCallTool: vi.fn(),
  mockConnect: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  // Must be a real class/constructor (not arrow fn) so `new Client(...)` works
  function MockClient() {
    return { connect: mockConnect, callTool: mockCallTool, close: mockClose };
  }
  return { Client: MockClient };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  function MockTransport() { return {}; }
  return { StreamableHTTPClientTransport: MockTransport };
});

vi.mock('@core/lazyElectron', () => ({
  getElectronModule: vi.fn(() => ({
    shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  })),
  onElectronAppEvent: vi.fn(),
}));

describe('invokeStdioAuthenticateTool — Super-MCP wrapper unwrapping (FOX-2639)', () => {
  let invokeStdioAuthenticateTool: typeof import('../mcpService').invokeStdioAuthenticateTool;
  let authenticateMcpServer: typeof import('../mcpService').authenticateMcpServer;

  beforeEach(async () => {
    vi.resetModules();
    await initTestPlatformConfig();

    vi.doMock('@core/services/settingsStore', () => ({
      setSettingsStoreAdapter: vi.fn(),
      getSettings: vi.fn(() => ({ mcpConfigFile: null })),
      settingsStore: { store: {} },
    }));
    vi.doMock('../superMcpHttpManager', () => ({
      superMcpHttpManager: {
        getState: vi.fn(() => ({ isRunning: true, url: 'http://localhost:12345', port: 12345 })),
        isConfigured: vi.fn(() => true),
      },
      findAvailablePort: vi.fn(),
    }));
    vi.doMock('@core/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      createScopedLogger: vi.fn(() => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      })),
    }));

    mockCallTool.mockReset();
    mockConnect.mockReset();
    mockClose.mockReset();

    const mod = await import('../mcpService');
    invokeStdioAuthenticateTool = mod.invokeStdioAuthenticateTool;
    authenticateMcpServer = mod.authenticateMcpServer;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- Precondition: demonstrates the Super-MCP use_tool envelope format --

  it('Super-MCP use_tool wraps tool results in UseToolOutput envelope (precondition)', () => {
    // This is what Super-MCP returns when calling use_tool for a bundled MCP tool.
    // The actual tool response is nested inside result.content[].text
    const superMcpResponse = {
      package_id: 'Salesforce',
      tool_id: 'salesforce_connect_account',
      args_used: {},
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'authenticated',
            ok: true,
            message: 'Successfully connected Salesforce account: [external-email]',
            username: '[external-email]',
          }),
        }],
      },
      telemetry: { duration_ms: 5000, status: 'ok' },
    };

    // The outer envelope does NOT have status/ok/error at the top level
    expect(superMcpResponse).not.toHaveProperty('status');
    expect(superMcpResponse).not.toHaveProperty('ok');
    expect(superMcpResponse).not.toHaveProperty('error');
    // The auth fields are buried inside result.content[0].text
    const innerResponse = JSON.parse(superMcpResponse.result.content[0].text);
    expect(innerResponse.status).toBe('authenticated');
  });

  // -- Bug reproduction: "No auth URL in response" --

  it('should not return "No auth URL in response" for successful Salesforce auth via Super-MCP (reproduces FOX-2639)', async () => {
    // This is the exact response shape from production: Super-MCP wraps Salesforce's
    // authenticated response in a UseToolOutput envelope
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'Salesforce',
          tool_id: 'salesforce_connect_account',
          args_used: {},
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'authenticated',
                ok: true,
                message: 'Successfully connected Salesforce account: [external-email]',
                username: '[external-email]',
              }),
            }],
          },
          telemetry: { duration_ms: 5000, status: 'ok' },
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('Salesforce', 'salesforce_connect_account');

    // Before the fix, this returned { success: false, error: 'No auth URL in response' }
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // -- Regression: error propagation through wrapper --

  it('should propagate inner error when Salesforce auth fails through Super-MCP wrapper', async () => {
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'Salesforce',
          tool_id: 'salesforce_connect_account',
          args_used: {},
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: 'Salesforce OAuth credentials not configured. Please add your Connected App credentials in Settings.',
              }),
            }],
          },
          telemetry: { duration_ms: 200, status: 'ok' },
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('Salesforce', 'salesforce_connect_account');

    expect(result.success).toBe(false);
    // Before fix: returns generic "No auth URL in response"
    // After fix: returns the actual error message from the tool
    expect(result.error).toContain('credentials not configured');
    // Stage 3 review r2 (F1): the legacy setup-tool missing-creds path now attaches structured
    // guidance for its owning connector (no host orchestrator exists to do it). The human-readable
    // error is preserved alongside.
    expect(result.setupGuidance?.provider).toBe('salesforce');
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
  });

  it('does NOT attach setupGuidance for an unrelated (non-credentials) setup-tool error', async () => {
    // Robust detector contract: keyed on the setup-tool name AND a missing-credentials signature.
    // A transient/operational error from the same tool must NOT be mislabelled as not-configured.
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'Salesforce',
          tool_id: 'salesforce_connect_account',
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: 'Salesforce returned HTTP 503 while starting the OAuth flow. Try again.',
              }),
            }],
          },
          telemetry: { duration_ms: 80, status: 'ok' },
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('Salesforce', 'salesforce_connect_account');

    expect(result.success).toBe(false);
    expect(result.error).toContain('HTTP 503');
    expect(result.setupGuidance).toBeUndefined();
  });

  it('carries setupGuidance(salesforce) end-to-end through authenticateMcpServer (F1)', async () => {
    // The catalog routes bundled-salesforce through oauth-user-provided + setupToolName
    // salesforce_connect_account (NO host *AuthOrchestrator), so authenticateMcpServer →
    // invokeStdioAuthenticateTool is the only place structured guidance can be attached
    // before the result crosses the misc:mcp-authenticate IPC boundary.
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'Salesforce',
          tool_id: 'salesforce_connect_account',
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: 'Salesforce OAuth credentials not configured. Please add your Connected App credentials in Settings.',
              }),
            }],
          },
          telemetry: { duration_ms: 120, status: 'ok' },
        }),
      }],
    });

    const result = await authenticateMcpServer('Salesforce');

    expect(result.success).toBe(false);
    expect(result.error).toContain('credentials not configured');
    expect(result.setupGuidance?.provider).toBe('salesforce');
    expect(result.setupGuidance?.code).toBe('oauth-credentials-not-configured');
  });

  // -- Regression: direct (non-wrapped) responses still work --

  it('should handle direct (non-wrapped) authenticated response', async () => {
    // Some MCPs return auth responses directly without Super-MCP wrapping
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'authenticated',
          message: 'Already connected',
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('SomeMcp', 'authenticate');
    expect(result.success).toBe(true);
  });

  it('should handle direct auth URL response without wrapper', async () => {
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          auth_url: 'https://login.example.com/oauth/authorize?client_id=abc',
          status: 'auth_required',
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('SomeMcp', 'authenticate');
    expect(result.success).toBe(true);
    expect(result.authUrl).toBe('https://login.example.com/oauth/authorize?client_id=abc');
  });

  it('should handle direct error response without wrapper', async () => {
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: 'OAuth credentials expired',
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('SomeMcp', 'authenticate');
    expect(result.success).toBe(false);
    expect(result.error).toBe('OAuth credentials expired');
  });

  // -- Edge case: auth URL inside Super-MCP wrapper --

  it('should extract auth URL from inside Super-MCP wrapper', async () => {
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'SomeMcp',
          tool_id: 'SomeMcp__authenticate',
          args_used: {},
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?scope=...',
                status: 'auth_required',
              }),
            }],
          },
          telemetry: { duration_ms: 100, status: 'ok' },
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('SomeMcp', 'authenticate');
    expect(result.success).toBe(true);
    expect(result.authUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth?scope=...');
  });

  // -- Bug: Salesforce bridge returns { success: true, username } not { status: 'authenticated' } --

  it('should recognize { success: true } response from Salesforce bridge (callback completion)', async () => {
    // The Salesforce bridge at /bundled/salesforce/start-auth responds with
    // { success: true, username: '...' } — NOT { status: 'authenticated' }.
    // After envelope unwrapping (FOX-2639), invokeStdioAuthenticateTool must
    // recognize this as a successful auth response.
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'Salesforce',
          tool_id: 'salesforce_connect_account',
          args_used: {},
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                username: '[external-email]',
              }),
            }],
          },
          telemetry: { duration_ms: 15000, status: 'ok' },
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('Salesforce', 'salesforce_connect_account');
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should handle direct { success: true } response without wrapper', async () => {
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: 'Connected successfully',
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('SomeMcp', 'authenticate');
    expect(result.success).toBe(true);
  });

  // -- Edge cases from reviewer feedback --

  it('should not unwrap a response that has result.content but no package_id/tool_id', async () => {
    // A hypothetical MCP that returns { result: { content: [...] }, auth_url: "..." }
    // should NOT be unwrapped — the auth_url at the top level should be used
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          auth_url: 'https://example.com/oauth',
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: 'should not reach here' }),
            }],
          },
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('SomeMcp', 'authenticate');
    expect(result.success).toBe(true);
    expect(result.authUrl).toBe('https://example.com/oauth');
  });

  it('should handle empty content array in Super-MCP wrapper', async () => {
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'Salesforce',
          tool_id: 'salesforce_connect_account',
          result: { content: [] },
          telemetry: { duration_ms: 100, status: 'ok' },
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('Salesforce', 'salesforce_connect_account');
    // Empty content means no auth data — should fall through to error
    expect(result.success).toBe(false);
  });

  it('should handle malformed inner JSON in Super-MCP wrapper', async () => {
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'Salesforce',
          tool_id: 'salesforce_connect_account',
          result: {
            content: [{
              type: 'text',
              text: 'not valid json at all',
            }],
          },
          telemetry: { duration_ms: 100, status: 'ok' },
        }),
      }],
    });

    const result = await invokeStdioAuthenticateTool('Salesforce', 'salesforce_connect_account');
    // Malformed inner JSON — should fall through without crashing
    expect(result.success).toBe(false);
  });

  it('drops force/email for oauth-user-provided connect tools (Salesforce takes no args)', async () => {
    // The Salesforce salesforce_connect_account
    // tool schemas explicitly take no arguments. Passing { email } or { force } would
    // trigger Super-MCP's argument validator with "Unknown fields" and the OAuth flow
    // would never start. authenticateMcpServer must therefore strip both for
    // authType === 'oauth-user-provided' connectors. See
    // docs-private/postmortems/260430_salesforce_oauth_instance_name_mismatch_postmortem.md
    // (round 2).
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'already_authenticated',
        }),
      }],
    });

    const result = await authenticateMcpServer('Salesforce', { force: true });

    expect(result.success).toBe(true);
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'use_tool',
        arguments: expect.objectContaining({
          package_id: 'Salesforce',
          tool_id: 'Salesforce__salesforce_connect_account',
          args: {},
        }),
      }),
      undefined,
      expect.any(Object),
    );
  });

  it('surfaces Super-MCP refusal when a required-argument authenticate tool is ineligible for zero-arg delegation', async () => {
    mockCallTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          package_id: 'CustomHttpOAuth',
          status: 'error',
          error:
            "This connector's authentication tool needs additional information, so Rebel cannot start it automatically. Please reconnect this connector from Settings.",
          ineligible_auth_tools: [{
            tool: 'authenticate_custom_account',
            required: ['workspace_id'],
          }],
        }),
      }],
    });

    const result = await authenticateMcpServer('CustomHttpOAuth');

    expect(result.success).toBe(false);
    expect(result.error).toContain('needs additional information');
    expect(result.error).toContain('Settings');
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'authenticate',
        arguments: expect.objectContaining({
          package_id: 'CustomHttpOAuth',
          wait_for_completion: true,
        }),
      }),
      undefined,
      expect.objectContaining({
        timeout: 370000,
        resetTimeoutOnProgress: true,
      }),
    );
    expect(mockCallTool).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'use_tool' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('surfaces hung Super-MCP generic authenticate delegation as a timeout error', async () => {
    mockCallTool.mockRejectedValue(new Error('Timed out waiting for authenticate delegate'));

    const result = await authenticateMcpServer('CustomHttpOAuth', { force: true });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'authenticate',
        arguments: expect.objectContaining({
          package_id: 'CustomHttpOAuth',
          wait_for_completion: true,
          force: true,
        }),
      }),
      undefined,
      expect.objectContaining({
        timeout: 370000,
        resetTimeoutOnProgress: true,
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Stage 0 OSS Slack migration: structured `auth_required` response shape.
  // The host must recognise the new contract, dispatch to the registered
  // OAuth orchestrator, and preserve back-compat for `auth_url` connectors.
  // See docs/plans/260429_slack_mcp_oss_migration.md, Stage 0.
  // ---------------------------------------------------------------------------

  describe('structured auth_required response (Stage 0)', () => {
    it('dispatches to the registered orchestrator when authApi is provided and routing succeeds', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({ success: true });
      registerAuthOrchestrator('slackApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: {
              id: 'slack.connect_workspace',
              label: 'Connect Slack',
              instruction: 'Click Connect Slack to authorise the workspace.',
            },
            agent_action: {
              instruction: 'Tell the user to click the Connect Slack button.',
            },
            setupToolName: 'authenticate_slack_workspace',
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'Slack-mindstone',
          'authenticate_slack_workspace',
          { authApi: 'slackApi' },
        );

        expect(result.success).toBe(true);
        expect(result.agentInstruction).toBe(
          'Tell the user to click the Connect Slack button.',
        );
        expect(orchestrator).toHaveBeenCalledTimes(1);
        expect(orchestrator).toHaveBeenCalledWith(expect.objectContaining({
          serverId: 'Slack-mindstone',
          toolName: 'authenticate_slack_workspace',
          authApi: 'slackApi',
          userAction: expect.objectContaining({ id: 'slack.connect_workspace' }),
          agentAction: expect.objectContaining({
            instruction: 'Tell the user to click the Connect Slack button.',
          }),
        }));
      } finally {
        unregisterAuthOrchestrator('slackApi');
      }
    });

    it('dispatches when the auth_required shape is wrapped in a Super-MCP envelope', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({ success: true });
      registerAuthOrchestrator('slackApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            package_id: 'Slack-mindstone',
            tool_id: 'Slack-mindstone__authenticate_slack_workspace',
            args_used: {},
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'auth_required',
                  user_action: {
                    id: 'slack.connect_workspace',
                    label: 'Connect Slack',
                  },
                  agent_action: {
                    instruction: 'Ask the user to click Connect Slack.',
                  },
                }),
              }],
            },
            telemetry: { duration_ms: 50, status: 'ok' },
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'Slack-mindstone',
          'authenticate_slack_workspace',
          { authApi: 'slackApi' },
        );

        expect(result.success).toBe(true);
        expect(orchestrator).toHaveBeenCalledTimes(1);
      } finally {
        unregisterAuthOrchestrator('slackApi');
      }
    });

    it('does not dispatch the orchestrator when setupToolName mismatches the invoked tool', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({ success: true });
      registerAuthOrchestrator('slackApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'slack.connect_workspace' },
            agent_action: { instruction: 'Reconnect Slack from settings.' },
            setupToolName: 'authenticate_slack_workspace',
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'Slack-mindstone',
          'list_channels', // non-setup tool
          { authApi: 'slackApi' },
        );

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/non-setup tool/i);
        expect(orchestrator).not.toHaveBeenCalled();
      } finally {
        unregisterAuthOrchestrator('slackApi');
      }
    });

    it('dispatches HubSpot orchestrator for setup-tool auth_required with matching setupToolName', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({ success: true });
      registerAuthOrchestrator('hubspotApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'hubspot.connect_account' },
            agent_action: { instruction: 'Open HubSpot OAuth.' },
            setupToolName: 'authenticate_hubspot_account',
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'HubSpot-acct1',
          'authenticate_hubspot_account',
          { authApi: 'hubspotApi' },
        );

        expect(result.success).toBe(true);
        expect(orchestrator).toHaveBeenCalledTimes(1);
      } finally {
        unregisterAuthOrchestrator('hubspotApi');
      }
    });

    it('dispatches Google Workspace orchestrator for setup-tool auth_required with matching setupToolName', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({
        success: true,
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=test',
      });
      registerAuthOrchestrator('googleWorkspaceApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'google.connect_account' },
            agent_action: { instruction: 'Open Google Workspace OAuth.' },
            setupToolName: 'authenticate_workspace_account',
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'GoogleWorkspace-teammember-mindstone-com',
          'authenticate_workspace_account',
          {
            authApi: 'googleWorkspaceApi',
            email: '[Mindstone-email]',
          },
        );

        expect(result).toMatchObject({
          success: true,
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=test',
          agentInstruction: 'Open Google Workspace OAuth.',
        });
        expect(orchestrator).toHaveBeenCalledWith(expect.objectContaining({
          serverId: 'GoogleWorkspace-teammember-mindstone-com',
          toolName: 'authenticate_workspace_account',
          authApi: 'googleWorkspaceApi',
          email: '[Mindstone-email]',
          userAction: expect.objectContaining({ id: 'google.connect_account' }),
        }));
      } finally {
        unregisterAuthOrchestrator('googleWorkspaceApi');
      }
    });

    it('dispatches Microsoft orchestrator for setup-tool auth_required with authenticate_microsoft_account', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({
        success: true,
        authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=ms',
      });
      registerAuthOrchestrator('microsoftApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'microsoft.connect_account' },
            agent_action: { instruction: 'Open the Microsoft sign-in flow.' },
            setupToolName: 'authenticate_microsoft_account',
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'Microsoft365Mail-teammember-mindstone-ai',
          'authenticate_microsoft_account',
          {
            authApi: 'microsoftApi',
            email: '[Mindstone-email]',
          },
        );

        expect(result).toMatchObject({
          success: true,
          authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=ms',
          agentInstruction: 'Open the Microsoft sign-in flow.',
        });
        expect(orchestrator).toHaveBeenCalledWith(expect.objectContaining({
          serverId: 'Microsoft365Mail-teammember-mindstone-ai',
          toolName: 'authenticate_microsoft_account',
          authApi: 'microsoftApi',
          email: '[Mindstone-email]',
          userAction: expect.objectContaining({ id: 'microsoft.connect_account' }),
        }));
      } finally {
        unregisterAuthOrchestrator('microsoftApi');
      }
    });

    it('dispatches Microsoft orchestrator for SharePoint scope-upgrade auth_required with authenticate_sharepoint', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({
        success: true,
        authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=sp',
      });
      registerAuthOrchestrator('microsoftApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'microsoft.connect_sharepoint' },
            agent_action: { instruction: 'Open Microsoft consent for SharePoint.' },
            setupToolName: 'authenticate_sharepoint',
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'Microsoft365SharePoint-teammember-mindstone-ai',
          'authenticate_sharepoint',
          {
            authApi: 'microsoftApi',
            email: '[Mindstone-email]',
          },
        );

        expect(result).toMatchObject({
          success: true,
          authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=sp',
          agentInstruction: 'Open Microsoft consent for SharePoint.',
        });
        expect(orchestrator).toHaveBeenCalledWith(expect.objectContaining({
          serverId: 'Microsoft365SharePoint-teammember-mindstone-ai',
          toolName: 'authenticate_sharepoint',
          authApi: 'microsoftApi',
          userAction: expect.objectContaining({ id: 'microsoft.connect_sharepoint' }),
        }));
      } finally {
        unregisterAuthOrchestrator('microsoftApi');
      }
    });

    it('does not dispatch HubSpot orchestrator for ordinary-tool auth_required with mismatching setupToolName', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({ success: true });
      registerAuthOrchestrator('hubspotApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'hubspot.connect_account' },
            agent_action: { instruction: 'Reconnect from settings.' },
            setupToolName: 'authenticate_hubspot_account',
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'HubSpot-acct1',
          'list_contacts',
          { authApi: 'hubspotApi' },
        );

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/non-setup tool/i);
        expect(orchestrator).not.toHaveBeenCalled();
      } finally {
        unregisterAuthOrchestrator('hubspotApi');
      }
    });

    it('does not dispatch HubSpot orchestrator for ordinary-tool auth_required without setupToolName', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({ success: true });
      registerAuthOrchestrator('hubspotApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'hubspot.connect_account' },
            agent_action: { instruction: 'Reconnect from settings.' },
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'HubSpot-acct1',
          'list_contacts',
          { authApi: 'hubspotApi' },
        );

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/non-setup tool/i);
        expect(orchestrator).not.toHaveBeenCalled();
      } finally {
        unregisterAuthOrchestrator('hubspotApi');
      }
    });

    it('returns a fail-closed error when no orchestrator is registered for the authApi', async () => {
      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'slack.connect_workspace' },
            agent_action: { instruction: 'Ask the user to click Connect.' },
          }),
        }],
      });

      const result = await invokeStdioAuthenticateTool(
        'Slack-mindstone',
        'authenticate_slack_workspace',
        { authApi: 'slackApi' }, // none registered
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no host OAuth orchestrator/i);
    });

    it('returns a fail-closed error when authApi is missing from options', async () => {
      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'slack.connect_workspace' },
            agent_action: { instruction: 'Ask the user to click Connect.' },
          }),
        }],
      });

      const result = await invokeStdioAuthenticateTool(
        'Slack-mindstone',
        'authenticate_slack_workspace',
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no authApi was provided/i);
    });

    it('propagates the orchestrator error when the host OAuth flow fails', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({
        success: false,
        error: 'Slack OAuth credentials not configured',
      });
      registerAuthOrchestrator('slackApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'slack.connect_workspace' },
            agent_action: { instruction: 'Ask the user to click Connect.' },
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'Slack-mindstone',
          'authenticate_slack_workspace',
          { authApi: 'slackApi' },
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('Slack OAuth credentials not configured');
      } finally {
        unregisterAuthOrchestrator('slackApi');
      }
    });

    it('catches orchestrator exceptions and reports them without crashing', async () => {
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockRejectedValue(new Error('boom'));
      registerAuthOrchestrator('slackApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'slack.connect_workspace' },
            agent_action: { instruction: 'Ask the user to click Connect.' },
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'Slack-mindstone',
          'authenticate_slack_workspace',
          { authApi: 'slackApi' },
        );

        expect(result.success).toBe(false);
        expect(result.error).toBe('boom');
      } finally {
        unregisterAuthOrchestrator('slackApi');
      }
    });

    it('preserves legacy auth_url handling when status is auth_required but user_action/agent_action are absent', async () => {
      // Existing connectors may emit `status: 'auth_required'` alongside an
      // `auth_url`. The structured-shape branch must NOT swallow these — the
      // legacy URL path should still open the browser.
      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            auth_url: 'https://login.example.com/oauth/authorize?client_id=abc',
          }),
        }],
      });

      const result = await invokeStdioAuthenticateTool(
        'SomeMcp',
        'authenticate',
        { authApi: 'slackApi' }, // present, but structured fields are not — should fall through
      );

      expect(result.success).toBe(true);
      expect(result.authUrl).toBe('https://login.example.com/oauth/authorize?client_id=abc');
    });

    it('falls back to legacy parsing when the auth_required shape is malformed (back-compat)', async () => {
      // Connector returns an `auth_required` status with a stray `auth_url`
      // but `user_action.id` is missing — the structured-shape Zod parse
      // fails, and we fall through to the legacy auth_url path so the user
      // is not stranded.
      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { /* id missing */ },
            agent_action: { instruction: 'oops' },
            auth_url: 'https://example.com/legacy-oauth',
          }),
        }],
      });

      const result = await invokeStdioAuthenticateTool(
        'SomeMcp',
        'authenticate',
        { authApi: 'slackApi' },
      );

      expect(result.success).toBe(true);
      expect(result.authUrl).toBe('https://example.com/legacy-oauth');
    });

    it('fails closed when the auth_required shape is malformed AND no legacy auth_url is present', async () => {
      // Pin the contract: a connector that emits a malformed structured shape
      // (Zod parse fails) WITHOUT a legacy auth_url to fall back to must NOT
      // silently succeed. The user must see a clear failure message.
      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { /* id missing */ },
            agent_action: { instruction: 'oops' },
            // no auth_url — nothing for legacy path to grab
          }),
        }],
      });

      const result = await invokeStdioAuthenticateTool(
        'SomeMcp',
        'authenticate',
        { authApi: 'slackApi' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('surfaces a default error message when orchestrator resolves { success: false } with no error string', async () => {
      // Fail-loud contract: orchestrators that return `{ success: false }`
      // with `error` undefined must still produce a user-visible error,
      // not a silent failure where success=false but error=undefined.
      const { registerAuthOrchestrator, unregisterAuthOrchestrator } = await import(
        '../mcpService'
      );
      const orchestrator = vi.fn().mockResolvedValue({ success: false }); // no error string
      registerAuthOrchestrator('slackApi', orchestrator);

      mockCallTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'auth_required',
            user_action: { id: 'slack.connect_workspace', label: 'Connect Slack' },
            agent_action: { instruction: 'Tell user to connect.' },
          }),
        }],
      });

      try {
        const result = await invokeStdioAuthenticateTool(
          'Slack',
          'authenticate_slack_workspace',
          { authApi: 'slackApi' },
        );

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.error).toMatch(/did not complete authentication/i);
      } finally {
        unregisterAuthOrchestrator('slackApi');
      }
    });
  });
});
