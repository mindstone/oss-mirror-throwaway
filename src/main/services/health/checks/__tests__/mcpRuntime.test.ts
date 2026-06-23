import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockManagerShape = {
  getStartupHealthSnapshot: () => { consecutiveFailures: number };
} | null;

const mocks = vi.hoisted(() => {
  let consecutiveFailures = 0;
  const manager: MockManagerShape = {
    getStartupHealthSnapshot: () => ({ consecutiveFailures }),
  };
  return {
    info: vi.fn(),
    warn: vi.fn(),
    setConsecutiveFailures: (n: number) => {
      consecutiveFailures = n;
    },
    setManagerToNull: () => {
      mocks.currentManager = null;
    },
    setManagerActive: () => {
      mocks.currentManager = manager;
    },
    currentManager: manager as MockManagerShape,
    throwOnManagerAccess: false,
  };
});

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: mocks.info,
    warn: mocks.warn,
  }),
}));

 
vi.mock('../../../superMcpHttpManager', () => ({
  get superMcpHttpManager() {
    if (mocks.throwOnManagerAccess) {
      throw new Error('manager unavailable');
    }
    return mocks.currentManager;
  },
}));

import { checkMcpRuntimeHealth } from '../mcpRuntime';

beforeEach(() => {
  mocks.throwOnManagerAccess = false;
  mocks.setManagerActive();
  mocks.setConsecutiveFailures(0);
  checkMcpRuntimeHealth();
  vi.clearAllMocks();
});

describe('checkMcpRuntimeHealth', () => {
  it('returns skip when the manager is not initialized', () => {
    mocks.setManagerToNull();

    expect(checkMcpRuntimeHealth()).toMatchObject({
      id: 'mcpRuntimeHealth',
      name: 'Tool Server',
      status: 'skip',
      message: 'Super-MCP manager not initialized',
    });
  });

  it('returns pass when there are no consecutive startup failures', () => {
    mocks.setConsecutiveFailures(0);

    expect(checkMcpRuntimeHealth()).toMatchObject({
      id: 'mcpRuntimeHealth',
      name: 'Tool Server',
      status: 'pass',
      message: 'Tool server is healthy',
    });
  });

  it('returns pass below the failure threshold', () => {
    mocks.setConsecutiveFailures(2);

    expect(checkMcpRuntimeHealth()).toMatchObject({
      id: 'mcpRuntimeHealth',
      status: 'pass',
      message: 'Tool server is healthy',
    });
  });

  it('returns warn at the failure threshold', () => {
    mocks.setConsecutiveFailures(3);

    expect(checkMcpRuntimeHealth()).toMatchObject({
      id: 'mcpRuntimeHealth',
      name: 'Tool Server',
      status: 'warn',
      message: 'Tool server is having trouble starting',
      remediation: 'One of your tools keeps failing to start. Open Settings to check it.',
      details: { consecutiveFailures: 3 },
    });
  });

  it('returns warn above the failure threshold', () => {
    mocks.setConsecutiveFailures(4);

    expect(checkMcpRuntimeHealth()).toMatchObject({
      id: 'mcpRuntimeHealth',
      status: 'warn',
      details: { consecutiveFailures: 4 },
    });
  });

  it('returns skip when reading manager state throws', () => {
    mocks.throwOnManagerAccess = true;

    expect(checkMcpRuntimeHealth()).toMatchObject({
      id: 'mcpRuntimeHealth',
      name: 'Tool Server',
      status: 'skip',
      message: 'Tool server status unknown',
    });
    expect(mocks.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Failed to read Super-MCP manager state',
    );
  });

  it('logs threshold engagement and clearing transitions once', () => {
    mocks.setConsecutiveFailures(3);
    expect(checkMcpRuntimeHealth().status).toBe('warn');
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenLastCalledWith(
      { consecutiveFailures: 3 },
      'mcpRuntimeHealth threshold engaged',
    );

    expect(checkMcpRuntimeHealth().status).toBe('warn');
    expect(mocks.info).toHaveBeenCalledTimes(1);

    mocks.setConsecutiveFailures(0);
    expect(checkMcpRuntimeHealth().status).toBe('pass');
    expect(mocks.info).toHaveBeenCalledTimes(2);
    expect(mocks.info).toHaveBeenLastCalledWith(
      { consecutiveFailures: 0 },
      'mcpRuntimeHealth threshold cleared',
    );

    expect(checkMcpRuntimeHealth().status).toBe('pass');
    expect(mocks.info).toHaveBeenCalledTimes(2);
  });
});
