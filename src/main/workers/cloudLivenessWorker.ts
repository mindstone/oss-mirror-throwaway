/**
 * Cloud FS Worker (utilityProcess) — 260619_cloud-symlink-indexing.
 *
 * The disposable child process that does the ACTUAL blocking filesystem work on a
 * cloud-storage mount. This is the ONLY place in Rebel allowed to issue an
 * unbounded `fs.*` against a (possibly dead) cloud FUSE mount — because if it
 * wedges, the PARENT SIGKILLs it and the operation resolves `degraded`/`reconnecting`.
 * The main process never blocks on the mount.
 *
 * This is exactly why the Stage-0 spike ruled out worker_threads: they share the
 * process-global libuv threadpool and are un-killable when syscall-blocked. A
 * separate OS process has its OWN pool and IS killable, so a wedged op here cannot
 * starve the main process.
 *
 * It serves TWO parents (both fork this same bundle):
 *  1. **Liveness probe** (`cloudLivenessProbeService`) — legacy protocol:
 *       parent → child: `{ id, target, probeReaddir? }`
 *       child → parent: `{ id, healthy }`
 *  2. **FS executor** (`cloudFsExecutorService`, the SYNTHESIS killable pool) — typed
 *     op protocol (the `WorkspaceFsExecutor` ops, metadata-only per the spike):
 *       parent → child: `{ id, op, target, encoding? }`
 *       child → parent: `{ id, ok: true, value } | { id, ok: false, code? }`
 *  The handler discriminates on the presence of `op`.
 *
 * IMPORTANT:
 *  - `process.parentPort` for communication; messages arrive as `{ data }`.
 *  - No Electron APIs (app/BrowserWindow). No app imports. Keep it TINY — the
 *    whole point is that this process can be killed at any moment with no state
 *    to lose.
 *  - We deliberately use the BLOCKING-capable async fs ops directly (no timeout):
 *    the timeout + kill live in the parent. A dead mount makes `fs.stat` hang
 *    here forever; that is fine and expected.
 *  - Replies ship METADATA, not `fs.Stats` (which can't cross structured-clone and
 *    whose extra fields are unused). `readFileBytes` ships a Buffer; `readFile`
 *    ships a decoded string (the only "slow" variant per the spike — acceptable for
 *    the non-bulk read consumers; bulk indexing uses metadata ops).
 */

import fs from 'node:fs/promises';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

// ── Liveness-probe protocol (legacy) ──
interface ProbeRequest {
  /** Correlation id echoed back so the parent can match the reply. */
  id: string;
  /** The readlink-resolved target path to probe. */
  target: string;
  /** Whether to additionally do a bounded top-level `readdir` (defence-in-depth). */
  probeReaddir?: boolean;
}
interface ProbeReply {
  id: string;
  healthy: boolean;
}

// ── FS-executor protocol (typed ops; the WorkspaceFsExecutor surface) ──
type FsOpName =
  | 'stat'
  | 'lstat'
  | 'realpath'
  | 'readlink'
  | 'readdir'
  | 'readdirWithFileTypes'
  | 'readFile'
  | 'readFileBytes'
  | 'access';
interface FsOpRequest {
  id: string;
  op: FsOpName;
  target: string;
  encoding?: BufferEncoding;
  /** `fs.constants.*_OK` bitmask for `access` (default `F_OK` = existence). */
  mode?: number;
}
type FsOpReply =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; code?: string };

/** Serializable metadata subset of `fs.Stats` (mirrors core `WorkspaceStat`). */
function toMeta(s: import('node:fs').Stats): {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
} {
  return {
    mtimeMs: s.mtimeMs,
    ctimeMs: s.ctimeMs,
    size: s.size,
    isDirectory: s.isDirectory(),
    isFile: s.isFile(),
    isSymbolicLink: s.isSymbolicLink(),
  };
}

// utilityProcess exposes the parent channel as `process.parentPort`. Typed
// minimally here because this file does not import Electron types (it must stay
// a plain Node bundle that the forked child can load).
type UtilityProcessParentPort = {
  postMessage: (message: unknown) => void;
  on: (event: 'message', listener: (event: { data: unknown }) => void) => void;
};

