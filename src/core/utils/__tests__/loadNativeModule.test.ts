/**
 * Direct unit tests for `loadNativeModule.ts`.
 *
 * This helper sits on the critical path for 6 services (fileIndexService,
 * conversationIndexService, toolIndexService, indexHealthService,
 * localSttService, moonshineTranscriber) but until now only had transitive
 * coverage. The two-line packaged-vs-dev branch is exactly the kind of
 * one-character regression (typo'd path segment, swapped condition) that
 * transitive tests would miss because each consumer mocks at a different
 * layer. These tests pin the contract directly:
 *
 *   1. Dev branch calls `createRequire(import.meta.url)` — path does NOT
 *      include `app.asar.unpacked`.
 *   2. Packaged branch calls
 *      `createRequire(<resourcesPath>/app.asar.unpacked/node_modules/.package-lock.json)`.
 *   3. The cached native-require is reused across calls — `createRequire`
 *      runs exactly once regardless of how many specs are loaded.
 *
 * `vi.resetModules()` in `beforeEach` clears the helper's module-scope cache
 * so each test gets a fresh `cachedNativeRequire`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCreateRequire = vi.fn();
const mockIsPackaged = vi.fn();

vi.mock('node:module', () => ({
  createRequire: (specifier: string) => mockCreateRequire(specifier),
}));

vi.mock('@core/utils/dataPaths', () => ({
  isPackaged: () => mockIsPackaged(),
}));

describe('loadNativeModule', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    mockCreateRequire.mockReset();
    mockIsPackaged.mockReset();
    originalResourcesPath = process.resourcesPath;
  });

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
      writable: true,
    });
  });

  it('uses createRequire(import.meta.url) in dev mode (no asar.unpacked path)', async () => {
    mockIsPackaged.mockReturnValue(false);
    const fakeRequire = vi.fn((spec: string) => ({ module: spec }));
    mockCreateRequire.mockReturnValue(fakeRequire);

    const { loadNativeModule } = await import('../loadNativeModule');
    const result = loadNativeModule<{ module: string }>('@lancedb/lancedb');

    expect(mockCreateRequire).toHaveBeenCalledTimes(1);
    const createRequireArg = mockCreateRequire.mock.calls[0][0];
    expect(createRequireArg).not.toContain('app.asar.unpacked');
    expect(createRequireArg).toMatch(/loadNativeModule\.ts$/);
    expect(fakeRequire).toHaveBeenCalledWith('@lancedb/lancedb');
    expect(result).toEqual({ module: '@lancedb/lancedb' });
  });

  it('uses createRequire(<resourcesPath>/app.asar.unpacked/...) in packaged mode', async () => {
    mockIsPackaged.mockReturnValue(true);
    Object.defineProperty(process, 'resourcesPath', {
      value: '/fake/resources',
      configurable: true,
      writable: true,
    });

    const fakeRequire = vi.fn((spec: string) => ({ module: spec }));
    mockCreateRequire.mockReturnValue(fakeRequire);

    const { loadNativeModule } = await import('../loadNativeModule');
    const result = loadNativeModule<{ module: string }>('sherpa-onnx-node');

    expect(mockCreateRequire).toHaveBeenCalledTimes(1);
    const createRequireArg = mockCreateRequire.mock.calls[0][0];
    expect(createRequireArg).toBe(
      '/fake/resources/app.asar.unpacked/node_modules/.package-lock.json',
    );
    expect(fakeRequire).toHaveBeenCalledWith('sherpa-onnx-node');
    expect(result).toEqual({ module: 'sherpa-onnx-node' });
  });

  it('caches the native require across calls — createRequire runs exactly once', async () => {
    mockIsPackaged.mockReturnValue(false);
    const fakeRequire = vi.fn((spec: string) => ({ module: spec }));
    mockCreateRequire.mockReturnValue(fakeRequire);

    const { loadNativeModule } = await import('../loadNativeModule');
    loadNativeModule('@lancedb/lancedb');
    loadNativeModule('sherpa-onnx-node');
    loadNativeModule('onnxruntime-node');

    expect(mockCreateRequire).toHaveBeenCalledTimes(1);
    expect(fakeRequire).toHaveBeenCalledTimes(3);
    expect(fakeRequire.mock.calls.map((c) => c[0])).toEqual([
      '@lancedb/lancedb',
      'sherpa-onnx-node',
      'onnxruntime-node',
    ]);
  });

  it('reads isPackaged() only on first call (cache short-circuits later isPackaged reads)', async () => {
    mockIsPackaged.mockReturnValue(false);
    const fakeRequire = vi.fn((spec: string) => ({ module: spec }));
    mockCreateRequire.mockReturnValue(fakeRequire);

    const { loadNativeModule } = await import('../loadNativeModule');
    loadNativeModule('@lancedb/lancedb');
    loadNativeModule('@lancedb/lancedb');
    loadNativeModule('@lancedb/lancedb');

    expect(mockIsPackaged).toHaveBeenCalledTimes(1);
  });
});
