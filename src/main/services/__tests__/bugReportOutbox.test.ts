/**
 * Tests for the durable bug-report outbox (Stage 4).
 *
 * Covers the by-construction R1/R2 guarantees:
 *   - persist-then-load round-trip
 *   - atomic + fsync write (the temp file is fsync'd before rename)
 *   - .corrupt quarantine on a torn/invalid file (drain must not crash)
 *   - delete-only-on-2xx (a non-2xx keeps the record for retry)
 *   - backoff/jitter scheduling
 *   - dead-letter after retry exhaustion emits a Sentry event + retention prune
 *   - boot dir-scan picks up a pre-existing record
 *   - enqueue returns only after the durable write
 *   - idempotency: the SAME event_id is reused across attempts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';

// powerMonitor is not on the global electron mock; provide a minimal stub so
// start() can subscribe to 'resume' without throwing.
const powerListeners = new Map<string, Array<() => void>>();
vi.mock('electron', () => ({
  powerMonitor: {
    on: (event: string, cb: () => void) => {
      const list = powerListeners.get(event) ?? [];
      list.push(cb);
      powerListeners.set(event, list);
    },
    removeListener: (event: string, cb: () => void) => {
      const list = powerListeners.get(event) ?? [];
      powerListeners.set(event, list.filter((c) => c !== cb));
    },
  },
}));

// vi.mock factories are hoisted above const declarations, so the mocks they
// reference must be created with vi.hoisted().
const { mockLog, mockCaptureMessage } = vi.hoisted(() => ({
  mockLog: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  mockCaptureMessage: vi.fn(),
}));
vi.mock('@core/logger', () => ({ createScopedLogger: () => mockLog }));

// Wrap node:fs/promises so a test can intercept `open` (e.g. to observe the
// parent-dir fsync) without spying on the ESM namespace (which is not
// configurable). By default every call delegates to the real implementation;
// `openInterceptor` lets a test wrap the returned FileHandle.
const { openInterceptor } = vi.hoisted(() => ({
  openInterceptor: { fn: null as null | ((p: unknown, handle: unknown) => void) },
}));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const wrappedOpen = (async (p: unknown, ...rest: unknown[]) => {
    // @ts-expect-error — passthrough to the real variadic open
    const handle = await actual.open(p, ...rest);
    openInterceptor.fn?.(p, handle);
    return handle;
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, open: wrappedOpen }, open: wrappedOpen };
});
// mock-contract: partial — the outbox only consumes getErrorReporter().captureMessage; other exports (setErrorReporter) are unused here.
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ captureMessage: mockCaptureMessage }),
}));

import {
  BugReportOutbox,
  BugReportRecordSchema,
  type BugReportEnqueueInput,
  type BugReportSubmitOutcome,
} from '../bugReportOutbox';

function makeInput(overrides?: Partial<BugReportEnqueueInput>): BugReportEnqueueInput {
  return {
    reportId: randomUUID(),
    eventId: randomBytes(16).toString('hex'),
    description: 'Something broke',
    urgency: 'medium',
    ...overrides,
  };
}

let dir: string;
let recordCount: () => Promise<number>;

beforeEach(async () => {
  vi.clearAllMocks();
  powerListeners.clear();
  dir = path.join(os.tmpdir(), `bug-report-outbox-test-${process.pid}-${randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  recordCount = async () => {
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    return names.filter((n) => n.endsWith('.json')).length;
  };
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function alwaysDeliver(): Promise<BugReportSubmitOutcome> {
  return Promise.resolve<BugReportSubmitOutcome>({ kind: 'delivered' });
}

/** Poll (bounded) until `fn` reports the count we expect — robust under load. */
async function waitForCalls(fn: { mock: { calls: unknown[] } }, count: number): Promise<void> {
  for (let i = 0; i < 200 && fn.mock.calls.length < count; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('BugReportOutbox — persistence', () => {
  it('enqueue resolves only after the durable write (file is present on resolve)', async () => {
    // submit never settles → we are not relying on delivery; the durable write
    // is what enqueue awaits.
    const outbox = new BugReportOutbox({
      submit: () => new Promise<BugReportSubmitOutcome>(() => {}),
      isSentryEnabled: () => true,
      dirPath: dir,
    });
    const input = makeInput();
    const record = await outbox.enqueue(input);

    // The moment enqueue resolves, the file must already be on disk.
    const filePath = path.join(dir, `${input.reportId}.json`);
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = BugReportRecordSchema.parse(JSON.parse(raw));
    expect(parsed.reportId).toBe(input.reportId);
    expect(parsed.eventId).toBe(input.eventId);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.attempt).toBe(0);
    expect(record.eventId).toBe(input.eventId);
  });

  it('round-trips a record through write + Zod-validated read', async () => {
    const outbox = new BugReportOutbox({
      submit: () => new Promise<BugReportSubmitOutcome>(() => {}),
      isSentryEnabled: () => false, // drain no-ops; isolate persistence
      dirPath: dir,
    });
    const input = makeInput({
      stepsToReproduce: 'do the thing',
      expectedBehavior: 'it works',
      urgency: 'high',
      conversationId: 'conv-123',
      screenshotBase64: 'AAAA',
      screenshotMimeType: 'image/png',
      includeEnrichedDiagnostics: true,
    });
    await outbox.enqueue(input);

    const raw = await fsp.readFile(path.join(dir, `${input.reportId}.json`), 'utf8');
    const parsed = BugReportRecordSchema.parse(JSON.parse(raw));
    expect(parsed.stepsToReproduce).toBe('do the thing');
    expect(parsed.expectedBehavior).toBe('it works');
    expect(parsed.urgency).toBe('high');
    expect(parsed.conversationId).toBe('conv-123');
    expect(parsed.screenshotBase64).toBe('AAAA');
    expect(parsed.includeEnrichedDiagnostics).toBe(true);
  });

  it('atomic write leaves no .tmp files behind after enqueue', async () => {
    const outbox = new BugReportOutbox({
      submit: () => new Promise<BugReportSubmitOutcome>(() => {}),
      isSentryEnabled: () => false,
      dirPath: dir,
    });
    await outbox.enqueue(makeInput());
    const names = await fsp.readdir(dir);
    expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);
  });
});

