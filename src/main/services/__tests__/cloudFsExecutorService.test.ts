/**
 * cloudFsExecutorService — killable fs-pool lifecycle tests (SYNTHESIS S2).
 *
 * Tests the pool's timeout + SIGKILL-reclaim + respawn + RS-F4 drain + per-target
 * isolation against a CONTROLLABLE mock child (utilityProcess.fork is mocked). No
 * real Drive, no real child process.
 *
 * Coverage:
 *  - typed op success → { ok:true, value };
 *  - fs error reply (child threw ENOENT/EACCES) → { ok:false, reason:'error', code };
 *  - no reply within timeout → child SIGKILLed + { ok:false, reason:'timeout' } (reclaim);
 *  - child crash/exit mid-op → drain to reconnecting (RS-F4);
 *  - PER-TARGET ISOLATION: a wedged child does not block ops routed to the other;
 *  - missing worker path → fail closed (reconnecting, no spawn);
 *  - readFileBytes coerces a structured-clone Uint8Array back to Buffer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));
vi.mock('@core/logger', () => ({ createScopedLogger: () => mockLogger, logger: mockLogger }));

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({ isPackaged: false, appPath: '/mock/app/path', userDataPath: '/mock/userData' })),
}));

interface ReplyPayload {
  ok: boolean;
  value?: unknown;
  code?: string;
}
interface MockWorker {
  stdout: PassThrough;
  stderr: PassThrough;
  on: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  lastMessage: { id: string; op: string; target: string; encoding?: string; mode?: number } | null;
  killed: boolean;
  reply: (id: string, payload: ReplyPayload) => void;
  emitExit: (code: number | null) => void;
}

let mockWorkers: MockWorker[] = [];
/** 'ok' → auto-reply success; 'error' → auto-reply ENOENT; 'none' → hang. */
let autoReply: 'ok' | 'error' | 'none' = 'ok';
const SAMPLE_STAT = { mtimeMs: 1, ctimeMs: 1, size: 7, isDirectory: false, isFile: true, isSymbolicLink: false };

function createMockWorker(): MockWorker {
  const handlers = new Map<string, (arg: unknown) => void>();
  const worker: MockWorker = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: vi.fn((event: string, handler: (arg: unknown) => void) => {
      handlers.set(event, handler);
    }),
    postMessage: vi.fn((msg: { id: string; op: string; target: string; encoding?: string; mode?: number }) => {
      worker.lastMessage = msg;
      if (autoReply === 'ok') {
        queueMicrotask(() => worker.reply(msg.id, { ok: true, value: SAMPLE_STAT }));
      } else if (autoReply === 'error') {
        queueMicrotask(() => worker.reply(msg.id, { ok: false, code: 'ENOENT' }));
      }
      // 'none' → no reply (parent timeout fires).
    }),
    kill: vi.fn(() => {
      worker.killed = true;
      queueMicrotask(() => worker.emitExit(null)); // real utilityProcess emits exit after kill
    }),
    lastMessage: null,
    killed: false,
    reply: (id: string, payload: ReplyPayload) => handlers.get('message')?.({ id, ...payload }),
    emitExit: (code: number | null) => handlers.get('exit')?.(code),
  };
  return worker;
}

const forkMock = vi.hoisted(() => vi.fn());
const mockElectronModule = vi.hoisted(() => ({ utilityProcess: { fork: vi.fn() } }));
vi.mock('@core/lazyElectron', () => ({
  getElectronModule: () => mockElectronModule,
  onElectronAppEvent: vi.fn(),
}));

let workerFileExists = true;
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(() => workerFileExists) },
    existsSync: vi.fn(() => workerFileExists),
  };
});

import { CloudFsExecutorService } from '../cloudFsExecutorService';

const T = '/mock/Library/CloudStorage/GoogleDrive-x/General/doc.md';
let service: CloudFsExecutorService;

beforeEach(() => {
  vi.clearAllMocks();
  mockWorkers = [];
  autoReply = 'ok';
  workerFileExists = true;
  forkMock.mockImplementation(() => {
    const w = createMockWorker();
    mockWorkers.push(w);
    return w;
  });
  mockElectronModule.utilityProcess.fork = forkMock;
});

afterEach(() => {
  service?.dispose();
  vi.useRealTimers();
});

