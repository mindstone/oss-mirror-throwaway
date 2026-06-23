import * as fs from 'node:fs';
import * as path from 'node:path';
import { setErrorReporter } from '@core/errorReporter';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox-rehab-a3',
}));

import { CloudOutbox } from '../cloudOutbox';

const TEST_DATA_PATH = '/tmp/test-cloud-outbox-rehab-a3';
const OUTBOX_DIR = path.join(TEST_DATA_PATH, 'sessions');
const OUTBOX_PATH = path.join(OUTBOX_DIR, 'cloud-outbox.json');

interface PersistedEntry {
  id: string;
  sessionId: string;
  op: 'upsert' | 'delete';
  enqueuedAt: number;
  attempts: number;
  nextRetryAt: number;
  status: 'pending' | 'permanent_failure';
  lastError?: string;
  terminalReason?: 'body-too-large' | 'session-tombstoned' | 'unknown-permanent';
}

function writeOutboxFile(payload: Record<string, unknown>): void {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.writeFileSync(OUTBOX_PATH, JSON.stringify(payload), 'utf8');
}

function readOutboxFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) as Record<string, unknown>;
}

function makeEntry(overrides: Partial<PersistedEntry> & { sessionId: string }): PersistedEntry {
  return {
    id: `${overrides.sessionId}:upsert:1`,
    op: 'upsert',
    enqueuedAt: 1_700_000_000_000,
    attempts: 5,
    nextRetryAt: Number.MAX_SAFE_INTEGER,
    status: 'permanent_failure',
    ...overrides,
  };
}

