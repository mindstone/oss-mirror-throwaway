import { describe, expect, it } from 'vitest';
import {
  MissingBundledSuperMcpError,
  resolveSuperMcpLaunchSpecForEnvironment,
  type SuperMcpLaunchResolutionInput,
} from '../superMcpHttpManager';
import { SUPER_MCP_SPAWN_ENV_KEYS } from '@core/rebelCore/superMcpContract';

function resolveLaunchSpec(
  overrides: Partial<SuperMcpLaunchResolutionInput> = {},
) {
  return resolveSuperMcpLaunchSpecForEnvironment({
    env: {},
    platform: 'darwin',
    isPackaged: false,
    bundledCliPath: '/app/super-mcp/dist/cli.js',
    nodeBinaryPath: '/node/bin/node',
    nodeModulesPath: '/app/node_modules',
    cwd: '/repo',
    bundledCliExists: () => false,
    pinnedVersion: '9.8.7',
    ...overrides,
  });
}

describe('resolveSuperMcpLaunchSpecForEnvironment', () => {
  it('uses REBEL_SUPER_MCP_BIN first, even in packaged mode when bundled CLI is missing', () => {
    const spec = resolveLaunchSpec({
      env: {
        [SUPER_MCP_SPAWN_ENV_KEYS.REBEL_SUPER_MCP_BIN]: '/custom/super-mcp.js',
      },
      isPackaged: true,
      bundledCliExists: () => false,
    });

    expect(spec).toEqual({
      command: '/node/bin/node',
      argsPrefix: ['/custom/super-mcp.js'],
      cwd: '/custom',
      nodeModulesPath: '/app/node_modules',
      source: 'env',
    });
  });

  it('uses a bundled CLI when present', () => {
    const spec = resolveLaunchSpec({
      isPackaged: true,
      bundledCliExists: (cliPath) => cliPath === '/app/super-mcp/dist/cli.js',
    });

    expect(spec).toEqual({
      command: '/node/bin/node',
      argsPrefix: ['/app/super-mcp/dist/cli.js'],
      cwd: '/app/super-mcp/dist',
      nodeModulesPath: '/app/node_modules',
      source: 'bundled',
    });
  });

  it('uses npx in non-packaged dev mode when the bundled CLI is missing', () => {
    const spec = resolveLaunchSpec({
      isPackaged: false,
      bundledCliExists: () => false,
      pinnedVersion: '2.5.1-dev',
    });

    expect(spec).toMatchObject({
      command: 'npx',
      argsPrefix: ['--yes', 'super-mcp-router@2.5.1-dev'],
      cwd: '/repo',
      source: 'npx',
    });
  });

  it('uses npx.cmd for the dev fallback on Windows', () => {
    const spec = resolveLaunchSpec({
      platform: 'win32',
      isPackaged: false,
      bundledCliExists: () => false,
    });

    expect(spec.command).toBe('npx.cmd');
    expect(spec.source).toBe('npx');
  });

  it('throws instead of returning npx when packaged and the bundled CLI is missing', () => {
    expect(() =>
      resolveLaunchSpec({
        isPackaged: true,
        bundledCliExists: () => false,
      }),
    ).toThrow(MissingBundledSuperMcpError);
  });

  it('reflects REBEL_SUPER_MCP_PINNED_VERSION in dev npx args through the injected pin', () => {
    const spec = resolveLaunchSpec({
      env: {
        [SUPER_MCP_SPAWN_ENV_KEYS.REBEL_SUPER_MCP_PINNED_VERSION]: '3.4.5',
      },
      pinnedVersion: '9.8.7-generated',
      isPackaged: false,
      bundledCliExists: () => false,
    });

    expect(spec.argsPrefix).toEqual(['--yes', 'super-mcp-router@3.4.5']);
  });
});
