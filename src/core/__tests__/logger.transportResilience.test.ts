/**
 * REBEL-5RT — transport dead-worker resilience.
 *
 * Verifies the real fix: setupRotatingTransport() retains the pino.transport()
 * stream handle and attaches an 'error' listener so a dead pino-roll worker (a)
 * never produces an unhandled 'error' event / uncaughtException cascade, (b)
 * reports the ORIGINAL error to Sentry once (rate-limited, lifecycle-noise
 * suppressed), and (c) degrades the root logger to a synchronous destination so
 * logging survives — including for already-cached scoped loggers (generation-aware).
 *
 * We emit 'error' on the transport stream directly rather than racing a real
 * worker death — this exercises the exact listener wiring deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import pino from 'pino';
import type { ErrorReporter } from '@core/errorReporter';

// Opt out of the global no-op logger mock — exercise the real module.
vi.unmock('@core/logger');

// Drive the module's real root logger at a temp dir (getRootLogger/createLogger
// resolve the destination via getDataPath). mockDataDir is set per test.
let mockDataDir = '';
vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => mockDataDir,
  getAppVersion: () => '0.0.0-test',
}));

type CapturedCapture = { error: unknown; context?: Record<string, unknown> };

let testDir: string;
let destinationPath: string;
let captures: CapturedCapture[];

const makeRecordingReporter = (): ErrorReporter => ({
  captureException: (error, context) => { captures.push({ error, context: context as Record<string, unknown> }); },
  captureMessage: () => {},
  addBreadcrumb: () => {},
});

// Fresh module per test → module-global transport-health flags reset naturally.
const importFreshLogger = async () => {
  vi.resetModules();
  const { setErrorReporter } = await import('@core/errorReporter');
  setErrorReporter(makeRecordingReporter());
  return import('@core/logger');
};

const getStream = (logger: unknown) =>
  (logger as Record<symbol, { emit: (e: string, ...a: unknown[]) => void; end: () => void }>)[pino.symbols.streamSym];

// Read every file in the temp logs dir (the rotating destination + any fallback).
const readAllLogs = (): string => {
  const logsDir = path.join(testDir, 'logs');
  if (!existsSync(logsDir)) return '';
  return readdirSync(logsDir).map((f) => {
    try { return readFileSync(path.join(logsDir, f), 'utf8'); } catch { return ''; }
  }).join('\n');
};

describe('logger transport resilience (REBEL-5RT)', () => {
  beforeEach(() => {
    testDir = mkdtempSync(path.join(os.tmpdir(), 'rebel-5rt-transport-'));
    mockDataDir = testDir;
    destinationPath = path.join(testDir, 'logs', 'mindstone-rebel.log');
    captures = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('reports the original transport error to Sentry once with the REBEL-5RT fingerprint', async () => {
    const { setupRotatingTransport } = await importFreshLogger();
    const logger = setupRotatingTransport(destinationPath);
    const stream = getStream(logger);

    const original = new Error("ENOENT: no such file or directory, open '/x/app.1.log'");
    stream.emit('error', original);

    expect(captures).toHaveLength(1);
    expect(captures[0]?.error).toBe(original);
    expect(captures[0]?.context?.fingerprint).toEqual(['logger-transport-error', 'REBEL-5RT']);
    expect((captures[0]?.context?.tags as Record<string, unknown>)?.subsystem).toBe('logger-transport');
    // Root-cause diagnostics captured for production triage.
    expect(captures[0]?.context?.extra).toMatchObject({ errorName: 'Error', platform: process.platform });

    stream.end();
  });

  it('rate-limits repeated transport errors (does not re-report on every queued write)', async () => {
    const { setupRotatingTransport } = await importFreshLogger();
    const logger = setupRotatingTransport(destinationPath);
    const stream = getStream(logger);

    for (let i = 0; i < 20; i++) {
      stream.emit('error', new Error(`failure ${i}`));
    }
    expect(captures.length).toBeLessThanOrEqual(5); // MAX_TRANSPORT_ERROR_REPORTS
    expect(captures.length).toBeGreaterThan(0);

    stream.end();
  });

  it('suppresses secondary "worker has exited / is ending" noise regardless of close ordering', async () => {
    const { setupRotatingTransport } = await importFreshLogger();
    const logger = setupRotatingTransport(destinationPath);
    const stream = getStream(logger);

    // No 'close' first — exercises the H2 late-write path that GPT flagged.
    stream.emit('error', new Error('the worker is ending'));
    stream.emit('error', new Error('the worker has exited'));

    expect(captures).toHaveLength(0);

    stream.end();
  });

  it('degrades the root logger to a synchronous destination so logging survives', async () => {
    const mod = await importFreshLogger();
    const logger = mod.setupRotatingTransport(destinationPath);
    const stream = getStream(logger);

    stream.emit('error', new Error('the worker has exited'));

    mod.logger.error({ marker: 'post-degrade' }, 'still logging after transport death');

    expect(readAllLogs()).toContain('still logging after transport death');

    stream.end();
  });

  it('redirects an EXISTING scoped logger to the fallback after transport death (generation-aware)', async () => {
    const mod = await importFreshLogger();

    // Touch the module root logger so it builds via getRootLogger()/createLogger()
    // at the temp dir, then grab its transport stream through the `logger` proxy.
    mod.logger.info('boot');
    const stream = getStream(mod.logger);

    // A scoped logger created and used BEFORE the worker dies caches a child of
    // the original root. It must follow the swap, not write to the dead worker.
    const scoped = mod.createScopedLogger({ component: 'scoped-test' });
    scoped.info('before death');

    // emit('error') runs the listener synchronously → degrade + generation bump
    // happen before the next line; end() ensures the old worker is no longer a
    // live sink, so a write that lands on disk proves the scoped logger followed
    // the swap to the synchronous fallback rather than writing to the dead worker.
    stream.emit('error', new Error('boom-root-cause'));
    stream.end();

    scoped.error({ marker: 'after-degrade' }, 'scoped write after transport death');

    expect(readAllLogs()).toContain('scoped write after transport death');
    // The non-lifecycle root-cause error was reported to Sentry.
    expect(captures.some((c) => (c.error as Error)?.message === 'boom-root-cause')).toBe(true);
  });
});
