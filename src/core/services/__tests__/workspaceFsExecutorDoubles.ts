/**
 * Shared test doubles for the boundedWorkspaceFs cloud-lane executor.
 *
 * NOT a test file (no `.test`/`.spec` suffix → not collected by the vitest glob,
 * `src/**\/*.{test,spec}.…`). Consumed by the boundary-routed walker suites
 * (safeWalkDirectory + its admission/readlink-first/cloud-root variants) to model a
 * HEALTHY cloud mount (delegates to real `fs`) or a DEAD mount (every op times out →
 * the boundary maps it to `reconnecting`). These replace the per-file
 * `vi.mock('node:fs/promises')` doubles those suites used before S4.1a routed the walker
 * through the boundary: the CLOUD lane never touches `fs` at all (it calls the executor), so a
 * cloud-classified path can only be driven in a unit test by wiring an executor here. The LOCAL
 * lane DOES use `node:fs/promises` (the boundary imports it directly — S4.1a), so local-path
 * reads stay interceptable by the standard `vi.mock('node:fs/promises')` seam and need no double.
 */
import { promises as fsp } from 'node:fs';
import type {
  WorkspaceFsExecutor,
  WorkspaceFsExecResult,
  WorkspaceStat,
  WorkspaceDirent,
} from '@core/services/boundedWorkspaceFs';

/** Map a real `fs.Stats` to the serializable {@link WorkspaceStat}. */
export function toWorkspaceStat(s: import('node:fs').Stats): WorkspaceStat {
  return {
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    size: s.size,
    isDirectory: s.isDirectory(),
    isFile: s.isFile(),
    isSymbolicLink: s.isSymbolicLink(),
  };
}

async function wrap<T>(work: () => Promise<T>): Promise<WorkspaceFsExecResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    return { ok: false, reason: 'error', error: err as NodeJS.ErrnoException };
  }
}

/** A HEALTHY cloud mount: every op delegates to real `fs`; real fs errors → `error`. */
export const realFsExecutor: WorkspaceFsExecutor = {
  stat: (p) => wrap(async () => toWorkspaceStat(await fsp.stat(p))),
  lstat: (p) => wrap(async () => toWorkspaceStat(await fsp.lstat(p))),
  realpath: (p) => wrap(() => fsp.realpath(p)),
  readlink: (p) => wrap(() => fsp.readlink(p)),
  readdir: (p) => wrap(() => fsp.readdir(p)),
  readdirWithFileTypes: (p) =>
    wrap(async () => {
      const ents = await fsp.readdir(p, { withFileTypes: true });
      return ents.map<WorkspaceDirent>((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymbolicLink: e.isSymbolicLink(),
      }));
    }),
  readFile: (p, enc) => wrap(() => fsp.readFile(p, enc)),
  readFileBytes: (p) => wrap(() => fsp.readFile(p)),
  access: (p, mode) =>
    wrap(async () => {
      await fsp.access(p, mode);
      return true as const;
    }),
};

/** A DEAD mount: every op times out → the boundary maps to `reconnecting`. */
export const deadMountExecutor: WorkspaceFsExecutor = (() => {
  const timeout = (): Promise<WorkspaceFsExecResult<never>> => Promise.resolve({ ok: false, reason: 'timeout' });
  return {
    stat: timeout,
    lstat: timeout,
    realpath: timeout,
    readlink: timeout,
    readdir: timeout,
    readdirWithFileTypes: timeout,
    readFile: timeout,
    readFileBytes: timeout,
    access: timeout,
  } as unknown as WorkspaceFsExecutor;
})();

/** A healthy executor with specific ops overridden (e.g. a wedged readdir/stat). */
export function realFsExecutorWith(overrides: Partial<WorkspaceFsExecutor>): WorkspaceFsExecutor {
  return { ...realFsExecutor, ...overrides };
}