describe('BugReportOutbox — quarantine', () => {
  it('quarantines a torn/invalid JSON file and does not crash the drain', async () => {
    // Write a junk file directly into the dir.
    const bad = path.join(dir, 'broken.json');
    await fsp.writeFile(bad, '{ not valid json', 'utf8');

    const submit = vi.fn(alwaysDeliver);
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir });

    await expect(outbox.drain('test')).resolves.toBeUndefined();

    // Original is gone; a .corrupt sibling remains.
    const names = await fsp.readdir(dir);
    expect(names).not.toContain('broken.json');
    expect(names.some((n) => n.startsWith('broken.json.corrupt.'))).toBe(true);
    // The junk record was never delivered.
    expect(submit).not.toHaveBeenCalled();
  });

  it('quarantines a schema-invalid record (wrong version) without crashing', async () => {
    const bad = path.join(dir, `${randomUUID()}.json`);
    await fsp.writeFile(bad, JSON.stringify({ schemaVersion: 999, reportId: 'x' }), 'utf8');

    const outbox = new BugReportOutbox({ submit: vi.fn(alwaysDeliver), isSentryEnabled: () => true, dirPath: dir });
    await expect(outbox.drain('test')).resolves.toBeUndefined();

    const names = await fsp.readdir(dir);
    expect(names.some((n) => n.includes('.corrupt.'))).toBe(true);
  });
});

