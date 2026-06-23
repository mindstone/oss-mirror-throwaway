// mobile/src/__tests__/offlineQueueStorage.test.ts
// Unit tests for ExpoFileSystemQueueStorage adapter (new expo-file-system API).

// ---- Mock stores (module-scoped, survive jest.mock hoisting) ----

const mockFileStore: Record<string, {
  uri: string;
  name: string;
  exists: boolean;
  create: jest.Mock;
  write: jest.Mock;
  text: jest.Mock;
  delete: jest.Mock;
  move: jest.Mock;
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

// Use a simple path to avoid protocol-slash issues in join()
const MOCK_DOC_URI = '/mock/documents';

// Pre-seed document directory
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
    // Simple join: concatenate with '/' separator, deduplicate slashes
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
    create = jest.fn();
    write = jest.fn();
    text = jest.fn().mockResolvedValue('');
    delete = jest.fn();
    move = jest.fn();
    rename = jest.fn();
    copy = jest.fn();

    constructor(...uris: unknown[]) {
      this.uri = joinUri(...uris);
      const lastSlash = this.uri.lastIndexOf('/');
      this.name = lastSlash >= 0 ? this.uri.slice(lastSlash + 1) : this.uri;

      const stored = mockFileStore[this.uri];
      if (stored) {
        this.exists = stored.exists;
        this.create = stored.create;
        this.write = stored.write;
        this.text = stored.text;
        this.delete = stored.delete;
        this.move = stored.move;
        this.rename = stored.rename;
        this.copy = stored.copy;
      }
      mockFileStore[this.uri] = this;
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
      }
      mockDirStore[this.uri] = this;
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

import { ExpoFileSystemQueueStorage } from '../storage/offlineQueueStorage';
import type { QueueItem, QueueSnapshot } from '@rebel/cloud-client';

const QUEUE_DIR_URI = `${MOCK_DOC_URI}/offline-queue`;
const INDEX_URI = `${QUEUE_DIR_URI}/index.json`;
const TMP_INDEX_URI = `${QUEUE_DIR_URI}/index.json.tmp`;

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'test-item-1',
    type: 'voice-transcription',
    status: 'pending',
    enqueuedAt: 1000,
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    payloadUri: `${QUEUE_DIR_URI}/test-item-1.m4a`,
    payloadExt: 'm4a',
    metadata: { sessionId: 'session-1' },
    ...overrides,
  };
}

function getQueueDir() { return mockDirStore[QUEUE_DIR_URI]; }
function getIndexFile() { return mockFileStore[INDEX_URI]; }
function getTmpIndexFile() { return mockFileStore[TMP_INDEX_URI]; }

