/**
 * Integration tests for indexHealthService.
 *
 * Tests corruption detection and recovery for:
 * - ONNX model cache (missing, truncated, valid)
 * - LanceDB indices (connection failures)
 * - Sentry reporting (warning level on recovery)
 * - Disabled feature handling (skip file index when indexingEnabled === false)
 *
 * Uses temp directories for test isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setPlatformConfig } from '@core/platform';

// Create deterministic temp directory for tests
const testTempDir = path.join(os.tmpdir(), 'mindstone-index-health-test');

// Track mocked modules for cleanup
const mockCaptureMainMessage = vi.fn();

// Mock electron app before importing the module
vi.mock('electron', () => {
  const tempPath = require('node:path').join(require('node:os').tmpdir(), 'mindstone-index-health-test');
  return {
    app: {
      getPath: vi.fn().mockReturnValue(tempPath),
      isPackaged: false,
    },
  };
});

// Mock error reporter to verify reporting behavior
vi.mock('@core/errorReporter', () => ({
  setErrorReporter: vi.fn(),
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: (...args: unknown[]) => mockCaptureMainMessage(...args),
    addBreadcrumb: vi.fn(),
  }),
}));

// Mock LanceDB - we'll control its behavior in tests
const mockLanceDBClose = vi.fn().mockResolvedValue(undefined);
const mockLanceDBQueryToArray = vi.fn().mockResolvedValue([]);
const mockLanceDBQueryLimit = vi.fn().mockReturnValue({ toArray: mockLanceDBQueryToArray });
const mockLanceDBTableQuery = vi.fn().mockReturnValue({ limit: mockLanceDBQueryLimit });
const mockLanceDBOpenTable = vi.fn().mockResolvedValue({ query: mockLanceDBTableQuery });
const mockLanceDBTableNames = vi.fn().mockResolvedValue([]);
const mockLanceDBConnect = vi.fn().mockResolvedValue({
  tableNames: mockLanceDBTableNames,
  openTable: mockLanceDBOpenTable,
  close: mockLanceDBClose,
});

// Track if LanceDB should throw on require (Stage 1) or connect (Stage 2)
let lanceDBRequireShouldFail = false; // Stage 1: native module loading
let lanceDBConnectShouldFail = false; // Stage 2: database connection
let lanceDBConnectError: Error | null = null;

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: vi.fn().mockImplementation(() => {
      return (modulePath: string) => {
        if (modulePath === '@lancedb/lancedb') {
          // Stage 1: Native module loading - throw here if lanceDBRequireShouldFail
          if (lanceDBRequireShouldFail) {
            throw lanceDBConnectError || new Error("Cannot find module '@lancedb/lancedb-darwin-x64'");
          }
          return {
            connect: async (dbPath: string) => {
              // Stage 2: Database connection
              if (lanceDBConnectShouldFail) {
                throw lanceDBConnectError || new Error('LanceDB connection failed');
              }
              return mockLanceDBConnect(dbPath);
            },
          };
        }
        // Fall through to actual require for other modules
        return require(modulePath);
      };
    }),
  };
});

// Import after mocks are set up
import { validateAndRecoverIndices } from '../indexHealthService';

describe('indexHealthService', () => {
  beforeEach(async () => {
    // Set PlatformConfig to use test temp directory (matches the electron mock)
    setPlatformConfig({
      userDataPath: testTempDir,
      appPath: '/tmp/test-app',
      tempPath: os.tmpdir(),
      logsPath: path.join(testTempDir, 'logs'),
      homePath: os.homedir(),
      documentsPath: '/tmp/test-documents',
      desktopPath: '/tmp/test-desktop',
      appDataPath: '/tmp/test-appData',
      version: '0.0.0-test',
      isPackaged: false,
      platform: process.platform,
      totalMemoryBytes: 36 * 1024 * 1024 * 1024,
      arch: process.arch,
      surface: 'desktop',
      isOss: false,
    });

    // Clean up test temp directory before each test
    try {
      await fsp.rm(testTempDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }

    // Create fresh temp directory
    await fsp.mkdir(testTempDir, { recursive: true });

    // Reset mocks
    vi.clearAllMocks();
    mockCaptureMainMessage.mockClear();
    mockLanceDBConnect.mockClear();
    mockLanceDBTableNames.mockReset().mockResolvedValue([]);
    mockLanceDBOpenTable.mockReset().mockResolvedValue({ query: mockLanceDBTableQuery });
    mockLanceDBQueryToArray.mockReset().mockResolvedValue([]);

    // Reset LanceDB failure state
    lanceDBRequireShouldFail = false;
    lanceDBConnectShouldFail = false;
    lanceDBConnectError = null;
  });

  afterEach(async () => {
    // Ensure temp directory is clean between tests
    try {
      await fsp.rm(testTempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  afterAll(async () => {
    // Final cleanup
    try {
      await fsp.rm(testTempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('validateAndRecoverIndices', () => {
    describe('ONNX model corruption detection', () => {
      const modelDir = 'models/transformers';
      const modelSubPath = 'Xenova/bge-small-en-v1.5/onnx/model.onnx';

      // Expected file size constants matching the service
      const ONNX_EXPECTED_FILE_SIZE = 133_000_000; // ~127MB
      const _ONNX_MIN_FILE_SIZE = Math.floor(ONNX_EXPECTED_FILE_SIZE * 0.9); // ~114MB

      it('recovers when model file is missing (ENOENT case passes - no recovery needed)', async () => {
        // When model file doesn't exist, it's not considered corrupt
        // (it will be downloaded on first use)
        const result = await validateAndRecoverIndices();

        expect(result.recovered).toBe(false);
        expect(result.items).toHaveLength(0);
        expect(mockCaptureMainMessage).not.toHaveBeenCalled();
      });

      it('recovers when model file is truncated (size < 114MB)', async () => {
        // Create model directory structure with small file
        const modelPath = path.join(testTempDir, modelDir, modelSubPath);
        await fsp.mkdir(path.dirname(modelPath), { recursive: true });
        await fsp.writeFile(modelPath, 'tiny'); // Only 4 bytes

        // Mock fs.stat to simulate a small file
        const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (filePath) => {
          if (filePath.toString().includes('model.onnx')) {
            return {
              isFile: () => true,
              size: 4, // Truncated file
            } as fs.Stats;
          }
          // Fall through to actual stat for other files
          return fsp.stat(filePath);
        });

        const result = await validateAndRecoverIndices();

        expect(result.recovered).toBe(true);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].type).toBe('onnx-model');
        expect(result.items[0].error).toContain('too small');
        expect(result.items[0].error).toContain('4 B'); // formatBytes output
        expect(result.items[0].error).toContain('9.5 MB'); // formatBytes(ONNX_MIN_FILE_SIZE)

        // Sentry should be called with warning level for corruption
        expect(mockCaptureMainMessage).toHaveBeenCalledWith(
          'Index health: corruption auto-recovered',
          expect.objectContaining({
            level: 'warning',
            tags: expect.objectContaining({
              error_category: 'data_corruption',
            }),
            extra: expect.objectContaining({
              corruptionType: 'onnx-model',
              errorMessage: expect.stringContaining('too small'),
              recovered: true,
            }),
          })
        );

        // Model directory should be deleted
        const modelDirPath = path.join(testTempDir, modelDir);
        expect(fs.existsSync(modelDirPath)).toBe(false);

        statSpy.mockRestore();
      });

      it('recovers when model file is partially downloaded (~1MB)', async () => {
        // Simulate a partially downloaded file (1MB out of ~127MB)
        const modelPath = path.join(testTempDir, modelDir, modelSubPath);
        await fsp.mkdir(path.dirname(modelPath), { recursive: true });
        await fsp.writeFile(modelPath, 'partial'); // Placeholder file

        const partialSize = 1_000_000; // 1MB
        const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (filePath) => {
          if (filePath.toString().includes('model.onnx')) {
            return {
              isFile: () => true,
              size: partialSize,
            } as fs.Stats;
          }
          return fsp.stat(filePath);
        });

        const result = await validateAndRecoverIndices();

        expect(result.recovered).toBe(true);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].type).toBe('onnx-model');
        expect(result.items[0].error).toContain('too small');
        expect(result.items[0].error).toContain('976.6 KB'); // formatBytes(1_000_000) - 1MB is 976.6KB in binary

        statSpy.mockRestore();
      });

      it('recovers when model file is OneDrive placeholder (~10KB)', async () => {
        // Simulate an OneDrive placeholder file (small stub with metadata)
        const modelPath = path.join(testTempDir, modelDir, modelSubPath);
        await fsp.mkdir(path.dirname(modelPath), { recursive: true });
        await fsp.writeFile(modelPath, 'onedrive-placeholder');

        const placeholderSize = 10_000; // 10KB
        const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (filePath) => {
          if (filePath.toString().includes('model.onnx')) {
            return {
              isFile: () => true,
              size: placeholderSize,
            } as fs.Stats;
          }
          return fsp.stat(filePath);
        });

        const result = await validateAndRecoverIndices();

        expect(result.recovered).toBe(true);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].type).toBe('onnx-model');
        expect(result.items[0].error).toContain('too small');
        expect(result.items[0].error).toContain('9.8 KB'); // formatBytes(10_000)

        statSpy.mockRestore();
      });

      it('passes when model file is valid (size >= 114MB)', async () => {
        // Create model directory structure with file
        const modelPath = path.join(testTempDir, modelDir, modelSubPath);
        await fsp.mkdir(path.dirname(modelPath), { recursive: true });
        await fsp.writeFile(modelPath, 'placeholder'); // We'll mock the size

        // Mock fs.stat to return a valid large file size
        const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (filePath) => {
          if (filePath.toString().includes('model.onnx')) {
            return {
              isFile: () => true,
              size: ONNX_EXPECTED_FILE_SIZE, // ~127MB - valid size
            } as fs.Stats;
          }
          return fsp.stat(filePath);
        });

        const result = await validateAndRecoverIndices();

        expect(result.recovered).toBe(false);
        expect(result.items).toHaveLength(0);
        expect(mockCaptureMainMessage).not.toHaveBeenCalled();

        statSpy.mockRestore();
      });
    });

    describe('LanceDB corruption detection', () => {
      const conversationIndexDir = 'indices/global/conversations/lancedb';
      const toolIndexDir = 'indices/tools/lancedb';

      it('recovers when LanceDB connection fails', async () => {
        // Create the conversation index directory
        const indexDir = path.join(testTempDir, conversationIndexDir);
        await fsp.mkdir(indexDir, { recursive: true });

        // Configure LanceDB to fail on connect
        lanceDBConnectShouldFail = true;
        lanceDBConnectError = new Error('Database file corrupted');

        const result = await validateAndRecoverIndices();

        // Should recover the conversation index
        expect(result.recovered).toBe(true);
        expect(result.items.some(item => item.type === 'lancedb-conversation')).toBe(true);

        // Sentry should be called - but this is now classified based on error type
        // "Database file corrupted" contains "corrupt" so it's classified as data_corruption
        expect(mockCaptureMainMessage).toHaveBeenCalledWith(
          'Index health: corruption auto-recovered',
          expect.objectContaining({
            level: 'warning',
            tags: expect.objectContaining({
              error_category: 'data_corruption',
            }),
            extra: expect.objectContaining({
              corruptionType: 'lancedb-conversation',
              errorMessage: expect.stringContaining('corrupted'),
              recovered: true,
            }),
          })
        );

        // Directory should be deleted (because it's data_corruption)
        expect(fs.existsSync(indexDir)).toBe(false);
      });

      it('validates tables with query when connection succeeds', async () => {
        // Create the conversation index directory
        const indexDir = path.join(testTempDir, conversationIndexDir);
        await fsp.mkdir(indexDir, { recursive: true });

        // Configure LanceDB to succeed and return the expected table
        lanceDBConnectShouldFail = false;
        mockLanceDBTableNames.mockResolvedValue(['conversation_embeddings']);

        const result = await validateAndRecoverIndices();

        // Should not recover (index is healthy)
        expect(result.recovered).toBe(false);

        // Should have tried to open and query the table
        expect(mockLanceDBOpenTable).toHaveBeenCalledWith('conversation_embeddings');
        expect(mockLanceDBQueryLimit).toHaveBeenCalledWith(1);
        expect(mockLanceDBQueryToArray).toHaveBeenCalled();
      });

      it('recovers when table query fails with corruption error', async () => {
        // Create the conversation index directory
        const indexDir = path.join(testTempDir, conversationIndexDir);
        await fsp.mkdir(indexDir, { recursive: true });

        // Configure LanceDB to succeed on connect but fail on query with a corruption error
        lanceDBConnectShouldFail = false;
        mockLanceDBTableNames.mockResolvedValue(['conversation_embeddings']);
        mockLanceDBQueryToArray.mockRejectedValue(new Error('IO error: invalid footer'));

        const result = await validateAndRecoverIndices();

        // Should recover due to corruption-indicating error
        expect(result.recovered).toBe(true);
        expect(result.items.some(item => item.type === 'lancedb-conversation')).toBe(true);

        // Sentry should be called with corruption category
        expect(mockCaptureMainMessage).toHaveBeenCalledWith(
          'Index health: corruption auto-recovered',
          expect.objectContaining({
            tags: expect.objectContaining({
              error_category: 'data_corruption',
            }),
          })
        );
      });

      it('does NOT delete index when query fails with unknown error', async () => {
        // Create the conversation index directory
        const indexDir = path.join(testTempDir, conversationIndexDir);
        await fsp.mkdir(indexDir, { recursive: true });

        // Configure LanceDB to succeed on connect but fail with a non-corruption error
        lanceDBConnectShouldFail = false;
        mockLanceDBTableNames.mockResolvedValue(['conversation_embeddings']);
        mockLanceDBQueryToArray.mockRejectedValue(new Error('Query execution failed'));

        const result = await validateAndRecoverIndices();

        // Should NOT recover - unknown error doesn't trigger deletion (conservative)
        expect(result.recovered).toBe(false);

        // Directory should still exist
        expect(fs.existsSync(indexDir)).toBe(true);

        // Sentry should be called with unknown category
        expect(mockCaptureMainMessage).toHaveBeenCalledWith(
          'Index health: validation failed',
          expect.objectContaining({
            level: 'error',
            tags: expect.objectContaining({
              error_category: 'unknown',
            }),
          })
        );
      });

      it('skips validation when index directory does not exist', async () => {
        // Don't create any index directories
        lanceDBConnectShouldFail = false;

        const result = await validateAndRecoverIndices();

        // Should pass (no recovery needed for non-existent indices)
        expect(result.recovered).toBe(false);
        expect(result.items).toHaveLength(0);

        // LanceDB connect should not be called for non-existent directories
        expect(mockLanceDBConnect).not.toHaveBeenCalled();
      });

      it('does NOT delete index when native module require fails (Stage 1 - REBEL-JK fix)', async () => {
        // This tests the structural separation: require() itself throws, not connect()
        const indexDir = path.join(testTempDir, 'indices/global/conversations/lancedb');
        await fsp.mkdir(indexDir, { recursive: true });

        // Configure require('@lancedb/lancedb') to fail (Stage 1)
        lanceDBRequireShouldFail = true;
        lanceDBConnectError = Object.assign(
          new Error("Cannot find module '@lancedb/lancedb-darwin-x64'"),
          { code: 'MODULE_NOT_FOUND' }
        );

        const result = await validateAndRecoverIndices();

        // Should NOT recover (don't delete for module errors)
        expect(result.recovered).toBe(false);
        expect(fs.existsSync(indexDir)).toBe(true);

        // Sentry should report native_module_missing
        expect(mockCaptureMainMessage).toHaveBeenCalledWith(
          'Index health: native module unavailable',
          expect.objectContaining({
            level: 'error',
            tags: expect.objectContaining({
              error_category: 'native_module_missing',
            }),
          })
        );
      });

      it('does NOT delete index when native module is missing (REBEL-JK fix)', async () => {
        // Create the conversation index directory
        const indexDir = path.join(testTempDir, 'indices/global/conversations/lancedb');
        await fsp.mkdir(indexDir, { recursive: true });

        // Configure LanceDB to fail with a native module error
        lanceDBConnectShouldFail = true;
        lanceDBConnectError = Object.assign(
          new Error("Cannot find module '@lancedb/lancedb-darwin-x64'"),
          { code: 'MODULE_NOT_FOUND' }
        );

        const result = await validateAndRecoverIndices();

        // Should NOT recover (we don't delete for module errors)
        expect(result.recovered).toBe(false);
        expect(result.items).toHaveLength(0);

        // Sentry SHOULD still be called - but with error level and native_module_missing category
        expect(mockCaptureMainMessage).toHaveBeenCalledWith(
          'Index health: native module unavailable',
          expect.objectContaining({
            level: 'error',
            tags: expect.objectContaining({
              error_category: 'native_module_missing',
            }),
            extra: expect.objectContaining({
              recovered: false,
            }),
          })
        );

        // Directory should NOT be deleted (this is the key fix for REBEL-JK)
        expect(fs.existsSync(indexDir)).toBe(true);
      });

      it('does NOT delete index for Windows DLL load failure', async () => {
        const indexDir = path.join(testTempDir, 'indices/global/conversations/lancedb');
        await fsp.mkdir(indexDir, { recursive: true });

        lanceDBConnectShouldFail = true;
        lanceDBConnectError = new Error('The specified module could not be found.\\lancedb.win32-x64-msvc.node');

        const result = await validateAndRecoverIndices();

        expect(result.recovered).toBe(false);
        expect(fs.existsSync(indexDir)).toBe(true);
        expect(mockCaptureMainMessage).toHaveBeenCalledWith(
          'Index health: native module unavailable',
          expect.objectContaining({
            tags: expect.objectContaining({
              error_category: 'native_module_missing',
            }),
          })
        );
      });

      it('validates tool index separately from conversation index', async () => {
        // Create only tool index directory
        const indexDir = path.join(testTempDir, toolIndexDir);
        await fsp.mkdir(indexDir, { recursive: true });

        // Configure LanceDB to fail
        lanceDBConnectShouldFail = true;
        lanceDBConnectError = new Error('Tool index corrupted');

        const result = await validateAndRecoverIndices();

        // Should recover the tool index
        expect(result.recovered).toBe(true);
        expect(result.items.some(item => item.type === 'lancedb-tool')).toBe(true);

        // Directory should be deleted
        expect(fs.existsSync(indexDir)).toBe(false);
      });
    });

    describe('Sentry reporting', () => {
      // Valid file size for tests that need healthy model
      const ONNX_EXPECTED_FILE_SIZE = 133_000_000;

      it('reports with warning level when data corruption recovery happens', async () => {
        // Create truncated model to trigger recovery
        const modelPath = path.join(testTempDir, 'models/transformers/Xenova/bge-small-en-v1.5/onnx/model.onnx');
        await fsp.mkdir(path.dirname(modelPath), { recursive: true });
        await fsp.writeFile(modelPath, 'x'); // 1 byte - truncated

        // Mock fs.stat to return small size
        const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (filePath) => {
          if (filePath.toString().includes('model.onnx')) {
            return { isFile: () => true, size: 1 } as fs.Stats;
          }
          return fsp.stat(filePath);
        });

        await validateAndRecoverIndices();

        expect(mockCaptureMainMessage).toHaveBeenCalledTimes(1);
        expect(mockCaptureMainMessage).toHaveBeenCalledWith(
          'Index health: corruption auto-recovered',
          expect.objectContaining({
            level: 'warning',
            tags: expect.objectContaining({
              error_category: 'data_corruption',
            }),
          })
        );

        statSpy.mockRestore();
      });

      it('does NOT call Sentry when everything is healthy', async () => {
        // Create valid model file
        const modelPath = path.join(testTempDir, 'models/transformers/Xenova/bge-small-en-v1.5/onnx/model.onnx');
        await fsp.mkdir(path.dirname(modelPath), { recursive: true });
        await fsp.writeFile(modelPath, 'placeholder');

        // Mock fs.stat to return valid large size
        const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (filePath) => {
          if (filePath.toString().includes('model.onnx')) {
            return { isFile: () => true, size: ONNX_EXPECTED_FILE_SIZE } as fs.Stats;
          }
          return fsp.stat(filePath);
        });

        // Create healthy LanceDB index
        const conversationDir = path.join(testTempDir, 'indices/global/conversations/lancedb');
        await fsp.mkdir(conversationDir, { recursive: true });
        lanceDBConnectShouldFail = false;
        mockLanceDBTableNames.mockResolvedValue(['conversation_embeddings']);

        const result = await validateAndRecoverIndices();

        expect(result.recovered).toBe(false);
        expect(mockCaptureMainMessage).not.toHaveBeenCalled();

        statSpy.mockRestore();
      });

      it('reports each recovered item separately', async () => {
        // Create both truncated model and corrupted conversation index
        const modelPath = path.join(testTempDir, 'models/transformers/Xenova/bge-small-en-v1.5/onnx/model.onnx');
        await fsp.mkdir(path.dirname(modelPath), { recursive: true });
        await fsp.writeFile(modelPath, 'x'); // Truncated

        // Mock fs.stat to return small size
        const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (filePath) => {
          if (filePath.toString().includes('model.onnx')) {
            return { isFile: () => true, size: 1 } as fs.Stats;
          }
          return fsp.stat(filePath);
        });

        const conversationDir = path.join(testTempDir, 'indices/global/conversations/lancedb');
        await fsp.mkdir(conversationDir, { recursive: true });
        lanceDBConnectShouldFail = true;
        lanceDBConnectError = new Error('Database corrupted');

        const result = await validateAndRecoverIndices();

        expect(result.recovered).toBe(true);
        expect(result.items.length).toBeGreaterThanOrEqual(2);
        // One call per recovered item
        expect(mockCaptureMainMessage).toHaveBeenCalledTimes(result.items.length);

        statSpy.mockRestore();
      });

      it('includes relative path in Sentry extra (no full user path exposure)', async () => {
        // Create truncated model
        const modelPath = path.join(testTempDir, 'models/transformers/Xenova/bge-small-en-v1.5/onnx/model.onnx');
        await fsp.mkdir(path.dirname(modelPath), { recursive: true });
        await fsp.writeFile(modelPath, 'tiny');

        // Mock fs.stat to return small size
        const statSpy = vi.spyOn(fsp, 'stat').mockImplementation(async (filePath) => {
          if (filePath.toString().includes('model.onnx')) {
            return { isFile: () => true, size: 4 } as fs.Stats;
          }
          return fsp.stat(filePath);
        });

        await validateAndRecoverIndices();

        expect(mockCaptureMainMessage).toHaveBeenCalledWith(
          'Index health: corruption auto-recovered',
          expect.objectContaining({
            extra: expect.objectContaining({
              relativePath: expect.stringContaining('models/transformers'),
            }),
          })
        );

        // Should NOT contain the full temp directory path
        const call = mockCaptureMainMessage.mock.calls[0];
        const relativePath = call[1]?.extra?.relativePath as string;
        expect(relativePath).not.toContain(os.tmpdir());

        statSpy.mockRestore();
      });
    });

    describe('disabled feature handling', () => {
      it('skips file index check when settings.indexingEnabled === false', async () => {
        // Create file index directory (would normally be checked)
        // Note: file index path uses workspace hash, but we can still test the skip behavior
        const someWorkspaceHash = 'a1b2c3d4e5f67890';
        const fileIndexDir = path.join(testTempDir, 'indices', someWorkspaceHash, 'lancedb');
        await fsp.mkdir(fileIndexDir, { recursive: true });

        // Configure LanceDB to fail (to detect if it's called)
        lanceDBConnectShouldFail = true;
        lanceDBConnectError = new Error('Should not be called');

        // Call with indexing disabled
        const result = await validateAndRecoverIndices({
          indexingEnabled: false,
          coreDirectory: '/some/workspace/path',
        } as Parameters<typeof validateAndRecoverIndices>[0]);

        // Should not have recovered the file index
        expect(result.items.some(item => item.type === 'lancedb-file')).toBe(false);
      });

      it('skips file index check when coreDirectory is not configured', async () => {
        // Call without coreDirectory
        const result = await validateAndRecoverIndices({
          indexingEnabled: true,
          // coreDirectory not set
        } as Parameters<typeof validateAndRecoverIndices>[0]);

        // Should not have any file index recovery
        expect(result.items.some(item => item.type === 'lancedb-file')).toBe(false);
      });

      it('checks file index when indexing is enabled and workspace is configured', async () => {
        // Use a specific core directory to get a predictable hash
        const coreDirectory = '/test/workspace';
        // The hash is sha256(coreDirectory).slice(0, 16)
        const crypto = await import('node:crypto');
        const workspaceHash = crypto.createHash('sha256').update(coreDirectory).digest('hex').slice(0, 16);
        const fileIndexDir = path.join(testTempDir, 'indices', workspaceHash, 'lancedb');
        await fsp.mkdir(fileIndexDir, { recursive: true });

        // Configure LanceDB to fail to trigger recovery
        lanceDBConnectShouldFail = true;
        lanceDBConnectError = new Error('File index corrupted');

        const result = await validateAndRecoverIndices({
          indexingEnabled: true,
          coreDirectory: coreDirectory,
        } as Parameters<typeof validateAndRecoverIndices>[0]);

        // Should have recovered the file index
        expect(result.recovered).toBe(true);
        expect(result.items.some(item => item.type === 'lancedb-file')).toBe(true);
      });

      it('clears file index metadata when recovering corrupted file index', async () => {
        // Use a specific core directory to get a predictable hash
        const coreDirectory = '/test/workspace';
        const crypto = await import('node:crypto');
        const workspaceHash = crypto.createHash('sha256').update(coreDirectory).digest('hex').slice(0, 16);
        const fileIndexDir = path.join(testTempDir, 'indices', workspaceHash, 'lancedb');
        const metadataPath = path.join(testTempDir, 'indices', workspaceHash, 'index_metadata.json');
        
        await fsp.mkdir(fileIndexDir, { recursive: true });
        
        // Create metadata file with scanCompletedAt set (simulates previous successful scan)
        const metadata = {
          scanCompletedAt: Date.now() - 1000,
          totalFilesAtCompletion: 100,
          embeddingModel: 'Xenova/bge-small-en-v1.5',
        };
        await fsp.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

        // Configure LanceDB to fail to trigger recovery
        lanceDBConnectShouldFail = true;
        lanceDBConnectError = new Error('File index corrupted');

        await validateAndRecoverIndices({
          indexingEnabled: true,
          coreDirectory: coreDirectory,
        } as Parameters<typeof validateAndRecoverIndices>[0]);

        // Check that metadata was cleared
        const updatedMetadata = JSON.parse(await fsp.readFile(metadataPath, 'utf-8'));
        expect(updatedMetadata.scanCompletedAt).toBeNull();
        expect(updatedMetadata.totalFilesAtCompletion).toBeNull();
        // embeddingModel should be preserved
        expect(updatedMetadata.embeddingModel).toBe('Xenova/bge-small-en-v1.5');
      });
    });

    describe('return value structure', () => {
      it('returns correct structure when no recovery needed', async () => {
        // Ensure clean state - no directories exist
        lanceDBConnectShouldFail = false;
        
        const result = await validateAndRecoverIndices();

        expect(result).toHaveProperty('recovered');
        expect(result).toHaveProperty('items');
        expect(result.recovered).toBe(false);
        expect(Array.isArray(result.items)).toBe(true);
        expect(result.items).toHaveLength(0);
        // Sentry should not be called when everything is healthy
        expect(mockCaptureMainMessage).not.toHaveBeenCalled();
      });

      it('returns correct structure when recovery happens', async () => {
        // Create truncated model
        const modelPath = path.join(testTempDir, 'models/transformers/Xenova/bge-small-en-v1.5/onnx/model.onnx');
        await fsp.mkdir(path.dirname(modelPath), { recursive: true });
        await fsp.writeFile(modelPath, 'x');

        const result = await validateAndRecoverIndices();

        expect(result.recovered).toBe(true);
        expect(result.items.length).toBeGreaterThan(0);
        expect(result.items[0]).toHaveProperty('type');
        expect(result.items[0]).toHaveProperty('path');
        expect(result.items[0]).toHaveProperty('error');
      });
    });

    describe('graceful handling of edge cases', () => {
      it('handles missing settings parameter', async () => {
        // Should not throw when settings is undefined
        const result = await validateAndRecoverIndices();
        expect(result).toHaveProperty('recovered');
        expect(result).toHaveProperty('items');
      });

      it('handles partial settings object', async () => {
        // Should not throw when settings is partial
        const result = await validateAndRecoverIndices({} as Parameters<typeof validateAndRecoverIndices>[0]);
        expect(result).toHaveProperty('recovered');
      });
    });
  });
});