describe('BugReportOutbox — delivery semantics', () => {
  it('deletes the record only on a confirmed delivered outcome', async () => {
    const outbox = new BugReportOutbox({
      submit: () => Promise.resolve<BugReportSubmitOutcome>({ kind: 'delivered' }),
      isSentryEnabled: () => true,
      dirPath: dir,
    });
    await outbox.enqueue(makeInput());
    await outbox.drain('test');
    expect(await recordCount()).toBe(0);
  });

  it('keeps the record for retry on a non-2xx (retry) outcome and increments attempt', async () => {
    const outbox = new BugReportOutbox({
      submit: () => Promise.resolve<BugReportSubmitOutcome>({ kind: 'retry', error: 'transport-500' }),
      isSentryEnabled: () => true,
      dirPath: dir,
    });
    const input = makeInput();
    await outbox.enqueue(input);
    await outbox.drain('test');

    expect(await recordCount()).toBe(1);
    const raw = await fsp.readFile(path.join(dir, `${input.reportId}.json`), 'utf8');
    const parsed = BugReportRecordSchema.parse(JSON.parse(raw));
    expect(parsed.attempt).toBe(1);
    expect(parsed.nextRetryAt).toBeGreaterThan(parsed.createdAt);
    expect(parsed.lastError).toBe('transport-500');
  });

  it('reuses the SAME event_id across delivery attempts (idempotency invariant)', async () => {
    const seenEventIds: string[] = [];
    let nowMs = 1_000_000;
    const outbox = new BugReportOutbox({
      submit: (record) => {
        seenEventIds.push(record.eventId);
        return Promise.resolve<BugReportSubmitOutcome>({ kind: 'retry' });
      },
      isSentryEnabled: () => true,
      dirPath: dir,
      now: () => nowMs,
    });
    const input = makeInput();
    await outbox.enqueue(input); // attempt scheduled at now
    await outbox.drain('test'); // attempt 1 (retry) — backoff pushes nextRetryAt out
    nowMs += 60 * 60 * 1000; // jump an hour so the backed-off record is due again
    await outbox.drain('test'); // attempt 2

    expect(seenEventIds.length).toBeGreaterThanOrEqual(2);
    // Every attempt used the same fixed event_id.
    for (const id of seenEventIds) expect(id).toBe(input.eventId);
  });

  it('does not drain (records persist) when Sentry is disabled', async () => {
    const submit = vi.fn(alwaysDeliver);
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => false, dirPath: dir });
    await outbox.enqueue(makeInput());
    await outbox.drain('test');
    expect(submit).not.toHaveBeenCalled();
    expect(await recordCount()).toBe(1); // still on disk, deliverable later
  });
});

describe('BugReportOutbox — circuit breaker', () => {
  it('pauses draining on a circuit-open outcome without counting an attempt', async () => {
    let nowMs = 1_000_000;
    const submit = vi.fn(() =>
      Promise.resolve<BugReportSubmitOutcome>({ kind: 'circuit-open', error: 'sentry-429', retryAfterMs: 60_000 }),
    );
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir, now: () => nowMs });
    const input = makeInput();
    await outbox.enqueue(input);
    await outbox.drain('test');

    // Attempt is NOT counted (server-side capacity, not this report's fault).
    const raw = await fsp.readFile(path.join(dir, `${input.reportId}.json`), 'utf8');
    expect(BugReportRecordSchema.parse(JSON.parse(raw)).attempt).toBe(0);

    // A second drain within the Retry-After window is a no-op (circuit open).
    submit.mockClear();
    await outbox.drain('test');
    expect(submit).not.toHaveBeenCalled();

    // After the window, draining resumes.
    nowMs += 60_001;
    await outbox.drain('test');
    expect(submit).toHaveBeenCalled();
  });
});

