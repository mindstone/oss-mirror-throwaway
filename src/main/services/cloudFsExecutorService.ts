/**
 * cloudFsExecutorService — desktop implementation of the SYNTHESIS cloud-lane
 * executor (`WorkspaceFsExecutor` from `@core/services/boundedWorkspaceFs`).
 *
 * This is the executor option-(c) the FINAL arbitration chose (architecture-review/
 * FINAL-arbitration.md §1): a small, bounded, KILLABLE child-process fs POOL. Only
 * the boundary's CLOUD lane reaches it; the local lane stays bare `fs`. The whole
 * reason it's a child PROCESS (not a worker_thread, not a main-thread semaphore):
 *
 *   - worker_threads share the process-global libuv pool and are un-killable when
 *     syscall-blocked → ruled out (Stage-0 spike);
 *   - a main-thread semaphore can bound concurrency but CANNOT reclaim a parked
 *     syscall — a dead mount permanently squats its slot (the dead-lane-starvation
 *     NO-GO);
 *   - only SIGKILLing a child OS process reclaims the kernel-blocked syscall.
 *
 * The spike (architecture-review/spike-childpool-throughput.md, conf 88) confirmed
 * this is throughput-viable: metadata-only replies land at ~parity with bare fs, and
 * 2 wedged children are SIGKILLed in ~1.7ms while the main thread stays responsive
 * (p99 1.26ms). N=2 children (default) give BEST-EFFORT per-target isolation: a
 * wedged child is killed + reclaimed independently (within OP_TIMEOUT_MS) and the
 * dispatcher prefers AVAILABLE workers, so a healthy space keeps being served while
 * one mount is dead. This is best-effort, NOT by-construction: there is no
 * target→worker affinity, so ≥N simultaneously-dead targets actively being read can
 * transiently saturate the pool — but it NEVER HANGS (every op is reclaimed within
 * OP_TIMEOUT_MS; contrast a main-thread semaphore's permanent dead-lane). This is
 * the bounded, reclaimable contract the FINAL arbitration chose; the residual
 * saturation window is the price of a BOUNDED pool, and is reclaim-capped, not
 * unbounded.
 *
 * DEFERRED TO S3/S5 (documented, not silent — these matter once a CONSUMER drives
 * real volume through the boundary; S2 is inert):
 *  - A global INFLIGHT CAP + FIFO queue (the spike's `inflight≈8` shape) so the bulk
 *    indexer can't post thousands of simultaneous ops/timers. Add it in S3 before
 *    wiring the bulk indexer (GPT-F2 / DA-F3).
 *  - PER-OP BUDGET RECLAIM: the boundary's per-call `timeoutMs` shortens only the
 *    caller-facing backstop; this executor's internal kill timer is fixed at
 *    OP_TIMEOUT_MS. A tight-budget caller (MA1) is released early but its slot isn't
 *    reclaimed until OP_TIMEOUT_MS. Thread the budget into `exec` when a consumer
 *    actually uses it (DA-F4).
 *  - Optional target→worker AFFINITY for stronger isolation (trade-off: pins one
 *    space's bulk reads to one child, hurting healthy-throughput spread — evaluate
 *    against the indexer's needs in S3).
 *
 * Each {@link PoolWorker} carries the proven single-child lifecycle from
 * `cloudLivenessProbeService` — spawn-lazily / parent-side timeout / SIGKILL-on-hang
 * / RS-F4 drain-pending-on-exit / F1 settle-race / F2 worker-identity-guard /
 * respawn-cooldown — adapted from liveness probing to typed fs ops. (Some lifecycle
 * shape is intentionally duplicated from the probe service rather than refactored
 * shared, to leave the live probe untouched; S4 consolidates the two once the
 * verdict-oracle framing is retired and the probe is derived from this executor.)
 *
 * Desktop-only (`utilityProcess`). Wired at bootstrap via `setWorkspaceFsExecutor`;
 * cloud/mobile keep the fail-closed no-op default (every cloud op → reconnecting).
 */

