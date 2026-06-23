import { describe, expect, it, vi } from 'vitest';
import {
  SuperMcpHttpManagerConfigureSchema,
  SuperMcpInternalConfigureShapeSchema,
  SuperMcpRuntimeHttpConfigSchema,
} from '@core/rebelCore/superMcpContract';

vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
  }),
}));

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-data',
  isPackaged: () => false,
  getAppRoot: () => '/tmp/test-app',
}));

vi.mock('@core/utils/buildChannel', () => ({
  getBuildChannel: () => 'dev',
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => ({ coreDirectory: '/tmp/test-core' }),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getActiveTurnCount: () => 0,
    onDrained: vi.fn(),
  },
}));

import { SuperMcpHttpManager } from '../superMcpHttpManager';

function markRunning(manager: SuperMcpHttpManager, port = 3200): void {
  const privateManager = manager as unknown as {
    state: { isRunning: boolean; port: number; url: string };
  };
  privateManager.state.isRunning = true;
  privateManager.state.port = port;
  privateManager.state.url = `http://127.0.0.1:${port}/mcp`;
}

describe('SuperMcpHttpManager contract schemas', () => {
  it('returns runtime HTTP config in the contract shape when running', () => {
    const manager = new SuperMcpHttpManager();
    manager.configure({
      enabled: true,
      port: 3200,
      configPath: '/tmp/mcp.json',
      startupTimeoutMs: 5000,
      healthCheckIntervalMs: 1000,
    });
    markRunning(manager);

    const config = manager.getHttpConfig();

    expect(config).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3200/mcp',
    });
    expect(SuperMcpRuntimeHttpConfigSchema.safeParse(config).success).toBe(true);
  });

  it('keeps public configure and internal configure shapes in the contract', () => {
    const publicConfigure = {
      enabled: true,
      port: 3200,
      configPath: '/tmp/mcp.json',
      startupTimeoutMs: 5000,
      healthCheckIntervalMs: 1000,
    };
    const internalConfigure = {
      port: 3200,
      configPath: '/tmp/mcp.json',
      startupTimeoutMs: 5000,
    };

    expect(SuperMcpHttpManagerConfigureSchema.safeParse(publicConfigure).success).toBe(true);
    expect(SuperMcpInternalConfigureShapeSchema.safeParse(internalConfigure).success).toBe(true);
  });
});