describe('BugReportOutbox — dead-letter + retention', () => {
  it('dead-letters after retry exhaustion: emits a distinct Sentry event and keeps the file', async () => {
    let nowMs = 1_000_000;
    const outbox = new BugReportOutbox({
      submit: () => Promise.resolve<BugReportSubmitOutcome>({ kind: 'retry', error: 'always-fails' }),
      isSentryEnabled: () => true,
      dirPath: dir,
      now: () => nowMs,
    });
    const input = makeInput();
    await outbox.enqueue(input);

    // Drain repeatedly, jumping time so the backed-off record is due each round.
    for (let i = 0; i < 20; i++) {
      await outbox.drain('test');
      nowMs += 60 * 60 * 1000; // +1h
    }

    // The dead-letter Sentry event was emitted, tagged so it's visible.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('bug_report_dead_letter'),
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({ bug_report_dead_letter: 'true', report_id: input.reportId }),
      }),
    );

    // The file is KEPT (parked) for visibility, not deleted.
    const raw = await fsp.readFile(path.join(dir, `${input.reportId}.json`), 'utf8');
    const parsed = BugReportRecordSchema.parse(JSON.parse(raw));
    expect(parsed.deadLetteredAt).toBeDefined();
    expect(parsed.nextRetryAt).toBe(Number.MAX_SAFE_INTEGER);

    // A parked dead-letter is never retried again, even when due-by-time.
    mockCaptureMessage.mockClear();
    const submitSpy = vi.fn(alwaysDeliver);
    const outbox2 = new BugReportOutbox({ submit: submitSpy, isSentryEnabled: () => true, dirPath: dir, now: () => nowMs });
    await outbox2.drain('test');
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('prunes aged-out records with a loud log', async () => {
    let nowMs = 1_000_000;
    const outbox = new BugReportOutbox({
      submit: () => new Promise<BugReportSubmitOutcome>(() => {}),
      isSentryEnabled: () => false,
      dirPath: dir,
      now: () => nowMs,
    });
    await outbox.enqueue(makeInput());
    expect(await recordCount()).toBe(1);

    // Jump well past the 30-day max age and run an (enabled) drain to prune.
    nowMs += 40 * 24 * 60 * 60 * 1000;
    const pruner = new BugReportOutbox({
      submit: vi.fn(alwaysDeliver),
      isSentryEnabled: () => true,
      dirPath: dir,
      now: () => nowMs,
    });
    await pruner.drain('test');
    expect(await recordCount()).toBe(0);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ageMs: expect.any(Number) }),
      expect.stringContaining('aged-out'),
    );
  });
});

describe('BugReportOutbox — callback trigger (SHOULD-3 toast suppression)', () => {
  // The outbox forwards the drain reason to both honest-status callbacks so the
  // handler can suppress an UNSOLICITED toast for a boot/background drain of a
  // stranded prior-session record (Phase 7 SHOULD-3 / Native F2).
  it('passes the drain reason to onSentryDisabledWithPending (enqueue vs boot)', async () => {
    const onSentryDisabledWithPending = vi.fn();
    const outbox = new BugReportOutbox({
      submit: vi.fn(alwaysDeliver),
      isSentryEnabled: () => false,
      dirPath: dir,
      onSentryDisabledWithPending,
    });
    // enqueue() fires the immediate 'enqueue' drain fire-and-forget; await an
    // explicit 'enqueue' drain to observe the callback deterministically.
    const input = makeInput();
    await outbox.enqueue(input);
    await outbox.drain('enqueue');
    expect(onSentryDisabledWithPending).toHaveBeenLastCalledWith(
      expect.objectContaining({ reportId: input.reportId }),
      'enqueue',
    );

    onSentryDisabledWithPending.mockClear();
    // A proactive boot drain over the same stranded record reports 'boot'.
    await outbox.drain('boot');
    expect(onSentryDisabledWithPending).toHaveBeenCalledWith(expect.anything(), 'boot');
  });

  it('passes the drain reason to onDeadLetter on retry exhaustion', async () => {
    let nowMs = 1_000_000;
    const onDeadLetter = vi.fn();
    const outbox = new BugReportOutbox({
      submit: () => Promise.resolve<BugReportSubmitOutcome>({ kind: 'retry', error: 'always-fails' }),
      isSentryEnabled: () => true,
      dirPath: dir,
      now: () => nowMs,
      onDeadLetter,
    });
    await outbox.enqueue(makeInput());
    // The first 'enqueue' drain plus repeated background 'backoff' drains until the
    // record exhausts its retries and dead-letters.
    for (let i = 0; i < 20 && onDeadLetter.mock.calls.length === 0; i++) {
      await outbox.drain('backoff');
      nowMs += 60 * 60 * 1000;
    }
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    // The dead-letter happened during a background 'backoff' drain → the handler
    // will suppress the toast (only 'enqueue' toasts).
    expect(onDeadLetter).toHaveBeenCalledWith(expect.anything(), 'backoff');
  });
});