import type { UtilityProcess } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getElectronModule } from '@core/lazyElectron';
import { getPlatformConfig } from '@core/platform';
import { createScopedLogger } from '@core/logger';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { FS_TIMEOUT_CLOUD_MS } from '@core/utils/cloudStorageUtils';
import type {
  WorkspaceFsExecutor,
  WorkspaceFsExecResult,
  WorkspaceStat,
  WorkspaceDirent,
} from '@core/services/boundedWorkspaceFs';

const logger = createScopedLogger({ service: 'cloudFsExecutor' });

/**
 * Parent-side per-op hard timeout. On expiry the child is SIGKILLed (reclaim) and
 * the op resolves `reason: 'timeout'` (→ `reconnecting`). Matches the cloud fs
 * budget; the boundary's own (slightly longer) backstop is the belt over this.
 */
const OP_TIMEOUT_MS = FS_TIMEOUT_CLOUD_MS;
/** Respawn cooldown after a child death (mirrors the probe service + embeddingService). */
const RESPAWN_COOLDOWN_MS = 5000;
/** Default pool size. Spike: N=2-4 sufficient; 2 gives per-target isolation cheaply. */
const DEFAULT_POOL_SIZE = 2;
/**
 * Global cap on concurrent in-flight cloud ops across the whole pool (the spike's
 * `inflight≈8` shape). Excess ops QUEUE (FIFO) rather than each posting an IPC
 * message + arming a 15s timer — so the bulk indexer routing thousands of files
 * (S3) can't create a timer/IPC storm or let a dead mount park thousands of pending
 * ops. Healthy metadata ops are sub-ms (spike), so the queue drains near-instantly;
 * a wedged op holds its slot only until reclaimed (≤ OP_TIMEOUT_MS).
 */
const MAX_INFLIGHT = 8;

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

interface FsOpReplyMsg {
  id: string;
  ok: boolean;
  value?: unknown;
  code?: string;
}

/**
 * Resolve the worker JS path. Duplicated from `cloudLivenessProbeService` (S4
 * consolidates): packaged → `app.asar.unpacked/workers/cloudLivenessWorker.js`;
 * dev → `__dirname/workers` then `out/main/workers` fallbacks. `null` → fail closed.
 */
