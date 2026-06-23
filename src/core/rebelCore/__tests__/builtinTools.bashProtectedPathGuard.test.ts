import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeBuiltinTool } from '../builtinTools';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

describe('builtin Bash protected path guard wiring', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('blocks protected MCP config access before spawning a shell', async () => {
    const result = await executeBuiltinTool(
      'Bash',
      { command: 'cat super-mcp-router.json' },
      {
        cwd: '/tmp/rebel-workspace',
        homePath: '/tmp/rebel-home',
        userDataPath: '/tmp/rebel-user-data',
      },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Access to MCP configuration and credential files is not permitted');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