describe('BugReportOutbox — boot scan', () => {
  it('start() picks up a pre-existing record and delivers it (boot dir-scan)', async () => {
    // Pre-seed a record on disk (simulating a report persisted before a crash).
    const input = makeInput();
    const seeded = BugReportRecordSchema.parse({
      ...input,
      schemaVersion: 1,
      createdAt: Date.now(),
      attempt: 0,
      nextRetryAt: Date.now(),
    });
    await fsp.writeFile(path.join(dir, `${input.reportId}.json`), JSON.stringify(seeded), 'utf8');

    const submit = vi.fn((record: { eventId: string }) => {
      void record;
      return Promise.resolve<BugReportSubmitOutcome>({ kind: 'delivered' });
    });
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir });

    await outbox.start();
    // start() runs a boot drain; the pre-existing record is delivered + removed.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0].eventId).toBe(input.eventId);
    expect(await recordCount()).toBe(0);

    await outbox.stop({ timeoutMs: 50 });
  });

  it('a crash-before-delete record re-delivers with the SAME event_id on next boot (no duplicate id)', async () => {
    // Simulate: a prior attempt succeeded at the transport but the process died
    // before deleting the file. The record is still on disk with attempt > 0.
    const input = makeInput();
    const seeded = BugReportRecordSchema.parse({
      ...input,
      schemaVersion: 1,
      createdAt: Date.now() - 1000,
      attempt: 1,
      nextRetryAt: Date.now(),
      lastError: 'process died before delete',
    });
    await fsp.writeFile(path.join(dir, `${input.reportId}.json`), JSON.stringify(seeded), 'utf8');

    const deliveredEventIds: string[] = [];
    const submit = vi.fn((record: { eventId: string }) => {
      deliveredEventIds.push(record.eventId);
      return Promise.resolve<BugReportSubmitOutcome>({ kind: 'delivered' });
    });
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir });

    await outbox.start();
    // Re-delivered with the SAME event_id → Sentry dedups server-side.
    expect(deliveredEventIds).toEqual([input.eventId]);
    expect(await recordCount()).toBe(0);

    await outbox.stop({ timeoutMs: 50 });
  });
});

describe('BugReportOutbox — concurrency (no double-send)', () => {
  it('two overlapping drains process each record at most once (drainPromise coalescing)', async () => {
    // A slow submit keeps the first drain in-flight while a second drain is
    // started; the coalescing must make the second await the first, NOT start a
    // concurrent pass that submits the same record again.
    let resolveSubmit: ((o: BugReportSubmitOutcome) => void) | null = null;
    const submit = vi.fn(
      () =>
        new Promise<BugReportSubmitOutcome>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir });

    // Seed one record directly (avoid enqueue's own auto-drain).
    const input = makeInput();
    const seeded = BugReportRecordSchema.parse({
      ...input,
      schemaVersion: 1,
      createdAt: Date.now(),
      attempt: 0,
      nextRetryAt: Date.now(),
    });
    await fsp.writeFile(path.join(dir, `${input.reportId}.json`), JSON.stringify(seeded), 'utf8');

    // Two concurrent drains; the first is parked inside the slow submit.
    const d1 = outbox.drain('first');
    const d2 = outbox.drain('second');

    // Wait until the in-flight submit has been entered (bounded poll, robust
    // under load — a fixed sleep is flaky when the suite is I/O-saturated).
    await waitForCalls(submit, 1);
    expect(submit).toHaveBeenCalledTimes(1);

    // Release the in-flight submit as delivered; both drains settle.
    (resolveSubmit as ((o: BugReportSubmitOutcome) => void) | null)?.({ kind: 'delivered' });
    await Promise.all([d1, d2]);

    // Exactly one submit, record deleted on delivery.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await recordCount()).toBe(0);
  });

  it('enqueue immediate-drain + an explicit concurrent drain still submit once', async () => {
    let resolveSubmit: ((o: BugReportSubmitOutcome) => void) | null = null;
    const submit = vi.fn(
      () =>
        new Promise<BugReportSubmitOutcome>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir });

    // enqueue fires the immediate drain internally; race an explicit drain.
    await outbox.enqueue(makeInput());
    const explicit = outbox.drain('explicit');
    await waitForCalls(submit, 1);

    expect(submit).toHaveBeenCalledTimes(1);
    (resolveSubmit as ((o: BugReportSubmitOutcome) => void) | null)?.({ kind: 'delivered' });
    await explicit;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await recordCount()).toBe(0);
  });
});