function resolveWorkerPath(): string | null {
  const config = getPlatformConfig();
  if (config.isPackaged) {
    const packaged = path.join(
      config.appPath.replace('app.asar', 'app.asar.unpacked'),
      'workers',
      'cloudLivenessWorker.js',
    );
    return fs.existsSync(packaged) ? packaged : null;
  }
  const candidates = [
    path.join(__dirname, 'workers', 'cloudLivenessWorker.js'),
    path.join(config.appPath, 'out', 'main', 'workers', 'cloudLivenessWorker.js'),
    path.join(process.cwd(), 'out', 'main', 'workers', 'cloudLivenessWorker.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Build a NodeJS.ErrnoException carrying the child-reported error code. */
function makeFsError(code: string | undefined): NodeJS.ErrnoException {
  const err = new Error(code ? `cloud fs op failed: ${code}` : 'cloud fs op failed') as NodeJS.ErrnoException;
  if (code) err.code = code;
  return err;
}

/** A single killable child in the pool. Owns ITS child + pending + lifecycle. */
class PoolWorker {
  private worker: UtilityProcess | null = null;
  private spawnFailedPermanently = false;
  private respawnCooldownUntilMs = 0;
  private readonly pending = new Map<
    string,
    { resolve: (r: WorkspaceFsExecResult<unknown>) => void; timeoutId: NodeJS.Timeout }
  >();
  private disposed = false;

  /** In-flight op count — the dispatcher's least-busy signal. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Whether this worker can serve a new op RIGHT NOW. False when disposed,
   * permanently spawn-failed, or in the respawn cooldown with no live child (in
   * which case `exec` would immediately fail-closed). The dispatcher must prefer
   * available workers — a cooling-down dead child reports `pendingCount === 0`
   * (drained on exit), so a pure least-busy `pick()` would wrongly route healthy
   * ops INTO the cooling-down child and fail them for the whole cooldown window
   * (S2 review F1, both reviewers). This getter is what makes the cooldown state
   * visible to the pool selector the single-child probe never needed.
   */
  get available(): boolean {
    if (this.disposed || this.spawnFailedPermanently) return false;
    if (Date.now() < this.respawnCooldownUntilMs && !this.worker) return false;
    return true;
  }

  /**
   * Run one typed fs op off-thread with a hard parent-side timeout. NEVER throws,
   * NEVER blocks the main event loop on a cloud syscall (the child does the blocking
   * op; we race it against a timer and SIGKILL on expiry). Resolves
   * `{ ok:false, reason:'timeout' }` on timeout/crash/spawn-failure (→ reconnecting),
   * `{ ok:false, reason:'error', error }` on a real fs error, `{ ok:true, value }`
   * on success.
   */
  exec<T>(op: FsOpName, target: string, encoding?: BufferEncoding, mode?: number): Promise<WorkspaceFsExecResult<T>> {
    const timeout = (): WorkspaceFsExecResult<T> => ({ ok: false, reason: 'timeout' });
    if (this.disposed || this.spawnFailedPermanently) return Promise.resolve(timeout());
    // Respawn cooldown: a permanently-dead mount keeps killing the child; don't
    // respawn on every op. Serve reconnecting until the cooldown elapses.
    if (Date.now() < this.respawnCooldownUntilMs && !this.worker) return Promise.resolve(timeout());

    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(timeout());

    const id = crypto.randomUUID();
    return new Promise<WorkspaceFsExecResult<T>>((resolve) => {
      const timeoutId = setTimeout(() => {
        // F1 settle-race: settle THIS op first (delete id, resolve), THEN SIGKILL.
        // A reply arriving in the kill→exit window then hits an empty `pending` and
        // is a no-op (no late success after a timeout).
        logger.warn({ op, redactedTargetHash: hashTarget(target), timeoutMs: OP_TIMEOUT_MS }, 'Cloud fs op timed out — killing child + reclaiming');
        this.settle(id, timeout());
        this.killWorker('op-timeout');
      }, OP_TIMEOUT_MS);
      timeoutId.unref?.();
      this.pending.set(id, { resolve: resolve as (r: WorkspaceFsExecResult<unknown>) => void, timeoutId });

      try {
        worker.postMessage({ id, op, target, encoding, mode });
      } catch (err) {
        // postMessage can throw if the child died between ensureWorker and now.
        logger.warn({ err }, 'Cloud fs op postMessage failed');
        this.settle(id, timeout());
        this.killWorker('post-message-failed');
      }
    });
  }

  private ensureWorker(): UtilityProcess | null {
    if (this.worker) return this.worker;
    const electron = getElectronModule();
    if (!electron?.utilityProcess) {
      this.spawnFailedPermanently = true;
      logger.info('Cloud fs executor disabled: utilityProcess unavailable');
      return null;
    }
    const workerPath = resolveWorkerPath();
    if (!workerPath) {
      this.spawnFailedPermanently = true;
      logger.error('Cloud fs worker file not found — executor disabled (fail-closed)');
      return null;
    }
    try {
      const worker = electron.utilityProcess.fork(workerPath, [], {
        serviceName: 'Cloud FS Worker',
        stdio: 'pipe',
      });
      worker.stdout?.on('data', (data: Buffer) => {
        const out = data.toString().trim();
        if (out) logger.debug({ source: 'cloud-fs-worker-stdout' }, out);
      });
      worker.stderr?.on('data', (data: Buffer) => {
        const err = data.toString().trim();
        if (err) logger.warn({ source: 'cloud-fs-worker-stderr' }, err);
      });
      // F2 worker-identity guard: bind THIS worker so a stale child's late events
      // can't clear a freshly-spawned worker or drain unrelated pending ops.
      worker.on('message', (raw: unknown) => this.handleReply(worker, raw));
      worker.on('exit', (code) => this.handleExit(worker, code));
      this.worker = worker;
      logger.info({ workerPath }, 'Cloud fs worker spawned');
      return worker;
    } catch (err) {
      logger.warn({ err }, 'Failed to spawn cloud fs worker');
      ignoreBestEffortCleanup(err, {
        operation: 'cloudFsExecutorService.ensureWorker',
        reason: 'worker spawn failed; arm respawn cooldown and serve reconnecting',
        severity: 'warn',
      });
      this.respawnCooldownUntilMs = Date.now() + RESPAWN_COOLDOWN_MS;
      this.worker = null;
      return null;
    }
  }

  private handleReply(worker: UtilityProcess, raw: unknown): void {
    if (worker !== this.worker) return; // F2: ignore a stale child's reply
    const msg = raw as Partial<FsOpReplyMsg> | undefined;
    if (!msg || typeof msg.id !== 'string' || typeof msg.ok !== 'boolean') return;
    if (msg.ok) {
      this.settle(msg.id, { ok: true, value: msg.value });
    } else {
      this.settle(msg.id, { ok: false, reason: 'error', error: makeFsError(msg.code) });
    }
  }

  private handleExit(worker: UtilityProcess, code: number | null): void {
    if (worker !== this.worker) return; // F2: ignore a stale child's exit
    if (!this.disposed) {
      logger.warn({ exitCode: code }, 'Cloud fs worker exited — draining pending ops to reconnecting');
    }
    this.worker = null;
    this.respawnCooldownUntilMs = Date.now() + RESPAWN_COOLDOWN_MS;
    this.drainPending();
  }

  private killWorker(reason: string): void {
    const worker = this.worker;
    if (!worker) {
      this.drainPending();
      return;
    }
    logger.debug({ reason }, 'Killing cloud fs worker');
    try {
      worker.kill();
      // Normal path: 'exit' fires async → handleExit drains + arms cooldown.
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'cloudFsExecutorService.killWorker',
        reason: 'kill threw; drain pending defensively in case no exit event fires',
        severity: 'debug',
      });
      this.worker = null;
      this.respawnCooldownUntilMs = Date.now() + RESPAWN_COOLDOWN_MS;
      this.drainPending();
    }
  }

  private settle(id: string, result: WorkspaceFsExecResult<unknown>): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timeoutId);
    this.pending.delete(id);
    p.resolve(result);
  }

  /** RS-F4: resolve EVERY in-flight op to reconnecting and clear the map. */
  private drainPending(): void {
    if (this.pending.size === 0) return;
    for (const [, p] of this.pending) {
      clearTimeout(p.timeoutId);
      p.resolve({ ok: false, reason: 'timeout' });
    }
    this.pending.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.killWorker('dispose');
    this.drainPending();
  }

  _debugState(): { hasWorker: boolean; pendingCount: number; spawnFailedPermanently: boolean; inCooldown: boolean } {
    return {
      hasWorker: this.worker !== null,
      pendingCount: this.pending.size,
      spawnFailedPermanently: this.spawnFailedPermanently,
      inCooldown: Date.now() < this.respawnCooldownUntilMs,
    };
  }
}

