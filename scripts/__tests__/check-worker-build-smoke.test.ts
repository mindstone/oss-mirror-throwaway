import { describe, expect, it, vi } from 'vitest';

import {
  findWorkerBuildTrigger,
  isWorkerBuildRelevantFile,
  runWorkerBuildSmoke,
  type ChangedFilesResult,
} from '../check-worker-build-smoke';

function known(files: readonly string[]): ChangedFilesResult {
  return { status: 'known', files, source: 'test diff' };
}

function unknown(reason = 'test could not resolve base'): ChangedFilesResult {
  return { status: 'unknown', reason };
}

describe('check-worker-build-smoke', () => {
  it('classifies worker and startup inputs as relevant', () => {
    expect(isWorkerBuildRelevantFile('src/main/workers/embeddingWorker.ts')).toBe(true);
    expect(isWorkerBuildRelevantFile('src/main/gpu-worker/preload.ts')).toBe(true);
    expect(isWorkerBuildRelevantFile('src/main/startup/registerHandlers.ts')).toBe(true);
    expect(isWorkerBuildRelevantFile('src/core/startup/bootstrap.ts')).toBe(true);
    expect(isWorkerBuildRelevantFile('scripts/build-worker.mjs')).toBe(true);
    expect(isWorkerBuildRelevantFile('tsconfig.node.json')).toBe(true);
    expect(isWorkerBuildRelevantFile('src/renderer/App.tsx')).toBe(false);
  });

  it('triggers the real worker build path when a worker-entry path changed', () => {
    const log = vi.fn();
    const error = vi.fn();
    const runWorkerBuild = vi.fn(() => ({ exitCode: 0, signal: null }));

    const code = runWorkerBuildSmoke({
      env: {},
      detectChangedFiles: () => known(['src/main/workers/embeddingWorker.ts']),
      runWorkerBuild,
      log,
      error,
    });

    expect(code).toBe(0);
    expect(runWorkerBuild).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      '[worker-build-smoke] running: src/main/workers/embeddingWorker.ts changed',
    );
    expect(log).toHaveBeenCalledWith(
      '[worker-build-smoke] pass: scripts/build-worker.mjs completed successfully',
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('skips quickly and logs why when no relevant files changed', () => {
    const log = vi.fn();
    const runWorkerBuild = vi.fn(() => ({ exitCode: 0, signal: null }));

    const code = runWorkerBuildSmoke({
      env: {},
      detectChangedFiles: () => known(['src/renderer/App.tsx', 'docs/project/README.md']),
      runWorkerBuild,
      log,
      error: vi.fn(),
    });

    expect(code).toBe(0);
    expect(runWorkerBuild).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[worker-build-smoke] skip: no worker-relevant files changed (2 changed file(s) checked from test diff)',
    );
  });

  it('runs fail-safe when the changed-file set cannot be determined', () => {
    const log = vi.fn();
    const runWorkerBuild = vi.fn(() => ({ exitCode: 0, signal: null }));

    const code = runWorkerBuildSmoke({
      env: {},
      detectChangedFiles: () => unknown('git merge-base failed'),
      runWorkerBuild,
      log,
      error: vi.fn(),
    });

    expect(code).toBe(0);
    expect(runWorkerBuild).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[worker-build-smoke] running: fail-safe: git merge-base failed');
  });

  it('surfaces a failing worker esbuild as a non-zero exit with a reproduce hint', () => {
    const log = vi.fn();
    const error = vi.fn();
    const runWorkerBuild = vi.fn(() => ({ exitCode: 7, signal: null }));

    const code = runWorkerBuildSmoke({
      env: {},
      detectChangedFiles: () => known(['src/main/gpu-worker/renderer.ts']),
      runWorkerBuild,
      log,
      error,
    });

    expect(code).toBe(7);
    expect(runWorkerBuild).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('[worker-build-smoke] FAIL: worker esbuild smoke failed.');
    expect(error.mock.calls[0]?.[0]).toContain('[worker-build-smoke] Reproduce: npm run build:worker');
  });

  it('finds the first relevant trigger after normalising duplicate paths', () => {
    expect(findWorkerBuildTrigger(['./docs/note.md', 'src\\core\\startup\\index.ts'])).toBe(
      'src/core/startup/index.ts',
    );
  });
});
