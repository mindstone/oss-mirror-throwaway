import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import { initCliRuntime, runCli } from '../../../src/main/cli';

const chatLinesQueue: string[][] = [];

vi.mock('node:readline', () => {
  const createInterface = () => {
    const lines = chatLinesQueue.shift() ?? [':quit'];
    let i = 0;
    return {
      question: (_query: string, cb: (answer: string) => void) => {
        const next = lines[i] ?? ':quit';
        i += 1;
        cb(next);
      },
      close: () => undefined,
    };
  };
  return { default: { createInterface }, createInterface };
});

const makeSettings = (): AppSettings =>
  ({
    coreDirectory: '/tmp/workspace',
    activeProvider: 'anthropic',
    models: { apiKey: 'test-key' },
    claude: { apiKey: 'test-key' },
    openRouter: { enabled: true, oauthToken: 'openrouter-token' },
    localModel: { profiles: [], activeProfileId: null },
  }) as unknown as AppSettings;

type RunHeadlessSpy = ReturnType<typeof vi.fn>;

const initRuntimeWith = (runHeadlessTurn: RunHeadlessSpy): void => {
  initCliRuntime({
    runHeadlessTurn: runHeadlessTurn as never,
    getSettings: makeSettings,
    appVersion: 'test',
  });
};

const lastOptions = (runHeadlessTurn: RunHeadlessSpy): HeadlessTurnOptions => {
  const calls = runHeadlessTurn.mock.calls as unknown as Array<[{ options: HeadlessTurnOptions }]>;
  const call = calls[0];
  if (!call) throw new Error('runHeadlessTurn was not invoked');
  return call[0].options;
};

describe('Electron-backed CLI --finish-line flag', () => {
  beforeEach(() => {
    delete process.env.REBEL_SURFACE;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('threads `--finish-line` into HeadlessTurnOptions for `rebel run`', async () => {
    const runHeadlessTurn = vi.fn(async () => undefined);
    initRuntimeWith(runHeadlessTurn);

    const exitCode = await runCli([
      'run',
      '--prompt',
      'hello',
      '--finish-line',
      'ready to send',
    ]);

    expect(exitCode).toBe(0);
    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
    expect(lastOptions(runHeadlessTurn).finishLine).toBe('ready to send');
  });

  it('threads `--finish-line` into every chat turn for `rebel chat`', async () => {
    const runHeadlessTurn = vi.fn(async () => undefined);
    initRuntimeWith(runHeadlessTurn);

    chatLinesQueue.push(['polish the draft', ':reset', ':quit']);

    const exitCode = await runCli([
      'chat',
      '--session',
      'test-session',
      '--finish-line',
      'ready to send',
    ]);

    expect(exitCode).toBe(0);
    expect(runHeadlessTurn).toHaveBeenCalledTimes(2);
    for (const call of runHeadlessTurn.mock.calls as unknown as Array<[{ options: HeadlessTurnOptions }]>) {
      const opts = call[0].options;
      expect(opts.finishLine).toBe('ready to send');
    }
  });

  it('omits finishLine from chat turn options when `--finish-line` is not provided', async () => {
    const runHeadlessTurn = vi.fn(async () => undefined);
    initRuntimeWith(runHeadlessTurn);

    chatLinesQueue.push(['hello there', ':quit']);

    const exitCode = await runCli(['chat', '--session', 'test-session-bare']);

    expect(exitCode).toBe(0);
    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
    expect(lastOptions(runHeadlessTurn).finishLine).toBeUndefined();
  });
});
