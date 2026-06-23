import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockCheckHealth = vi.fn();
const mockIsConfigured = vi.fn();

vi.mock('@core/services/superMcpHttpManager', () => ({
  superMcpHttpManager: {
    checkHealth: mockCheckHealth,
    isConfigured: mockIsConfigured,
  },
}));

import { checkSuperMcp } from '../health/checks';

describe('checkSuperMcp', () => {
  it('returns pass when Super-MCP is healthy', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockCheckHealth.mockResolvedValue(true);

    const result = await checkSuperMcp();
    expect(result.status).toBe('pass');
    expect(result.id).toBe('cloud-mcp');
    expect(result.message).toContain('responsive');
  });

  it('returns fail when Super-MCP is not responding', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockCheckHealth.mockResolvedValue(false);

    const result = await checkSuperMcp();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('not responding');
  });

  it('returns skip when Super-MCP is not configured', async () => {
    mockIsConfigured.mockReturnValue(false);

    const result = await checkSuperMcp();
    expect(result.status).toBe('skip');
  });

  it('returns warn gracefully when checkHealth throws', async () => {
    mockIsConfigured.mockReturnValue(true);
    mockCheckHealth.mockRejectedValue(new Error('connection refused'));

    const result = await checkSuperMcp();
    // safeCheck wraps unexpected errors as warn status
    expect(result.status).toBe('warn');
  });
});
