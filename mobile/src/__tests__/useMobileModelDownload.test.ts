/**
 * Tests for useMobileModelDownload hook — model download lifecycle,
 * manifest-based freshness checks, status transitions, and error handling.
 */

import { renderHook, act } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mocks — all out-of-scope variables MUST be prefixed with `mock`.
// ---------------------------------------------------------------------------

// Per-file state keyed by filename
const mockFileSystemState: Record<string, { exists: boolean; size: number; text: string }> = {};

const mockGetFileState = (name: string) =>
  mockFileSystemState[name] ?? { exists: true, size: 94_202_872, text: '' };

let mockModelDirExists = false;
let mockStagingDirExists = false;
const mockDirCreate = jest.fn();
const mockDirDelete = jest.fn();

jest.mock('expo-file-system', () => {
  const DirectoryMock = jest.fn().mockImplementation((_base: unknown, subpath: string) => {
    const isStaging = subpath.includes('.staging');
    return {
      uri: `/mock/documents/${subpath}`,
      get exists() { return isStaging ? mockStagingDirExists : mockModelDirExists; },
      create: mockDirCreate,
      delete: mockDirDelete,
    };
  });

  const FileMock = jest.fn().mockImplementation((_dir: unknown, name: string) => ({
    uri: `/mock/documents/models/${name}`,
    name,
    get exists() { return mockGetFileState(name).exists; },
    get size() { return mockGetFileState(name).size; },
    delete: jest.fn(),
    create: jest.fn(),
    write: jest.fn(),
    text: () => mockGetFileState(name).text,
    move: jest.fn(),
  }));

  return {
    Paths: {
      document: '/mock/documents',
      get availableDiskSpace() { return 2_000_000_000; },
    },
    Directory: DirectoryMock,
    File: FileMock,
  };
});

const mockDownloadAsync = jest.fn().mockResolvedValue({
  uri: '/mock/download/result',
  headers: { 'Content-Length': '94202872' },
});
jest.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: jest.fn((_url, _uri, _opts, _onProgress) => ({
    downloadAsync: mockDownloadAsync,
    pauseAsync: jest.fn(),
  })),
}));

const mockAsyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(mockAsyncStore[key] ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    mockAsyncStore[key] = value;
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    delete mockAsyncStore[key];
    return Promise.resolve();
  }),
}));

jest.mock('@react-native-community/netinfo', () => ({
  fetch: jest.fn().mockResolvedValue({ type: 'wifi' }),
}));

const mockFetchHeaders = { get: jest.fn(() => '94202872') };
global.fetch = jest.fn().mockResolvedValue({ headers: mockFetchHeaders }) as jest.Mock;

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  useMobileModelDownload,
  isMoonshineModelReady,
  getModelDirectoryPath,
} from '../hooks/useMobileModelDownload';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setFileState(name: string, state: { exists?: boolean; size?: number; text?: string }) {
  mockFileSystemState[name] = {
    exists: state.exists ?? true,
    size: state.size ?? 94_202_872,
    text: state.text ?? '',
  };
}

