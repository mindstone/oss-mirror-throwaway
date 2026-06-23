// mobile/src/__tests__/diagnosticEventBufferStorage.test.ts
//
// Unit tests for MobileDiagnosticEventBuffer.
// Mirrors the expo-file-system mock pattern from offlineQueueStorage.test.ts.

const mockFileStore: Record<string, {
  uri: string;
  name: string;
  exists: boolean;
  contents: string;
  create: jest.Mock;
  write: jest.Mock;
  text: jest.Mock;
  delete: jest.Mock;
  rename: jest.Mock;
  copy: jest.Mock;
}> = {};

const mockDirStore: Record<string, {
  uri: string;
  exists: boolean;
  create: jest.Mock;
  delete: jest.Mock;
  list: jest.Mock;
}> = {};

const MOCK_DOC_URI = '/mock/documents';

mockDirStore[MOCK_DOC_URI] = {
  uri: MOCK_DOC_URI,
  exists: true,
  create: jest.fn(),
  delete: jest.fn(),
  list: jest.fn().mockReturnValue([]),
};

jest.mock('expo-file-system', () => {
  function joinUri(...parts: unknown[]): string {
    const strings = parts.map((p) => {
      if (p && typeof p === 'object' && 'uri' in p) return (p as { uri: string }).uri;
      return String(p);
    });
    let result = strings[0] ?? '';
    for (let i = 1; i < strings.length; i++) {
      const seg = strings[i];
      if (result.endsWith('/')) result += seg;
      else result += '/' + seg;
    }
    return result;
  }

  class MockFile {
    uri: string;
    name: string;
    exists = false;
    contents = '';
    create: jest.Mock;
    write: jest.Mock;
    text: jest.Mock;
    delete: jest.Mock;
    rename: jest.Mock;
    copy: jest.Mock;

    constructor(...uris: unknown[]) {
      this.uri = joinUri(...uris);
      const lastSlash = this.uri.lastIndexOf('/');
      this.name = lastSlash >= 0 ? this.uri.slice(lastSlash + 1) : this.uri;

      const stored = mockFileStore[this.uri];
      if (stored) {
        this.exists = stored.exists;
        this.contents = stored.contents;
        this.create = stored.create;
        this.write = stored.write;
        this.text = stored.text;
        this.delete = stored.delete;
        this.rename = stored.rename;
        this.copy = stored.copy;
        return;
      }
      this.create = jest.fn(() => {
        this.exists = true;
        if (mockFileStore[this.uri]) mockFileStore[this.uri].exists = true;
      });
      this.write = jest.fn((payload: string) => {
        this.contents = payload;
        if (mockFileStore[this.uri]) mockFileStore[this.uri].contents = payload;
      });
      this.text = jest.fn(async () => this.contents);
      this.delete = jest.fn(() => {
        this.exists = false;
        if (mockFileStore[this.uri]) mockFileStore[this.uri].exists = false;
      });
      this.rename = jest.fn((newName: string) => {
        const baseSlash = this.uri.lastIndexOf('/');
        const newUri = baseSlash >= 0 ? this.uri.slice(0, baseSlash + 1) + newName : newName;
        // Simulate the native rename: target is overwritten, source becomes target.
        const previousContents = this.contents;
        const previousExists = this.exists;
        // Source no longer exists at old path.
        if (mockFileStore[this.uri]) mockFileStore[this.uri].exists = false;
        this.exists = false;
        // Update this instance to point at new path.
        this.uri = newUri;
        this.name = newName;
        this.contents = previousContents;
        this.exists = previousExists;
        // Mirror into the store.
        mockFileStore[newUri] = {
          uri: newUri,
          name: newName,
          exists: previousExists,
          contents: previousContents,
          create: this.create,
          write: this.write,
          text: jest.fn(async () => mockFileStore[newUri].contents),
          delete: jest.fn(() => { mockFileStore[newUri].exists = false; }),
          rename: this.rename,
          copy: jest.fn(),
        };
        // Rebind text to read the up-to-date stored contents.
        this.text = mockFileStore[newUri].text;
      });
      this.copy = jest.fn();
      mockFileStore[this.uri] = {
        uri: this.uri,
        name: this.name,
        exists: this.exists,
        contents: this.contents,
        create: this.create,
        write: this.write,
        text: this.text,
        delete: this.delete,
        rename: this.rename,
        copy: this.copy,
      };
    }
  }

  class MockDirectory {
    uri: string;
    exists = false;
    create = jest.fn();
    delete = jest.fn();
    list = jest.fn().mockReturnValue([]);

    constructor(...uris: unknown[]) {
      this.uri = joinUri(...uris);
      const stored = mockDirStore[this.uri];
      if (stored) {
        this.exists = stored.exists;
        this.create = stored.create;
        this.delete = stored.delete;
        this.list = stored.list;
        return;
      }
      this.create = jest.fn(() => {
        this.exists = true;
        if (mockDirStore[this.uri]) mockDirStore[this.uri].exists = true;
      });
      mockDirStore[this.uri] = {
        uri: this.uri,
        exists: this.exists,
        create: this.create,
        delete: this.delete,
        list: this.list,
      };
    }
  }

  return {
    Paths: {
      get document() { return mockDirStore['/mock/documents']; },
    },
    Directory: MockDirectory,
    File: MockFile,
  };
});

