import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { executeBuiltinTool } from '../builtinTools';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

/**
 * Fake child process that immediately emits the given stdout then exits 0,
 * enough for runBashTool to resolve cleanly.
 */
function makeFakeChild(stdoutText: string) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  // Defer emission until after runBashTool has attached its listeners.
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(stdoutText));
    child.emit('exit', 0);
    child.emit('close', 0);
  });
  return child;
}

describe('builtin Bash spawn stdio (REBEL-66M / FOX-3467 spawn EBADF guard)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns with stdin ignored and stdout/stderr piped', async () => {
    spawnMock.mockImplementation(() => makeFakeChild('hello\n'));

    const result = await executeBuiltinTool(
      'Bash',
      { command: 'echo hello' },
      {
        cwd: '/tmp/rebel-workspace',
        homePath: '/tmp/rebel-home',
        userDataPath: '/tmp/rebel-user-data',
      },
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][1] as { stdio?: unknown };
    // stdin must be 'ignore' (not inherited) — inheriting a bad parent fd0 is
    // the source of `spawn EBADF`. stdout/stderr stay piped for capture.
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);

    // And the change must not break output capture.
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('hello');
  });
});
