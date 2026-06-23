import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runGuardGroup,
  guardFromMain,
  type GuardGroupMember,
} from '../lib/guard-group-runner';

// Silence the runner's own stdout/stderr chatter during assertions.
afterEach(() => {
  vi.restoreAllMocks();
});

function silence() {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
}

describe('guardFromMain — exit/return/throw verdict mapping', () => {
  it('maps a void-returning main to pass (0)', async () => {
    const g = guardFromMain('void-pass', () => {});
    await expect(g.run()).resolves.toBe(0);
  });

  it('maps a numeric-return main to its code', async () => {
    await expect(guardFromMain('ret-0', () => 0).run()).resolves.toBe(0);
    await expect(guardFromMain('ret-2', () => 2).run()).resolves.toBe(2);
  });

  it('captures process.exit(1) as verdict 1 without exiting the batch', async () => {
    const realExit = process.exit;
    const g = guardFromMain('exit-1', () => {
      process.exit(1);
    });
    await expect(g.run()).resolves.toBe(1);
    // process.exit must be restored to the real implementation after the call.
    expect(process.exit).toBe(realExit);
  });

  it('captures process.exit(0) as verdict 0', async () => {
    await expect(guardFromMain('exit-0', () => process.exit(0)).run()).resolves.toBe(0);
  });

  it('captures an async main that exits after an await', async () => {
    const g = guardFromMain('async-exit-3', async () => {
      await Promise.resolve();
      process.exit(3);
    });
    await expect(g.run()).resolves.toBe(3);
  });

  it('captures process.exitCode=1 set without an explicit process.exit (the other CLI idiom)', async () => {
    const realExit = process.exit;
    const prev = process.exitCode;
    const g = guardFromMain('exitcode-1', () => {
      // Standalone, Node would exit non-zero at process end. In-batch this must
      // map to verdict 1 (not a false-green void-return pass).
      process.exitCode = 1;
    });
    await expect(g.run()).resolves.toBe(1);
    // adapter must restore the prior exitCode so it doesn't leak to the batch
    expect(process.exitCode).toBe(prev);
    expect(process.exit).toBe(realExit);
  });

  it('a void return with exitCode left at 0 is a pass', async () => {
    const g = guardFromMain('exitcode-0', () => {
      process.exitCode = 0;
    });
    await expect(g.run()).resolves.toBe(0);
  });

  it('propagates a genuine throw (not a process.exit) so the group fails closed', async () => {
    const g = guardFromMain('throws', () => {
      throw new Error('boom');
    });
    await expect(g.run()).rejects.toThrow('boom');
  });

  it('restores process.exit even when main throws', async () => {
    const realExit = process.exit;
    const g = guardFromMain('throws-restore', () => {
      throw new Error('boom');
    });
    await expect(g.run()).rejects.toThrow();
    expect(process.exit).toBe(realExit);
  });
});

describe('runGuardGroup — fail-closed aggregation', () => {
  it('returns 0 only when every guard passes', async () => {
    silence();
    const code = await runGuardGroup('all-pass', [
      guardFromMain('a', () => 0),
      guardFromMain('b', () => {}),
      guardFromMain('c', async () => process.exit(0)),
    ]);
    expect(code).toBe(0);
  });

  it('returns 1 if any guard fails, and RUNS ALL guards (surfaces every failure)', async () => {
    silence();
    const ran: string[] = [];
    const make = (name: string, code: number): GuardGroupMember => ({
      name,
      run: () => {
        ran.push(name);
        return code;
      },
    });
    const result = await runGuardGroup('mixed', [
      make('p1', 0),
      make('f1', 1),
      make('p2', 0),
      make('f2', 2),
    ]);
    expect(result).toBe(1);
    // every guard ran — a single failing guard does NOT short-circuit the rest
    expect(ran).toEqual(['p1', 'f1', 'p2', 'f2']);
  });

  it('treats a crashing guard (thrown error) as a failure, not a skip (fail-closed)', async () => {
    silence();
    const code = await runGuardGroup('crash', [
      guardFromMain('ok', () => 0),
      guardFromMain('crash', () => {
        throw new Error('cannot run');
      }),
    ]);
    expect(code).toBe(1);
  });

  it('treats a GuardRunResultLike {ok:false} as a failure', async () => {
    silence();
    const code = await runGuardGroup('result-shape', [
      { name: 'r-pass', run: () => ({ ok: true, summary: 'fine' }) },
      { name: 'r-fail', run: () => ({ ok: false, failures: ['nope'], summary: 'bad' }) },
    ]);
    expect(code).toBe(1);
  });
});