describe('BugReportOutbox — power-loss durability (F1: parent-dir fsync)', () => {
  afterEach(() => {
    openInterceptor.fn = null;
  });

  it('fsyncs the parent directory after a successful record write', async () => {
    // The directory handle (open(dir, 'r')) must get .sync() called — that is
    // the parent-dir fsync. (Skipped on win32, where dir fsync is unsupported;
    // this asserts the POSIX success path.)
    if (process.platform === 'win32') return;

    const dirSync = vi.fn();
    openInterceptor.fn = (p, handle) => {
      if (String(p) === dir) {
        const h = handle as { sync: () => Promise<void> };
        const origSync = h.sync.bind(h);
        h.sync = () => {
          dirSync();
          return origSync();
        };
      }
    };

    const outbox = new BugReportOutbox({
      submit: () => new Promise<BugReportSubmitOutcome>(() => {}),
      isSentryEnabled: () => false,
      dirPath: dir,
    });
    await outbox.enqueue(makeInput());
    expect(dirSync).toHaveBeenCalled();
  });

  it('a parent-dir fsync failure does NOT discard the otherwise-successful write', async () => {
    if (process.platform === 'win32') return;
    openInterceptor.fn = (p, handle) => {
      if (String(p) === dir) {
        (handle as { sync: () => Promise<void> }).sync = () =>
          Promise.reject(new Error('dir fsync not supported here'));
      }
    };

    const outbox = new BugReportOutbox({
      submit: () => new Promise<BugReportSubmitOutcome>(() => {}),
      isSentryEnabled: () => false,
      dirPath: dir,
    });
    const input = makeInput();
    // Must resolve (not throw) and the record must be on disk.
    await expect(outbox.enqueue(input)).resolves.toBeDefined();
    expect(await recordCount()).toBe(1);
  });
});