describe('cloudFsExecutorService — killable fs pool', () => {
  it('stat success → { ok:true, value }', async () => {
    service = new CloudFsExecutorService();
    const r = await service.stat(T);
    expect(r).toEqual({ ok: true, value: SAMPLE_STAT });
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('access(path, W_OK) forwards the mode in the worker message payload (S4.1e)', async () => {
    service = new CloudFsExecutorService();
    // W_OK = 2 (fs.constants.W_OK). The mode must reach the child so a write-permission
    // probe (spaceService.checkSpaceWritable) is bounded by the killable pool, not a raw
    // unbounded fs.access. Default (no mode) stays F_OK existence — unchanged for all
    // other callers.
    const W_OK = 2;
    const r = await service.access(T, W_OK);
    expect(r).toEqual({ ok: true, value: SAMPLE_STAT });
    expect(mockWorkers[0].lastMessage?.op).toBe('access');
    expect(mockWorkers[0].lastMessage?.mode).toBe(W_OK);
  });

  it('access(path) with no mode leaves mode undefined (F_OK existence probe — unchanged)', async () => {
    service = new CloudFsExecutorService();
    await service.access(T);
    expect(mockWorkers[0].lastMessage?.op).toBe('access');
    expect(mockWorkers[0].lastMessage?.mode).toBeUndefined();
  });

  it('fs error reply (ENOENT) → { ok:false, reason:"error", error.code }', async () => {
    service = new CloudFsExecutorService();
    autoReply = 'error';
    const r = await service.realpath(T);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('error');
    if (r.reason !== 'error') throw new Error('unreachable');
    expect(r.error.code).toBe('ENOENT');
  });

  it('no reply within timeout → child SIGKILLed + reconnecting (reclaim)', async () => {
    vi.useFakeTimers();
    service = new CloudFsExecutorService();
    autoReply = 'none';
    const pending = service.stat(T);
    await vi.advanceTimersByTimeAsync(20_000); // > OP_TIMEOUT_MS (15s)
    const r = await pending;
    expect(r).toEqual({ ok: false, reason: 'timeout' });
    expect(mockWorkers[0].killed).toBe(true); // wedged child SIGKILLed = reclaim
  });

  it('child crash/exit mid-op → drains pending to reconnecting (RS-F4)', async () => {
    service = new CloudFsExecutorService();
    autoReply = 'none';
    const pending = service.stat(T);
    await Promise.resolve(); // let the op post + register pending
    mockWorkers[0].emitExit(1); // child crashes
    const r = await pending;
    expect(r).toEqual({ ok: false, reason: 'timeout' });
  });

  it('PER-TARGET ISOLATION: a wedged child does not block the other pool child', async () => {
    service = new CloudFsExecutorService(2);
    autoReply = 'none'; // neither auto-replies; we drive replies manually
    const wedged = service.stat('/mock/Library/CloudStorage/GoogleDrive-x/Dead/x');
    const healthy = service.stat('/mock/Library/CloudStorage/GoogleDrive-x/Alive/y');
    await Promise.resolve();
    await Promise.resolve();
    // Two children spawned (least-busy dispatch routed the 2nd op to the 2nd child).
    expect(forkMock).toHaveBeenCalledTimes(2);
    // Reply ONLY on the second child — the first stays wedged.
    const secondMsg = mockWorkers[1].lastMessage;
    if (!secondMsg) throw new Error('second worker got no message');
    mockWorkers[1].reply(secondMsg.id, { ok: true, value: SAMPLE_STAT });
    const r = await healthy; // resolves despite the other child being wedged
    expect(r).toEqual({ ok: true, value: SAMPLE_STAT });
    // `wedged` is still pending (no reply) — isolation holds. (cleanup: dispose drains it)
    void wedged;
  });

  it('missing worker file → fail closed (reconnecting, no spawn)', async () => {
    workerFileExists = false;
    service = new CloudFsExecutorService();
    const r = await service.stat(T);
    expect(r).toEqual({ ok: false, reason: 'timeout' });
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('F1: after a child times out into cooldown, a healthy op routes to the AVAILABLE sibling', async () => {
    vi.useFakeTimers();
    service = new CloudFsExecutorService(2);
    // Op A wedges child-0 → times out → SIGKILL → child-0 enters respawn cooldown.
    autoReply = 'none';
    const a = service.stat('/mock/Library/CloudStorage/GoogleDrive-x/Dead/x');
    await vi.advanceTimersByTimeAsync(16_000); // > OP_TIMEOUT_MS; triggers kill+exit+cooldown
    expect(await a).toEqual({ ok: false, reason: 'timeout' });
    expect(mockWorkers[0].killed).toBe(true);
    // A healthy op DURING child-0's cooldown must NOT be routed back into the dead
    // child (the F1 bug) — it must go to the available child-1 and succeed.
    autoReply = 'ok';
    const b = await service.stat('/mock/Library/CloudStorage/GoogleDrive-x/Alive/y');
    expect(b).toEqual({ ok: true, value: SAMPLE_STAT });
    expect(forkMock).toHaveBeenCalledTimes(2); // child-0 (dead) + child-1 (served b)
  });

  it('both children wedged + a 3rd op → all resolve reconnecting (no hang, reclaim-capped)', async () => {
    vi.useFakeTimers();
    service = new CloudFsExecutorService(2);
    autoReply = 'none';
    const a = service.stat('/mock/Library/CloudStorage/GoogleDrive-x/Dead1/x');
    const b = service.stat('/mock/Library/CloudStorage/GoogleDrive-x/Dead2/y');
    const c = service.stat('/mock/Library/CloudStorage/GoogleDrive-x/Dead3/z');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await a).toEqual({ ok: false, reason: 'timeout' });
    expect(await b).toEqual({ ok: false, reason: 'timeout' });
    expect(await c).toEqual({ ok: false, reason: 'timeout' }); // never hangs
  });

  it('dispose() while an op is in flight resolves it reconnecting (no dangling promise)', async () => {
    service = new CloudFsExecutorService();
    autoReply = 'none';
    const pending = service.stat(T);
    await Promise.resolve(); // register the pending op
    service.dispose();
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
  });

  it('a reply arriving AFTER a timeout settle is a no-op (F1 settle-race + F2 identity guard)', async () => {
    vi.useFakeTimers();
    service = new CloudFsExecutorService(1);
    autoReply = 'none';
    const a = service.stat(T);
    await Promise.resolve();
    const msg = mockWorkers[0].lastMessage;
    if (!msg) throw new Error('no message');
    await vi.advanceTimersByTimeAsync(16_000); // timeout settles `a` reconnecting, kills child
    expect(await a).toEqual({ ok: false, reason: 'timeout' });
    // A late healthy reply for the already-settled id must NOT flip it to ok.
    mockWorkers[0].reply(msg.id, { ok: true, value: SAMPLE_STAT });
    await Promise.resolve();
    expect(await a).toEqual({ ok: false, reason: 'timeout' }); // unchanged
  });

  it('global inflight cap queues excess ops (no post until a slot frees)', async () => {
    service = new CloudFsExecutorService(2, 1); // 2 workers, cap = 1 inflight
    autoReply = 'none'; // drive replies manually
    const a = service.stat('/mock/Library/CloudStorage/GoogleDrive-x/A/x');
    const b = service.stat('/mock/Library/CloudStorage/GoogleDrive-x/B/y');
    await Promise.resolve();
    await Promise.resolve();
    // Only op A holds the single slot → only 1 worker spawned, only 1 message posted.
    expect(mockWorkers.length).toBe(1);
    const totalPosts = () => mockWorkers.reduce((n, w) => n + w.postMessage.mock.calls.length, 0);
    expect(totalPosts()).toBe(1);
    // Settle A → its slot is handed to the queued op B, which now posts.
    const aId = mockWorkers[0].lastMessage!.id;
    mockWorkers[0].reply(aId, { ok: true, value: SAMPLE_STAT });
    expect(await a).toEqual({ ok: true, value: SAMPLE_STAT });
    await Promise.resolve();
    await Promise.resolve();
    expect(totalPosts()).toBe(2); // B posted after A freed the slot
    const bId = mockWorkers[0].lastMessage!.id;
    mockWorkers[0].reply(bId, { ok: true, value: SAMPLE_STAT });
    expect(await b).toEqual({ ok: true, value: SAMPLE_STAT });
  });

  it('readFileBytes coerces a structured-clone Uint8Array back to Buffer', async () => {
    service = new CloudFsExecutorService();
    autoReply = 'none';
    const pending = service.readFileBytes(T);
    await Promise.resolve();
    const msg = mockWorkers[0].lastMessage;
    if (!msg) throw new Error('no message');
    // Simulate structured-clone delivering a Uint8Array (Buffer brand lost over IPC).
    mockWorkers[0].reply(msg.id, { ok: true, value: new Uint8Array([1, 2, 3]) });
    const r = await pending;
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(Buffer.isBuffer(r.value)).toBe(true);
    expect([...r.value]).toEqual([1, 2, 3]);
  });
});