describe('CloudOutbox Stage A3 — rehabilitateLegacyPermanentFailures', () => {
  let outbox: CloudOutbox;
  const captureMessageSpy = vi.fn();
  const captureExceptionSpy = vi.fn();
  // Stage 5 of 260610 improve-sentry-noise: the boot-rehab summary is a
  // ledger-only known condition — the per-call observable is the skip
  // breadcrumb (no Sentry capture goes out).
  const breadcrumbSpy = vi.fn();

  beforeEach(() => {
    captureMessageSpy.mockReset();
    captureExceptionSpy.mockReset();
    breadcrumbSpy.mockReset();
    setErrorReporter({
      captureException: (error, context) => captureExceptionSpy(error, context),
      captureMessage: (message, context) => captureMessageSpy(message, context),
      addBreadcrumb: (breadcrumb) => breadcrumbSpy(breadcrumb),
    });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
    outbox = new CloudOutbox();
  });

  afterEach(() => {
    outbox._resetForTesting();
    resetSessionMutexForTests();
    setErrorReporter({ captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('rehabs entries with terminalReason="body-too-large" (new format)', () => {
    const before = Date.now();
    writeOutboxFile({
      _cloudUrl: 'https://test.example.com',
      'session-bt-new': makeEntry({
        sessionId: 'session-bt-new',
        status: 'permanent_failure',
        lastError: 'Request body exceeds 25MB limit',
        terminalReason: 'body-too-large',
      }),
    });

    outbox.load();

    const entry = outbox.getAll().find((e) => e.sessionId === 'session-bt-new');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('pending');
    expect(entry!.attempts).toBe(0);
    expect(entry!.lastError).toBeUndefined();
    expect(entry!.terminalReason).toBeUndefined();
    expect(entry!.nextRetryAt).toBeGreaterThanOrEqual(before);
    expect(entry!.nextRetryAt).toBeLessThanOrEqual(Date.now());
  });

  it('rehabs legacy entries (no terminalReason) that match the lastError regex', () => {
    writeOutboxFile({
      _cloudUrl: 'https://test.example.com',
      'session-bt-legacy': makeEntry({
        sessionId: 'session-bt-legacy',
        status: 'permanent_failure',
        lastError: 'Request body exceeds 25MB limit',
        // terminalReason intentionally omitted (legacy entry written before A2)
      }),
    });

    outbox.load();

    const entry = outbox.getAll().find((e) => e.sessionId === 'session-bt-legacy');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('pending');
    expect(entry!.attempts).toBe(0);
    expect(entry!.lastError).toBeUndefined();
    expect(entry!.terminalReason).toBeUndefined();
  });

  it('does NOT rehab entries with terminalReason="session-tombstoned"', () => {
    writeOutboxFile({
      _cloudUrl: 'https://test.example.com',
      'session-tomb': makeEntry({
        sessionId: 'session-tomb',
        status: 'permanent_failure',
        lastError: '410 Gone',
        terminalReason: 'session-tombstoned',
      }),
    });

    outbox.load();

    const entry = outbox.getAll().find((e) => e.sessionId === 'session-tomb');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('permanent_failure');
    expect(entry!.terminalReason).toBe('session-tombstoned');
    expect(entry!.lastError).toBe('410 Gone');
    expect(entry!.attempts).toBe(5);
  });

  it('does NOT rehab entries with terminalReason="unknown-permanent"', () => {
    writeOutboxFile({
      _cloudUrl: 'https://test.example.com',
      'session-unknown': makeEntry({
        sessionId: 'session-unknown',
        status: 'permanent_failure',
        lastError: 'INVALID_SEQ',
        terminalReason: 'unknown-permanent',
      }),
    });

    outbox.load();

    const entry = outbox.getAll().find((e) => e.sessionId === 'session-unknown');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('permanent_failure');
    expect(entry!.terminalReason).toBe('unknown-permanent');
    expect(entry!.attempts).toBe(5);
  });

  it('is idempotent: loading twice does not re-process rehabbed entries', () => {
    writeOutboxFile({
      _cloudUrl: 'https://test.example.com',
      'session-idem': makeEntry({
        sessionId: 'session-idem',
        status: 'permanent_failure',
        lastError: 'Request body exceeds 25MB limit',
        terminalReason: 'body-too-large',
      }),
    });

    outbox.load();
    const rehabBreadcrumbs = breadcrumbSpy.mock.calls.filter(
      ([crumb]) => (crumb as { message?: string }).message === 'cloud_sync_boot_rehab_summary',
    );
    expect(rehabBreadcrumbs).toHaveLength(1);
    expect(rehabBreadcrumbs[0][0]).toMatchObject({
      category: 'known_condition',
      data: expect.objectContaining({ rehabilitated: 1, sink: 'ledger-only' }),
    });
    // Ledger-only: nothing reaches the Sentry issue stream.
    expect(captureMessageSpy).not.toHaveBeenCalled();
    expect(captureExceptionSpy).not.toHaveBeenCalled();

    breadcrumbSpy.mockClear();
    outbox.load();
    expect(breadcrumbSpy).not.toHaveBeenCalled();

    const entry = outbox.getAll().find((e) => e.sessionId === 'session-idem');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('pending');
    expect(entry!.attempts).toBe(0);

    // A fresh outbox instance loading the persisted (now-pending) entry is a no-op:
    // the status filter skips it because it's no longer permanent_failure.
    outbox.flush();
    const fresh = new CloudOutbox();
    breadcrumbSpy.mockClear();
    fresh.load();
    expect(breadcrumbSpy).not.toHaveBeenCalled();
    fresh._resetForTesting();
  });

  it('schedules a disk write after rehab so the new state is persisted', () => {
    writeOutboxFile({
      _cloudUrl: 'https://test.example.com',
      'session-disk': makeEntry({
        sessionId: 'session-disk',
        status: 'permanent_failure',
        lastError: 'Request body exceeds 25MB limit',
        terminalReason: 'body-too-large',
      }),
    });

    outbox.load();
    outbox.flush(); // resolve the debounced disk write synchronously

    const persisted = readOutboxFile();
    const persistedEntry = persisted['session-disk'] as PersistedEntry | undefined;
    expect(persistedEntry).toBeDefined();
    expect(persistedEntry!.status).toBe('pending');
    expect(persistedEntry!.attempts).toBe(0);
    expect(persistedEntry!.terminalReason).toBeUndefined();
    expect(persistedEntry!.lastError).toBeUndefined();
  });

  it('records a ledger-only summary breadcrumb with rehabilitated/skipped counts when at least one entry is rehabbed', () => {
    writeOutboxFile({
      _cloudUrl: 'https://test.example.com',
      'session-bt-summary': makeEntry({
        sessionId: 'session-bt-summary',
        status: 'permanent_failure',
        lastError: 'Request body exceeds 25MB limit',
        terminalReason: 'body-too-large',
      }),
      'session-tomb-summary': makeEntry({
        sessionId: 'session-tomb-summary',
        status: 'permanent_failure',
        lastError: '410 Gone',
        terminalReason: 'session-tombstoned',
      }),
      'session-unknown-summary': makeEntry({
        sessionId: 'session-unknown-summary',
        status: 'permanent_failure',
        lastError: 'INVALID_SEQ',
        terminalReason: 'unknown-permanent',
      }),
    });

    outbox.load();

    const rehabBreadcrumbs = breadcrumbSpy.mock.calls.filter(
      ([crumb]) => (crumb as { message?: string }).message === 'cloud_sync_boot_rehab_summary',
    );
    expect(rehabBreadcrumbs).toHaveLength(1);
    expect(rehabBreadcrumbs[0][0]).toMatchObject({
      category: 'known_condition',
      level: 'info',
      data: expect.objectContaining({ rehabilitated: 1, skipped: 2, sink: 'ledger-only' }),
    });
    // Ledger-only sink: the summary never reaches the Sentry issue stream.
    expect(captureMessageSpy).not.toHaveBeenCalled();
    expect(captureExceptionSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit the summary when nothing is rehabbed', () => {
    writeOutboxFile({
      _cloudUrl: 'https://test.example.com',
      'session-no-rehab': makeEntry({
        sessionId: 'session-no-rehab',
        status: 'permanent_failure',
        lastError: 'INVALID_SEQ',
        terminalReason: 'unknown-permanent',
      }),
    });

    outbox.load();

    expect(captureMessageSpy).not.toHaveBeenCalled();
    expect(captureExceptionSpy).not.toHaveBeenCalled();
    expect(
      breadcrumbSpy.mock.calls.filter(
        ([crumb]) => (crumb as { message?: string }).message === 'cloud_sync_boot_rehab_summary',
      ),
    ).toHaveLength(0);
  });
});