describe('BugReportOutbox — Windows-safe replace (F2)', () => {
  it('recovers a record from a stranded .bak when the .json is missing (crash before commit)', async () => {
    // Simulate a crash mid-Windows-replace: the live copy was moved aside to
    // `<id>.json.bak` and the process died before the new `<id>.json` landed.
    const input = makeInput({ description: 'pre-crash content' });
    const seeded = BugReportRecordSchema.parse({
      ...input,
      schemaVersion: 1,
      createdAt: Date.now(),
      attempt: 1,
      nextRetryAt: Date.now(),
    });
    const bakPath = path.join(dir, `${input.reportId}.json.bak`);
    await fsp.writeFile(bakPath, JSON.stringify(seeded), 'utf8');
    // No `<id>.json` present.

    const delivered: string[] = [];
    const submit = vi.fn((record: { reportId: string; description: string }) => {
      delivered.push(record.description);
      return Promise.resolve<BugReportSubmitOutcome>({ kind: 'delivered' });
    });
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir });

    await outbox.drain('recovery');

    // The .bak was promoted back to `<id>.json`, loaded, and delivered.
    expect(delivered).toEqual(['pre-crash content']);
    // No stranded .bak remains (it was renamed into place then deleted on delivery).
    const names = await fsp.readdir(dir);
    expect(names.some((n) => n.endsWith('.bak'))).toBe(false);
  });

  it('removes a superseded .bak when the .json is already a valid record (crash after commit)', async () => {
    // Crash AFTER the replacement committed but before the backup was removed:
    // a valid `<id>.json` and a stale `<id>.json.bak` both exist.
    const input = makeInput({ description: 'new content' });
    const valid = BugReportRecordSchema.parse({
      ...input,
      schemaVersion: 1,
      createdAt: Date.now(),
      attempt: 2,
      nextRetryAt: Date.now(),
    });
    const stale = BugReportRecordSchema.parse({
      ...input,
      schemaVersion: 1,
      createdAt: Date.now(),
      attempt: 1,
      nextRetryAt: Date.now(),
    });
    await fsp.writeFile(path.join(dir, `${input.reportId}.json`), JSON.stringify(valid), 'utf8');
    await fsp.writeFile(path.join(dir, `${input.reportId}.json.bak`), JSON.stringify(stale), 'utf8');

    const delivered: number[] = [];
    const submit = vi.fn((record: { attempt: number }) => {
      delivered.push(record.attempt);
      return Promise.resolve<BugReportSubmitOutcome>({ kind: 'delivered' });
    });
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir });

    await outbox.drain('recovery');

    // The committed (valid) record was delivered exactly once; the stale .bak
    // was cleaned up (not re-delivered).
    expect(delivered).toEqual([2]);
    const names = await fsp.readdir(dir);
    expect(names.some((n) => n.endsWith('.bak'))).toBe(false);
  });

  it('rewrites a record over an existing .json even when a stale .bak is already present (FOLD-IN-5)', async () => {
    // FOLD-IN-5 (Phase 7, GPT F4): on Windows, `rename(dest, bak)` fails if `.bak`
    // already exists. A record rewrite (retry bookkeeping) must still succeed by
    // clearing the stale `.bak` first. Force the win32 replace path.
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const nowMs = 1_000_000;
      const input = makeInput({ description: 'live content' });
      // Seed a committed live record AND a leftover stale `.bak` from a prior
      // interrupted replace.
      const live = BugReportRecordSchema.parse({
        ...input,
        schemaVersion: 1,
        createdAt: nowMs,
        attempt: 0,
        nextRetryAt: nowMs,
      });
      const destPath = path.join(dir, `${input.reportId}.json`);
      const bakPath = path.join(dir, `${input.reportId}.json.bak`);
      await fsp.writeFile(destPath, JSON.stringify(live), 'utf8');
      await fsp.writeFile(bakPath, JSON.stringify({ ...live, attempt: 99 }), 'utf8');

      // A failing submit forces recordAttemptFailure → writeRecordDurable, which
      // rewrites `<id>.json` over the existing dest (the move-aside path).
      const submit = vi.fn(() => Promise.resolve<BugReportSubmitOutcome>({ kind: 'retry', error: 'boom' }));
      const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir, now: () => nowMs });

      // Must not throw despite the pre-existing `.bak`.
      await expect(outbox.drain('test')).resolves.toBeUndefined();

      // The rewrite committed (attempt incremented) and no stale `.bak` lingers.
      const raw = await fsp.readFile(destPath, 'utf8');
      expect(BugReportRecordSchema.parse(JSON.parse(raw)).attempt).toBe(1);
      const names = await fsp.readdir(dir);
      expect(names.some((n) => n.endsWith('.bak'))).toBe(false);
    } finally {
      platformSpy.mockRestore();
    }
  });
});

