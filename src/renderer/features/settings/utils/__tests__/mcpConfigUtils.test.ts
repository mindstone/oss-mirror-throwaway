import { describe, expect, it } from 'vitest';
import type { McpServerConfigDetails } from '@shared/types';
import { serializeServerConfig } from '../mcpConfigUtils';

const makeServer = (env: Record<string, string>): McpServerConfigDetails => ({
  name: 'Runway',
  type: null,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@mindstone-engineering/mcp-server-runway'],
  url: null,
  cwd: null,
  env,
  headers: null,
  description: null,
});

describe('serializeServerConfig', () => {
  it('filters out MCP_HOST_BRIDGE_STATE', () => {
    const serialized = serializeServerConfig(
      makeServer({
        RUNWAYML_API_SECRET: 'fake-runway-secret',
        MCP_HOST_BRIDGE_STATE: '/some/path',
      }),
    );

    expect(serialized).toContain('RUNWAYML_API_SECRET');
    expect(serialized).toContain('fake-runway-secret');
    expect(serialized).not.toContain('MCP_HOST_BRIDGE_STATE');
  });

  it('filters out existing internal env keys', () => {
    const serialized = serializeServerConfig(
      makeServer({
        MCP_MODE: 'strict',
        NODE_PATH: '/internal/node_modules',
        USER_VISIBLE_KEY: 'visible',
      }),
    );

    expect(serialized).toContain('USER_VISIBLE_KEY');
    expect(serialized).not.toContain('MCP_MODE');
    expect(serialized).not.toContain('NODE_PATH');
  });

  it('preserves user-visible env vars', () => {
    const serialized = serializeServerConfig(
      makeServer({
        RUNWAYML_API_SECRET: 'fake-runway-secret',
        RUNWAYML_TEAM_ID: 'team-test',
      }),
    );
    const parsed = JSON.parse(serialized) as { env?: Record<string, string> };

    expect(parsed.env).toEqual({
      RUNWAYML_API_SECRET: 'fake-runway-secret',
      RUNWAYML_TEAM_ID: 'team-test',
    });
  });
});