describe('ExpoFileSystemQueueStorage', () => {
  let storage: ExpoFileSystemQueueStorage;

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

    storage = new ExpoFileSystemQueueStorage();
    getQueueDir().exists = false;

    // Pre-seed File entries in the mock store so test helpers can reference
    // them before saveSnapshot/loadSnapshot create fresh instances.
    // The MockFile constructor auto-registers in mockFileStore by URI.
    const { File: MockFile } = jest.requireMock('expo-file-system');
    new MockFile(QUEUE_DIR_URI, 'index.json');
    new MockFile(QUEUE_DIR_URI, 'index.json.tmp');
  });

  // ---- saveSnapshot ----

  describe('saveSnapshot', () => {
    it('creates directory on first write', async () => {
      await storage.saveSnapshot([]);
      expect(getQueueDir().create).toHaveBeenCalledWith({ intermediates: true, idempotent: true });
    });

    it('writes to tmp file then renames for atomic write', async () => {
      const items = [makeItem()];
      await storage.saveSnapshot(items);

      const tmpFile = getTmpIndexFile();
      expect(tmpFile.create).toHaveBeenCalled();
      expect(tmpFile.write).toHaveBeenCalledWith(JSON.stringify({ version: 1, items }));
      expect(tmpFile.rename).toHaveBeenCalledWith('index.json');
    });

    it('handles sequential saves correctly (rename mutates File URI)', async () => {
      const item1 = makeItem({ id: 'item-1' });
      const item2 = makeItem({ id: 'item-2' });

      await storage.saveSnapshot([item1]);
      // After first save, the tmp file was renamed. Fresh instances should
      // be used on the next call — the old tmp reference now points to
      // index.json, not index.json.tmp.
      await storage.saveSnapshot([item1, item2]);

      // Both saves should have written to the tmp file and renamed.
      // The key assertion: the second save didn't corrupt or skip.
      const tmpFile = getTmpIndexFile();
      expect(tmpFile.rename).toHaveBeenCalledWith('index.json');
      expect(tmpFile.write).toHaveBeenLastCalledWith(
        JSON.stringify({ version: 1, items: [item1, item2] }),
      );
    });

    it('does not recreate directory on subsequent writes', async () => {
      await storage.saveSnapshot([]);
      getQueueDir().create.mockClear();
      await storage.saveSnapshot([makeItem()]);
      expect(getQueueDir().create).not.toHaveBeenCalled();
    });

    it('skips directory creation if it already exists', async () => {
      getQueueDir().exists = true;
      await storage.saveSnapshot([]);
      expect(getQueueDir().create).not.toHaveBeenCalled();
    });
  });

  // ---- loadSnapshot ----

  describe('loadSnapshot', () => {
    it('returns empty array when index does not exist', async () => {
      getIndexFile().exists = false;
      getTmpIndexFile().exists = false;
      expect(await storage.loadSnapshot()).toEqual([]);
    });

    it('returns persisted items when index exists', async () => {
      const item = makeItem();
      getIndexFile().exists = true;
      getIndexFile().text.mockResolvedValueOnce(JSON.stringify({ version: 1, items: [item] }));
      expect(await storage.loadSnapshot()).toEqual([item]);
    });

    it('recovers temp index file when main index is missing', async () => {
      const item = makeItem();
      getIndexFile().exists = false;
      getTmpIndexFile().exists = true;
      getTmpIndexFile().rename.mockImplementation(() => {
        getIndexFile().exists = true;
        getIndexFile().text.mockResolvedValueOnce(JSON.stringify({ version: 1, items: [item] }));
      });
      const items = await storage.loadSnapshot();
      expect(getTmpIndexFile().rename).toHaveBeenCalledWith('index.json');
      expect(items).toEqual([item]);
    });

    it('limits temp recovery recursion depth', async () => {
      getIndexFile().exists = false;
      getTmpIndexFile().exists = true;
      getTmpIndexFile().rename.mockImplementation(() => { /* noop */ });
      expect(await storage.loadSnapshot()).toEqual([]);
    });

    it('returns empty array on corrupt JSON', async () => {
      getIndexFile().exists = true;
      getIndexFile().text.mockResolvedValueOnce('not valid json{{{');
      expect(await storage.loadSnapshot()).toEqual([]);
    });

    it('returns empty array for unsupported version', async () => {
      getIndexFile().exists = true;
      getIndexFile().text.mockResolvedValueOnce(JSON.stringify({ version: 99, items: [] }));
      expect(await storage.loadSnapshot()).toEqual([]);
    });

    it('returns empty array when read throws', async () => {
      getIndexFile().exists = true;
      getIndexFile().text.mockRejectedValueOnce(new Error('Disk error'));
      expect(await storage.loadSnapshot()).toEqual([]);
    });
  });

  // ---- savePayloadFromUri ----

  describe('savePayloadFromUri', () => {
    it('copies source file to queue directory', async () => {
      const sourceUri = '/tmp/audio-recording-123.m4a';
      const result = await storage.savePayloadFromUri('item-1', sourceUri, 'm4a');
      expect(mockFileStore[sourceUri]).toBeDefined();
      expect(mockFileStore[sourceUri].copy).toHaveBeenCalled();
      expect(result).toContain('item-1.m4a');
    });

    it('creates directory before copying', async () => {
      await storage.savePayloadFromUri('item-1', '/tmp/audio.m4a', 'm4a');
      expect(getQueueDir().create).toHaveBeenCalledWith({ intermediates: true, idempotent: true });
    });
  });

  // ---- getPayloadUri ----

  describe('getPayloadUri', () => {
    it('returns URI when payload file exists', async () => {
      getQueueDir().exists = true;
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const payloadFile = new MockFile(QUEUE_DIR_URI, 'item-1.m4a');
      getQueueDir().list.mockReturnValue([payloadFile]);
      const uri = await storage.getPayloadUri('item-1');
      expect(uri).toContain('item-1.m4a');
    });

    it('returns null when payload file does not exist', async () => {
      getQueueDir().exists = true;
      const { File: MockFile } = jest.requireMock('expo-file-system');
      getQueueDir().list.mockReturnValue([new MockFile(QUEUE_DIR_URI, 'other-item.m4a')]);
      expect(await storage.getPayloadUri('item-1')).toBeNull();
    });

    it('returns null when directory does not exist', async () => {
      getQueueDir().exists = false;
      expect(await storage.getPayloadUri('item-1')).toBeNull();
    });
  });

  // ---- deletePayload ----

  describe('deletePayload', () => {
    it('deletes payload file when it exists', async () => {
      getQueueDir().exists = true;
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const payloadFile = new MockFile(QUEUE_DIR_URI, 'item-1.m4a');
      payloadFile.exists = true;
      getQueueDir().list.mockReturnValue([payloadFile]);
      await storage.deletePayload('item-1');
      expect(payloadFile.delete).toHaveBeenCalled();
    });

    it('is a no-op when payload does not exist', async () => {
      getQueueDir().exists = true;
      getQueueDir().list.mockReturnValue([]);
      await storage.deletePayload('nonexistent');
    });

    it('does not throw when delete fails', async () => {
      getQueueDir().exists = true;
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const payloadFile = new MockFile(QUEUE_DIR_URI, 'item-1.m4a');
      payloadFile.exists = true;
      payloadFile.delete.mockImplementation(() => { throw new Error('Permission denied'); });
      getQueueDir().list.mockReturnValue([payloadFile]);
      await expect(storage.deletePayload('item-1')).resolves.toBeUndefined();
    });
  });

  // ---- listPayloadIds ----

  describe('listPayloadIds', () => {
    it('returns IDs extracted from filenames', async () => {
      getQueueDir().exists = true;
      const { File: MockFile } = jest.requireMock('expo-file-system');
      getQueueDir().list.mockReturnValue([
        new MockFile(QUEUE_DIR_URI, 'abc123.m4a'),
        new MockFile(QUEUE_DIR_URI, 'def456.wav'),
        new MockFile(QUEUE_DIR_URI, 'index.json'),
      ]);
      expect(await storage.listPayloadIds()).toEqual(['abc123', 'def456']);
    });

    it('filters out index files', async () => {
      getQueueDir().exists = true;
      const { File: MockFile } = jest.requireMock('expo-file-system');
      getQueueDir().list.mockReturnValue([
        new MockFile(QUEUE_DIR_URI, 'index.json'),
        new MockFile(QUEUE_DIR_URI, 'index.json.tmp'),
        new MockFile(QUEUE_DIR_URI, 'item-1.m4a'),
      ]);
      expect(await storage.listPayloadIds()).toEqual(['item-1']);
    });

    it('returns empty array when directory is empty', async () => {
      getQueueDir().exists = true;
      getQueueDir().list.mockReturnValue([]);
      expect(await storage.listPayloadIds()).toEqual([]);
    });

    it('returns empty array when directory does not exist', async () => {
      getQueueDir().exists = false;
      expect(await storage.listPayloadIds()).toEqual([]);
    });

    it('returns empty array on read error', async () => {
      getQueueDir().exists = true;
      getQueueDir().list.mockImplementation(() => { throw new Error('Disk error'); });
      expect(await storage.listPayloadIds()).toEqual([]);
    });

    it('returns deduplicated IDs from both media and JSON payloads', async () => {
      getQueueDir().exists = true;
      const { File: MockFile } = jest.requireMock('expo-file-system');
      getQueueDir().list.mockReturnValue([
        new MockFile(QUEUE_DIR_URI, 'item-1.m4a'),
        new MockFile(QUEUE_DIR_URI, 'item-2.attachments.json'),
        new MockFile(QUEUE_DIR_URI, 'item-3.m4a'),
        new MockFile(QUEUE_DIR_URI, 'item-3.attachments.json'),
        new MockFile(QUEUE_DIR_URI, 'index.json'),
      ]);
      const ids = await storage.listPayloadIds();
      expect(ids.sort()).toEqual(['item-1', 'item-2', 'item-3']);
    });

    it('filters out .attachments.json.tmp files', async () => {
      getQueueDir().exists = true;
      const { File: MockFile } = jest.requireMock('expo-file-system');
      getQueueDir().list.mockReturnValue([
        new MockFile(QUEUE_DIR_URI, 'item-1.attachments.json'),
        new MockFile(QUEUE_DIR_URI, 'item-2.attachments.json.tmp'),
      ]);
      expect(await storage.listPayloadIds()).toEqual(['item-1']);
    });
  });

  // ---- saveJsonPayload ----

  describe('saveJsonPayload', () => {
    it('creates directory on first write', async () => {
      const payload = { prompt: 'Hello', attachments: [{ type: 'image' }] };
      await storage.saveJsonPayload('item-1', payload);
      expect(getQueueDir().create).toHaveBeenCalledWith({ intermediates: true, idempotent: true });
    });

    it('writes JSON atomically via tmp+rename', async () => {
      const payload = { prompt: 'Hello', attachments: [{ type: 'image' }] };
      await storage.saveJsonPayload('item-1', payload);

      const tmpFile = mockFileStore[`${QUEUE_DIR_URI}/item-1.attachments.json.tmp`];
      expect(tmpFile).toBeDefined();
      expect(tmpFile.create).toHaveBeenCalled();
      expect(tmpFile.write).toHaveBeenCalledWith(JSON.stringify(payload));
      expect(tmpFile.rename).toHaveBeenCalledWith('item-1.attachments.json');
    });
  });

  // ---- loadJsonPayload ----

  describe('loadJsonPayload', () => {
    it('returns parsed JSON when file exists', async () => {
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const payload = { prompt: 'test', attachments: [{ type: 'doc' }] };
      const jsonFile = new MockFile(QUEUE_DIR_URI, 'item-1.attachments.json');
      jsonFile.exists = true;
      jsonFile.text.mockResolvedValueOnce(JSON.stringify(payload));

      const result = await storage.loadJsonPayload('item-1');
      expect(result).toEqual(payload);
    });

    it('returns null when file does not exist', async () => {
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const jsonFile = new MockFile(QUEUE_DIR_URI, 'missing-id.attachments.json');
      jsonFile.exists = false;

      const result = await storage.loadJsonPayload('missing-id');
      expect(result).toBeNull();
    });

    it('returns null on corrupt JSON', async () => {
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const jsonFile = new MockFile(QUEUE_DIR_URI, 'corrupt-id.attachments.json');
      jsonFile.exists = true;
      jsonFile.text.mockResolvedValueOnce('not-valid-json{{{');

      const result = await storage.loadJsonPayload('corrupt-id');
      expect(result).toBeNull();
    });
  });

  // ---- loadJsonPayload .tmp recovery ----

  describe('loadJsonPayload tmp recovery', () => {
    it('recovers from .tmp file when primary is missing', async () => {
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const payload = { prompt: 'recovered', attachments: [] };

      const primaryFile = new MockFile(QUEUE_DIR_URI, 'recover-id.attachments.json');
      primaryFile.exists = false;

      const tmpFile = new MockFile(QUEUE_DIR_URI, 'recover-id.attachments.json.tmp');
      tmpFile.exists = true;
      tmpFile.rename.mockImplementation(() => {
        // After rename, the primary file should now exist
        const renamedFile = new MockFile(QUEUE_DIR_URI, 'recover-id.attachments.json');
        renamedFile.exists = true;
        renamedFile.text.mockResolvedValueOnce(JSON.stringify(payload));
      });

      const result = await storage.loadJsonPayload('recover-id');
      expect(tmpFile.rename).toHaveBeenCalledWith('recover-id.attachments.json');
      expect(result).toEqual(payload);
    });

    it('returns null when both primary and tmp are missing', async () => {
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const primaryFile = new MockFile(QUEUE_DIR_URI, 'missing-id.attachments.json');
      primaryFile.exists = false;
      const tmpFile = new MockFile(QUEUE_DIR_URI, 'missing-id.attachments.json.tmp');
      tmpFile.exists = false;

      const result = await storage.loadJsonPayload('missing-id');
      expect(result).toBeNull();
    });

    it('limits recovery recursion depth', async () => {
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const primaryFile = new MockFile(QUEUE_DIR_URI, 'loop-id.attachments.json');
      primaryFile.exists = false;
      const tmpFile = new MockFile(QUEUE_DIR_URI, 'loop-id.attachments.json.tmp');
      tmpFile.exists = true;
      tmpFile.rename.mockImplementation(() => { /* noop — primary never appears */ });

      const result = await storage.loadJsonPayload('loop-id');
      expect(result).toBeNull();
    });
  });

  // ---- deleteJsonPayload ----

  describe('deleteJsonPayload', () => {
    it('deletes the JSON payload file when it exists', async () => {
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const jsonFile = new MockFile(QUEUE_DIR_URI, 'item-1.attachments.json');
      jsonFile.exists = true;

      await storage.deleteJsonPayload('item-1');
      expect(jsonFile.delete).toHaveBeenCalled();
    });

    it('is a no-op when JSON payload does not exist', async () => {
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const jsonFile = new MockFile(QUEUE_DIR_URI, 'nonexistent.attachments.json');
      jsonFile.exists = false;

      await expect(storage.deleteJsonPayload('nonexistent')).resolves.toBeUndefined();
    });

    it('does not throw when delete fails', async () => {
      const { File: MockFile } = jest.requireMock('expo-file-system');
      const jsonFile = new MockFile(QUEUE_DIR_URI, 'item-1.attachments.json');
      jsonFile.exists = true;
      jsonFile.delete.mockImplementation(() => { throw new Error('Permission denied'); });

      await expect(storage.deleteJsonPayload('item-1')).resolves.toBeUndefined();
    });
  });

  // ---- deletePayload (combined cleanup) ----

  describe('deletePayload (combined)', () => {
    it('deletes both media and JSON payload files', async () => {
      getQueueDir().exists = true;
      const { File: MockFile } = jest.requireMock('expo-file-system');

      const mediaFile = new MockFile(QUEUE_DIR_URI, 'item-1.m4a');
      mediaFile.exists = true;
      getQueueDir().list.mockReturnValue([mediaFile]);

      const jsonFile = new MockFile(QUEUE_DIR_URI, 'item-1.attachments.json');
      jsonFile.exists = true;

      await storage.deletePayload('item-1');

      expect(mediaFile.delete).toHaveBeenCalled();
      expect(jsonFile.delete).toHaveBeenCalled();
    });
  });
});
