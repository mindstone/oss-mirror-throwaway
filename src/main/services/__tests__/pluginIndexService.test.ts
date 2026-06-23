import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const mockAccess = vi.fn();
const mockIndexFile = vi.fn();
const mockRemoveVectorIndexEntry = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: {
    access: (...args: unknown[]) => mockAccess(...args),
  },
}));

vi.mock('../fileIndexService', () => ({
  indexFile: (...args: unknown[]) => mockIndexFile(...args),
}));

// deindexPluginReadme routes through the Removal Coordinator (the only door for
// cloud-relevant LanceDB removals) rather than calling removeFileFromIndex directly.
vi.mock('../indexRemovalCoordinator', () => ({
  removeVectorIndexEntry: (...args: unknown[]) => mockRemoveVectorIndexEntry(...args),
}));

const { indexPluginReadme, deindexPluginReadme } = await import('../pluginIndexService');

describe('pluginIndexService', () => {
  beforeEach(() => {
    mockAccess.mockReset();
    mockIndexFile.mockReset();
    mockRemoveVectorIndexEntry.mockReset();
  });

  it('indexes plugin README when present', async () => {
    mockAccess.mockResolvedValue(undefined);
    mockIndexFile.mockResolvedValue(3);

    const pluginDir = '/workspace/MySpace/plugins/meeting-prep';
    const workspacePath = '/workspace';

    await indexPluginReadme(pluginDir, workspacePath);

    expect(mockIndexFile).toHaveBeenCalledTimes(1);
    expect(mockIndexFile).toHaveBeenCalledWith(
      path.join(pluginDir, 'README.md'),
      workspacePath,
    );
  });

  it('skips indexing when README is missing', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await indexPluginReadme('/workspace/MySpace/plugins/meeting-prep', '/workspace');

    expect(mockIndexFile).not.toHaveBeenCalled();
  });

  it('deindexes plugin README through the coordinator as a vector-only hygiene removal', async () => {
    const pluginDir = '/workspace/MySpace/plugins/meeting-prep';

    await deindexPluginReadme(pluginDir);

    expect(mockRemoveVectorIndexEntry).toHaveBeenCalledTimes(1);
    expect(mockRemoveVectorIndexEntry).toHaveBeenCalledWith(
      path.join(pluginDir, 'README.md'),
      { kind: 'hygiene' },
    );
  });
});