const parentPort = (process as unknown as { parentPort?: UtilityProcessParentPort }).parentPort;
if (!parentPort) {
  throw new Error('Cloud fs worker must be spawned via utilityProcess');
}
const port: UtilityProcessParentPort = parentPort;

/**
 * Perform the liveness probe. Returns `true` only if the mount answered every
 * requested op without throwing. A hang ⇒ this promise never settles and the
 * PARENT kills the process.
 */
async function probe(request: ProbeRequest): Promise<boolean> {
  try {
    await fs.stat(request.target);
    if (request.probeReaddir) {
      await fs.readdir(request.target);
    }
    return true;
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'cloudFsWorker.probe',
      reason: 'probe failure means the cloud target is unhealthy; report false to parent',
      severity: 'debug',
    });
    return false;
  }
}

/**
 * Perform a typed fs op. NEVER throws — a thrown fs error is reported as
 * `{ ok: false, code }`; a HANG means this promise never settles and the parent
 * SIGKILLs the child (→ `reason: 'timeout'` → `reconnecting`).
 */
async function runFsOp(request: FsOpRequest): Promise<FsOpReply> {
  const { id, op, target, encoding, mode } = request;
  try {
    switch (op) {
      case 'stat':
        return { id, ok: true, value: toMeta(await fs.stat(target)) };
      case 'lstat':
        return { id, ok: true, value: toMeta(await fs.lstat(target)) };
      case 'realpath':
        return { id, ok: true, value: await fs.realpath(target) };
      case 'readlink':
        return { id, ok: true, value: await fs.readlink(target) };
      case 'readdir':
        return { id, ok: true, value: await fs.readdir(target) };
      case 'readdirWithFileTypes': {
        const entries = await fs.readdir(target, { withFileTypes: true });
        return {
          id,
          ok: true,
          value: entries.map((e) => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            isFile: e.isFile(),
            isSymbolicLink: e.isSymbolicLink(),
          })),
        };
      }
      case 'readFile':
        return { id, ok: true, value: await fs.readFile(target, encoding ?? 'utf8') };
      case 'readFileBytes':
        return { id, ok: true, value: await fs.readFile(target) };
      case 'access':
        // `mode` (default F_OK) lets the parent probe write-permission (W_OK) on a
        // possibly-cloud path within the killable bound (S4.1e checkSpaceWritable).
        await fs.access(target, mode);
        return { id, ok: true, value: true };
      default:
        return { id, ok: false, code: 'EINVAL' };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    ignoreBestEffortCleanup(error, {
      operation: 'cloudFsWorker.runFsOp',
      reason: 'fs op failed (likely ENOENT/EACCES/EIO on a cloud target); report code to parent',
      severity: 'debug',
    });
    return { id, ok: false, code };
  }
}

function reply(message: ProbeReply | FsOpReply): void {
  try {
    port.postMessage(message);
  } catch (error) {
    // Parent channel gone (parent killed us mid-op). Nothing to recover.
    ignoreBestEffortCleanup(error, {
      operation: 'cloudFsWorker.postReply',
      reason: 'parent process gone (killed us mid-op); reply has no destination',
      severity: 'debug',
    });
  }
}

port.on('message', (event: { data: unknown }) => {
  const msg = event.data as Partial<FsOpRequest & ProbeRequest> | undefined;
  if (!msg || typeof msg.id !== 'string' || typeof msg.target !== 'string') {
    // Malformed — cannot correlate a reply, so drop it. The parent's per-op
    // timeout will fire and treat it as degraded/reconnecting.
    return;
  }

  // Discriminate: typed fs op (has `op`) vs legacy liveness probe.
  if (typeof msg.op === 'string') {
    const request: FsOpRequest = {
      id: msg.id,
      op: msg.op as FsOpName,
      target: msg.target,
      encoding: msg.encoding,
    };
    // Not awaited at the top level so a hung op doesn't block draining the next
    // message. `runFsOp` never rejects, so this only sends the reply.
    fireAndForget(
      runFsOp(request).then(reply),
      'cloudFsWorker.runFsOp',
    );
    return;
  }

  const request: ProbeRequest = {
    id: msg.id,
    target: msg.target,
    probeReaddir: msg.probeReaddir === true,
  };
  fireAndForget(
    probe(request).then((healthy) => reply({ id: request.id, healthy })),
    'cloudFsWorker.probe',
  );
});