describe('BugReportOutbox — retention visibility (F4)', () => {
  it('emits a visible dead-letter Sentry event when a LIVE record is force-pruned over cap', async () => {
    let nowMs = 1_000_000;
    // A live record well past max age is a forced loss → must be observable.
    const outbox = new BugReportOutbox({
      submit: () => new Promise<BugReportSubmitOutcome>(() => {}),
      isSentryEnabled: () => false,
      dirPath: dir,
      now: () => nowMs,
    });
    const input = makeInput();
    await outbox.enqueue(input);

    nowMs += 40 * 24 * 60 * 60 * 1000; // > 30-day max age
    mockCaptureMessage.mockClear();
    const pruner = new BugReportOutbox({
      submit: vi.fn(alwaysDeliver),
      isSentryEnabled: () => true,
      dirPath: dir,
      now: () => nowMs,
    });
    await pruner.drain('test');

    expect(await recordCount()).toBe(0);
    // A live record forced out is dead-lettered visibly, not silently deleted.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('bug_report_dead_letter'),
      expect.objectContaining({
        tags: expect.objectContaining({
          bug_report_dead_letter: 'true',
          report_id: input.reportId,
          dead_letter_reason: 'retention-forced',
        }),
      }),
    );
  });

  it('prunes oldest dead-letters before live records under byte-cap pressure', async () => {
    const nowMs = 1_000_000;
    // Two records, both under the age cap, but with screenshots large enough
    // that the pair exceeds the 25 MB total-bytes cap → exactly one must go.
    // One is dead-lettered (oldest), one is live (newest). The dead-letter must
    // be evicted first; the live record must survive.
    const big = 'A'.repeat(13 * 1024 * 1024); // ~13 MB each → ~26 MB total > 25 MB cap
    const deadInput = makeInput({ screenshotBase64: big });
    const liveInput = makeInput({ screenshotBase64: big });
    await fsp.writeFile(
      path.join(dir, `${deadInput.reportId}.json`),
      JSON.stringify(
        BugReportRecordSchema.parse({
          ...deadInput,
          schemaVersion: 1,
          createdAt: nowMs - 1000, // older
          attempt: 12,
          nextRetryAt: Number.MAX_SAFE_INTEGER,
          deadLetteredAt: nowMs - 500,
        }),
      ),
      'utf8',
    );
    await fsp.writeFile(
      path.join(dir, `${liveInput.reportId}.json`),
      JSON.stringify(
        BugReportRecordSchema.parse({
          ...liveInput,
          schemaVersion: 1,
          createdAt: nowMs, // newer + live → must be preserved
          attempt: 0,
          nextRetryAt: nowMs,
        }),
      ),
      'utf8',
    );

    mockCaptureMessage.mockClear();
    const submit = vi.fn(() => Promise.resolve<BugReportSubmitOutcome>({ kind: 'retry' }));
    const outbox = new BugReportOutbox({ submit, isSentryEnabled: () => true, dirPath: dir, now: () => nowMs });
    await outbox.drain('test');

    const names = await fsp.readdir(dir);
    // The dead-letter was evicted first; the live record survived.
    expect(names).not.toContain(`${deadInput.reportId}.json`);
    expect(names).toContain(`${liveInput.reportId}.json`);
    // Pruning a dead-letter does NOT re-emit a retention-forced event (it was
    // already visible when it dead-lettered).
    const retentionForced = mockCaptureMessage.mock.calls.filter(
      ([, opts]) => (opts as any)?.tags?.dead_letter_reason === 'retention-forced',
    );
    expect(retentionForced).toHaveLength(0);
  });
});

describe('BugReportOutbox — backoff/jitter', () => {
  it('schedules each retry farther out (jittered, within ±20% of the base schedule)', async () => {
    let nowMs = 1_000_000;
    const outbox = new BugReportOutbox({
      submit: () => Promise.resolve<BugReportSubmitOutcome>({ kind: 'retry' }),
      isSentryEnabled: () => true,
      dirPath: dir,
      now: () => nowMs,
    });
    // Seed the record directly (no enqueue auto-drain) so each drain in the loop
    // is exactly one attempt and the delay measurement is unambiguous.
    const input = makeInput();
    const seeded = BugReportRecordSchema.parse({
      ...input,
      schemaVersion: 1,
      createdAt: nowMs,
      attempt: 0,
      nextRetryAt: nowMs,
    });
    await fsp.writeFile(path.join(dir, `${input.reportId}.json`), JSON.stringify(seeded), 'utf8');

    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await outbox.drain('test');
      const raw = await fsp.readFile(path.join(dir, `${input.reportId}.json`), 'utf8');
      const parsed = BugReportRecordSchema.parse(JSON.parse(raw));
      delays.push(parsed.nextRetryAt - nowMs);
      nowMs = parsed.nextRetryAt; // become due again
    }

    // Base schedule (ms): [1000, 5000, 25000, 60000, ...] for attempts 1..4.
    // Each scheduled delay must be within ±20% of its base.
    const bases = [1_000, 5_000, 25_000, 60_000];
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(Math.floor(bases[i] * 0.8) - 1);
      expect(d).toBeLessThanOrEqual(Math.ceil(bases[i] * 1.2) + 1);
    });
  });
});