jest.mock('@rebel/cloud-client', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  MobileDiagnosticEventBuffer,
  appendMobileDiagnosticEvent,
  flushMobileDiagnosticEvents,
  readRecentMobileDiagnosticEvents,
  __resetMobileDiagnosticEventBufferSingletonForTests,
  type MobileDiagnosticBufferEvent,
} from '../storage/diagnosticEventBufferStorage';

const BUFFER_DIR_URI = `${MOCK_DOC_URI}/diagnostic-events`;
const LEDGER_URI = `${BUFFER_DIR_URI}/events.jsonl`;
const TMP_LEDGER_URI = `${BUFFER_DIR_URI}/events.jsonl.tmp`;

function makeEvent(overrides: Partial<MobileDiagnosticBufferEvent> = {}): MobileDiagnosticBufferEvent {
  return {
    ts: 1000,
    surface: 'mobile',
    source: 'continuity_breadcrumb',
    family: 'session-merge',
    message: 'complete',
    ...overrides,
  };
}

function getLedgerFile() {
  return mockFileStore[LEDGER_URI];
}

function getTmpLedgerFile() {
  return mockFileStore[TMP_LEDGER_URI];
}

describe('MobileDiagnosticEventBuffer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(mockFileStore)) delete mockFileStore[key];
    for (const key of Object.keys(mockDirStore)) {
      if (key !== MOCK_DOC_URI) delete mockDirStore[key];
    }
    mockDirStore[MOCK_DOC_URI] = {
      uri: MOCK_DOC_URI,
      exists: true,
      create: jest.fn(),
      delete: jest.fn(),
      list: jest.fn().mockReturnValue([]),
    };
    __resetMobileDiagnosticEventBufferSingletonForTests();
  });

  it('append + flush + readRecent returns events oldest-first', async () => {
    const buffer = new MobileDiagnosticEventBuffer();
    buffer.append(makeEvent({ ts: 1, message: 'a' }));
    buffer.append(makeEvent({ ts: 2, message: 'b' }));
    buffer.append(makeEvent({ ts: 3, message: 'c' }));
    await buffer.flush();
    const events = await buffer.readRecent();
    expect(events.map((e) => e.message)).toEqual(['a', 'b', 'c']);
  });

  it('cross-launch persistence: a fresh buffer reads what an earlier one wrote', async () => {
    const first = new MobileDiagnosticEventBuffer();
    first.append(makeEvent({ ts: 10, message: 'persisted' }));
    await first.flush();

    const second = new MobileDiagnosticEventBuffer();
    const events = await second.readRecent();
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('persisted');
  });

  it('ring cap eviction: file is trimmed to RING_BUFFER_CAP entries on flush', async () => {
    const buffer = new MobileDiagnosticEventBuffer();
    for (let i = 0; i < 600; i++) {
      buffer.append(makeEvent({ ts: i, message: `m${i}` }));
    }
    await buffer.flush();
    const events = await buffer.readRecent({ limit: 1000, maxBytes: 10 * 1024 * 1024 });
    expect(events).toHaveLength(500);
    // Oldest 100 evicted; expect ts 100..599
    expect(events[0].ts).toBe(100);
    expect(events[events.length - 1].ts).toBe(599);
  });

  it('.tmp recovery: read recovers from tmp when primary is missing', async () => {
    const buffer = new MobileDiagnosticEventBuffer();
    buffer.append(makeEvent({ ts: 1, message: 'recovered' }));
    await buffer.flush();
    // Simulate crash mid-rename: primary deleted, tmp left present.
    const primaryEntry = getLedgerFile();
    if (!primaryEntry) throw new Error('expected primary file to exist after flush');
    const recoveredContents = primaryEntry.contents;
    primaryEntry.exists = false;
    mockFileStore[TMP_LEDGER_URI] = {
      uri: TMP_LEDGER_URI,
      name: 'events.jsonl.tmp',
      exists: true,
      contents: recoveredContents,
      create: jest.fn(),
      write: jest.fn(),
      text: jest.fn(async () => recoveredContents),
      delete: jest.fn(() => { mockFileStore[TMP_LEDGER_URI].exists = false; }),
      rename: jest.fn((newName: string) => {
        const newUri = `${BUFFER_DIR_URI}/${newName}`;
        mockFileStore[newUri] = {
          uri: newUri,
          name: newName,
          exists: true,
          contents: recoveredContents,
          create: jest.fn(),
          write: jest.fn(),
          text: jest.fn(async () => recoveredContents),
          delete: jest.fn(() => { mockFileStore[newUri].exists = false; }),
          rename: jest.fn(),
          copy: jest.fn(),
        };
        mockFileStore[TMP_LEDGER_URI].exists = false;
      }),
      copy: jest.fn(),
    };

    const second = new MobileDiagnosticEventBuffer();
    const events = await second.readRecent();
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('recovered');
  });

  it('corrupt JSONL line is skipped, valid lines still returned', async () => {
    const buffer = new MobileDiagnosticEventBuffer();
    buffer.append(makeEvent({ ts: 1, message: 'good-1' }));
    await buffer.flush();
    // Hand-mangle: append a malformed line directly to the ledger contents.
    const primary = getLedgerFile();
    primary.contents = primary.contents + 'this is not json\n' + JSON.stringify({ ts: 2, surface: 'mobile', source: 'queue', message: 'good-2' }) + '\n';
    primary.text = jest.fn(async () => primary.contents);

    const second = new MobileDiagnosticEventBuffer();
    const events = await second.readRecent();
    expect(events.map((e) => e.message)).toEqual(['good-1', 'good-2']);
  });

  it('size cap on read drops oldest events to fit maxBytes', async () => {
    const buffer = new MobileDiagnosticEventBuffer();
    for (let i = 0; i < 50; i++) {
      buffer.append(makeEvent({
        ts: i,
        message: `m${i}`,
        // Pad data to make each line meaningfully sized.
        data: { padding: 'x'.repeat(200) },
      }));
    }
    await buffer.flush();
    // 50 events * ~250 bytes each = ~12.5 KB total. Cap to ~5 KB → expect ~20 events.
    const capped = await buffer.readRecent({ maxBytes: 5 * 1024 });
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThan(50);
    // The retained tail should be the newest entries (cap drops oldest first).
    const last = capped[capped.length - 1];
    expect(last.ts).toBe(49);
  });

  it('empty buffer reads return empty array', async () => {
    const buffer = new MobileDiagnosticEventBuffer();
    expect(await buffer.readRecent()).toEqual([]);
  });

  it('debounced flush coalesces rapid appends into a single disk write', async () => {
    jest.useFakeTimers();
    try {
      const buffer = new MobileDiagnosticEventBuffer();
      for (let i = 0; i < 50; i++) buffer.append(makeEvent({ ts: i, message: `m${i}` }));

      // No flush yet — timer hasn't fired and we haven't called flush() explicitly.
      expect(getLedgerFile()).toBeUndefined();

      jest.runAllTimers();
      // Allow the scheduled async flush to drain.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
    // After the debounced flush, exactly one write batch should be on disk.
    const events = await new MobileDiagnosticEventBuffer().readRecent();
    expect(events).toHaveLength(50);
  });

  it('singleton wrappers share state across calls', async () => {
    appendMobileDiagnosticEvent(makeEvent({ ts: 1, message: 'first' }));
    appendMobileDiagnosticEvent(makeEvent({ ts: 2, message: 'second' }));
    await flushMobileDiagnosticEvents();
    const events = await readRecentMobileDiagnosticEvents();
    expect(events.map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('append never throws even when the in-memory push fails (defensive guard)', () => {
    const buffer = new MobileDiagnosticEventBuffer();
    // Force a synchronous failure inside append's work.
    const originalPush = Array.prototype.push;
    Array.prototype.push = function () {
      throw new Error('boom');
    };
    try {
      expect(() => buffer.append(makeEvent())).not.toThrow();
    } finally {
      Array.prototype.push = originalPush;
    }
  });
});