function resetAllState() {
  mockModelDirExists = false;
  mockStagingDirExists = false;
  Object.keys(mockFileSystemState).forEach(k => delete mockFileSystemState[k]);
  Object.keys(mockAsyncStore).forEach(k => delete mockAsyncStore[k]);
  mockDownloadAsync.mockResolvedValue({
    uri: '/mock/download/result',
    headers: { 'Content-Length': '94202872' },
  });
  (global.fetch as jest.Mock).mockResolvedValue({ headers: mockFetchHeaders });
  mockFetchHeaders.get.mockReturnValue('94202872');
  jest.clearAllMocks();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMobileModelDownload', () => {
  beforeEach(resetAllState);

  describe('initial status', () => {
    it('reports not-downloaded when model directory does not exist', async () => {
      mockModelDirExists = false;

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      expect(result.current.status).toBe('not-downloaded');
    });

    it('reports downloaded when all model files exist and are non-empty', async () => {
      mockModelDirExists = true;

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      expect(result.current.status).toBe('downloaded');
    });

    it('reports not-downloaded when a model file is missing', async () => {
      mockModelDirExists = true;
      setFileState('encoder.ort', { exists: false });

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      expect(result.current.status).toBe('not-downloaded');
    });

    it('reports not-downloaded when a model file has zero size', async () => {
      mockModelDirExists = true;
      setFileState('encoder.ort', { exists: true, size: 0 });

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      expect(result.current.status).toBe('not-downloaded');
    });
  });

  describe('freshness detection', () => {
    it('reports update-available when server Content-Length differs from manifest', async () => {
      mockModelDirExists = true;
      const manifest = {
        downloadedAt: '2026-04-07T00:00:00Z',
        files: { 'encoder.ort': 98_566_144 },
      };
      setFileState('manifest.json', { exists: true, text: JSON.stringify(manifest) });
      mockFetchHeaders.get.mockReturnValue('94202872');

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      expect(result.current.status).toBe('update-available');
    });

    it('stays downloaded when server Content-Length matches manifest', async () => {
      mockModelDirExists = true;
      const manifest = {
        downloadedAt: '2026-04-07T00:00:00Z',
        files: { 'encoder.ort': 94_202_872 },
      };
      setFileState('manifest.json', { exists: true, text: JSON.stringify(manifest) });
      mockFetchHeaders.get.mockReturnValue('94202872');

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      expect(result.current.status).toBe('downloaded');
    });

    it('skips freshness check when one was done recently', async () => {
      mockModelDirExists = true;
      mockAsyncStore['rebel:moonshine-last-freshness-check'] = String(Date.now());

      const manifest = {
        downloadedAt: '2026-04-07T00:00:00Z',
        files: { 'encoder.ort': 98_566_144 },
      };
      setFileState('manifest.json', { exists: true, text: JSON.stringify(manifest) });

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.current.status).toBe('downloaded');
    });

    it('gracefully handles network errors during freshness check', async () => {
      mockModelDirExists = true;
      const manifest = {
        downloadedAt: '2026-04-07T00:00:00Z',
        files: { 'encoder.ort': 94_202_872 },
      };
      setFileState('manifest.json', { exists: true, text: JSON.stringify(manifest) });
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      expect(result.current.status).toBe('downloaded');
    });
  });

  describe('download error messages', () => {
    it('surfaces network error as friendly message', async () => {
      mockModelDirExists = false;

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      mockDownloadAsync.mockRejectedValueOnce(new Error('ENETUNREACH'));

      await act(async () => {
        await result.current.startDownload();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.errorMessage).toContain('Network error');
    });

    it('surfaces disk space error as friendly message', async () => {
      mockModelDirExists = false;

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      mockDownloadAsync.mockRejectedValueOnce(new Error('ENOSPC'));

      await act(async () => {
        await result.current.startDownload();
      });

      expect(result.current.status).toBe('error');
      expect(result.current.errorMessage).toContain('storage space');
    });
  });

  describe('cancelDownload', () => {
    it('resets all state on cancel', async () => {
      mockModelDirExists = false;

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      act(() => {
        result.current.cancelDownload();
      });

      expect(result.current.status).toBe('not-downloaded');
      expect(result.current.progress).toBe(0);
      expect(result.current.downloadedBytes).toBe(0);
      expect(result.current.errorMessage).toBeNull();
    });
  });

  describe('removeModel', () => {
    it('deletes model directory and resets status', async () => {
      mockModelDirExists = true;
      setFileState('manifest.json', { exists: false, text: '' });

      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      await act(async () => {
        await result.current.removeModel();
      });

      expect(result.current.status).toBe('not-downloaded');
      expect(result.current.progress).toBe(0);
      expect(mockDirDelete).toHaveBeenCalled();
    });
  });

  describe('static metadata', () => {
    it('exposes modelName, totalSizeDisplay, and totalBytes', async () => {
      const { result } = renderHook(() => useMobileModelDownload());
      await act(async () => {});

      expect(result.current.modelName).toBe('Moonshine Medium');
      expect(result.current.totalSizeDisplay).toBe('~410 MB');
      expect(result.current.totalBytes).toBeGreaterThan(0);
    });
  });
});

describe('isMoonshineModelReady', () => {
  beforeEach(resetAllState);

  it('returns false when model directory does not exist', async () => {
    mockModelDirExists = false;
    expect(await isMoonshineModelReady()).toBe(false);
  });

  it('returns true when all files exist and are non-empty', async () => {
    mockModelDirExists = true;
    expect(await isMoonshineModelReady()).toBe(true);
  });

  it('returns false when a file has zero size', async () => {
    mockModelDirExists = true;
    setFileState('encoder.ort', { exists: true, size: 0 });
    expect(await isMoonshineModelReady()).toBe(false);
  });
});

describe('getModelDirectoryPath', () => {
  it('returns a URI containing the model directory name', () => {
    const path = getModelDirectoryPath();
    expect(path).toContain('moonshine-medium-streaming-en-v1');
  });
});