/**
 * The cloud-lane killable fs pool. `setWorkspaceFsExecutor(new CloudFsExecutorService())`
 * wires it at bootstrap (gated on `utilityProcess` — see index.ts).
 */
export class CloudFsExecutorService implements WorkspaceFsExecutor {
  private readonly workers: PoolWorker[];
  private readonly maxInflight: number;
  private inflight = 0;
  private readonly waiters: Array<() => void> = [];
  private disposed = false;

  constructor(poolSize: number = DEFAULT_POOL_SIZE, maxInflight: number = MAX_INFLIGHT) {
    this.workers = Array.from({ length: Math.max(1, poolSize) }, () => new PoolWorker());
    this.maxInflight = Math.max(1, maxInflight);
  }

  /** Acquire an in-flight slot (await if the pool is at the global cap). */
  private acquire(): Promise<void> {
    if (this.inflight < this.maxInflight) {
      this.inflight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Release a slot — hand it to the next FIFO waiter, else decrement. */
  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // slot handed off (inflight unchanged)
    } else {
      this.inflight -= 1;
    }
  }

  /** Run one op under the global inflight cap, then release the slot on settle. */
  private async run<T>(
    fn: (w: PoolWorker) => Promise<WorkspaceFsExecResult<T>>,
  ): Promise<WorkspaceFsExecResult<T>> {
    await this.acquire();
    try {
      return await fn(this.pick());
    } finally {
      this.release();
    }
  }

  /**
   * Pick the least-busy AVAILABLE worker. Availability-awareness is the F1 fix: a
   * cooling-down dead child is drained (`pendingCount === 0`), so a pure least-busy
   * pick would prefer it over a busy-but-healthy sibling and fail healthy ops for
   * the whole cooldown window. Among available workers, least-busy spreads load (and
   * a freshly-respawned worker, 0 pending, preferentially picks up new work). If
   * NONE is available, fall back to least-busy overall — that op fails-closed to
   * reconnecting (correct; never a hang).
   */
  private pick(): PoolWorker {
    let best: PoolWorker | null = null;
    for (const w of this.workers) {
      if (!w.available) continue;
      if (best === null || w.pendingCount < best.pendingCount) best = w;
    }
    if (best) return best;
    let fallback = this.workers[0];
    for (const w of this.workers) {
      if (w.pendingCount < fallback.pendingCount) fallback = w;
    }
    return fallback;
  }

  stat(p: string): Promise<WorkspaceFsExecResult<WorkspaceStat>> {
    return this.run((w) => w.exec<WorkspaceStat>('stat', p));
  }
  lstat(p: string): Promise<WorkspaceFsExecResult<WorkspaceStat>> {
    return this.run((w) => w.exec<WorkspaceStat>('lstat', p));
  }
  realpath(p: string): Promise<WorkspaceFsExecResult<string>> {
    return this.run((w) => w.exec<string>('realpath', p));
  }
  readlink(p: string): Promise<WorkspaceFsExecResult<string>> {
    return this.run((w) => w.exec<string>('readlink', p));
  }
  readdir(p: string): Promise<WorkspaceFsExecResult<string[]>> {
    return this.run((w) => w.exec<string[]>('readdir', p));
  }
  readdirWithFileTypes(p: string): Promise<WorkspaceFsExecResult<WorkspaceDirent[]>> {
    return this.run((w) => w.exec<WorkspaceDirent[]>('readdirWithFileTypes', p));
  }
  readFile(p: string, encoding: BufferEncoding): Promise<WorkspaceFsExecResult<string>> {
    return this.run((w) => w.exec<string>('readFile', p, encoding));
  }
  async readFileBytes(p: string): Promise<WorkspaceFsExecResult<Buffer>> {
    // Buffer loses its brand across structured-clone IPC (arrives as Uint8Array) —
    // coerce back so binary/base64 consumers get a real Buffer.
    const r = await this.run((w) => w.exec<Buffer | Uint8Array>('readFileBytes', p));
    if (r.ok && !Buffer.isBuffer(r.value)) {
      return { ok: true, value: Buffer.from(r.value as Uint8Array) };
    }
    return r as WorkspaceFsExecResult<Buffer>;
  }
  access(p: string, mode?: number): Promise<WorkspaceFsExecResult<true>> {
    return this.run((w) => w.exec<true>('access', p, undefined, mode));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.workers) w.dispose();
    // Release any queued waiters so their `run` proceeds and fails-closed against
    // the now-disposed workers (reconnecting) — no dangling acquire() promise.
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    }
  }

  /** Test-only diagnostics. */
  _debugState() {
    return this.workers.map((w) => w._debugState());
  }
}

/**
 * Hash a target path for logging so we never leak an email-bearing CloudStorage
 * path (e.g. `~/Library/CloudStorage/GoogleDrive-<email>/…`) into logs.
 */
function hashTarget(target: string): string {
  return crypto.createHash('sha256').update(target).digest('hex').slice(0, 12);
}
