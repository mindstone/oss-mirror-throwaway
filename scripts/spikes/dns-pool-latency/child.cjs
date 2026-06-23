'use strict';

/**
 * Manual dns.lookup latency probe child.
 *
 * Spawned once per matrix cell with UV_THREADPOOL_SIZE already set in the
 * sanitized child env. The first async pool op happens in this file, so libuv
 * reads the scenario's pool size before the probe starts.
 */

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function readPositiveInteger(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

const poolSize = readPositiveInteger('POOL_SIZE', readPositiveInteger('UV_THREADPOOL_SIZE', 4));
const blockers = readPositiveInteger('BLOCKERS', 9);
const lookups = readPositiveInteger('LOOKUPS', 400);
const steadyConcurrency = readPositiveInteger('DNS_CONCURRENCY', 32);
const childTimeoutMs = readPositiveInteger('CHILD_TIMEOUT_MS', 60_000);
const dnsName = process.env.DNS_NAME || 'localhost';
const mode = process.env.MODE === 'burst' ? 'burst' : 'steady';

const PBKDF2_SAMPLE_ITERATIONS = 200_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha512';
const SATURATED_TARGET_MS = 12_000;
const EXACT_POOL_TARGET_MS = 4_000;
const SPARE_HEADROOM_CPU_MS = 200;

let stopped = false;
let finished = false;
let cleanupDone = false;
let tmpDir;
const writerChildren = new Set();
const fifoPaths = [];
const openFds = new Set();

const safetyTimer = setTimeout(() => {
  emit({ ev: 'timeout', afterMs: childTimeoutMs });
  cleanup({ shouldReleaseFifos: true });
  setTimeout(() => {
    process.kill(process.pid, 'SIGKILL');
  }, 1_000).unref();
  process.exit(1);
}, childTimeoutMs);
safetyTimer.unref();

process.on('uncaughtException', (error) => {
  emit({ ev: 'error', reason: error instanceof Error ? error.message : String(error) });
  cleanup({ shouldReleaseFifos: true });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  emit({ ev: 'error', reason: reason instanceof Error ? reason.message : String(reason) });
  cleanup({ shouldReleaseFifos: true });
  process.exit(1);
});

function monotonicNowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function computeBlockerMix() {
  if (blockers >= poolSize) {
    const fsBlockers = Math.max(0, Math.min(blockers - 1, poolSize - 1));
    return { fsBlockers, cpuBlockers: blockers - fsBlockers };
  }

  const fsBlockers = Math.ceil(blockers / 2);
  return { fsBlockers, cpuBlockers: blockers - fsBlockers };
}

function targetCpuMs(cpuBlockers) {
  if (blockers > poolSize) {
    return Math.max(100, Math.round(SATURATED_TARGET_MS / Math.max(1, cpuBlockers)));
  }
  if (blockers === poolSize) {
    return EXACT_POOL_TARGET_MS;
  }
  return SPARE_HEADROOM_CPU_MS;
}

function runPbkdf2(iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2('dns-pool-latency', 'salt', iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function calibrateIterations(targetMs) {
  const startedAt = monotonicNowMs();
  await runPbkdf2(PBKDF2_SAMPLE_ITERATIONS);
  const elapsedMs = Math.max(1, monotonicNowMs() - startedAt);
  const scaled = Math.round((PBKDF2_SAMPLE_ITERATIONS * targetMs) / elapsedMs);
  return Math.max(20_000, Math.min(20_000_000, scaled));
}

function makeFifos(count) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dns-pool-latency-'));
  for (let index = 0; index < count; index += 1) {
    const fifoPath = path.join(tmpDir, `blocker-${index}.fifo`);
    const result = spawnSync('/usr/bin/mkfifo', [fifoPath], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: 'ignore',
    });
    if (result.status !== 0) {
      throw new Error(`mkfifo failed for blocker ${index}`);
    }
    fifoPaths.push(fifoPath);
  }
}

function releaseFifos() {
  for (const fifoPath of fifoPaths) {
    const child = spawn('/bin/sh', ['-c', ': > "$1"', 'release-fifo', fifoPath], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: 'ignore',
    });
    writerChildren.add(child);
    child.on('close', () => {
      writerChildren.delete(child);
    });
  }
}

function cleanup({ shouldReleaseFifos }) {
  if (cleanupDone) {
    return;
  }
  cleanupDone = true;
  stopped = true;
  if (shouldReleaseFifos) {
    releaseFifos();
  }
  for (const fd of openFds) {
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort cleanup for a manual diagnostic child.
    }
  }
  openFds.clear();
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for a manual diagnostic child.
    }
  }
}

function startFsBlocker(index) {
  const fifoPath = fifoPaths[index];
  fs.open(fifoPath, 'r', (error, fd) => {
    if (error) {
      if (!stopped) {
        emit({ ev: 'blocker-error', kind: 'fs', i: index, reason: error.message });
      }
      return;
    }
    openFds.add(fd);
    if (stopped) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort cleanup for a manual diagnostic child.
      }
      openFds.delete(fd);
    }
  });
}

function startCpuBlocker(index, iterations) {
  function submit() {
    if (stopped) {
      return;
    }
    crypto.pbkdf2(
      `dns-pool-latency-${index}`,
      'salt',
      iterations,
      PBKDF2_KEYLEN,
      PBKDF2_DIGEST,
      (error) => {
        if (error) {
          emit({ ev: 'blocker-error', kind: 'cpu', i: index, reason: error.message });
          return;
        }
        // Intentionally one-shot: immediate or delayed requeueing can repeatedly
        // overtake queued dns.lookup work on macOS, turning the manual spike into
        // an unbounded stress test. FIFO fs blockers are the persistent pool
        // holders; these pbkdf2 tasks are the CPU backlog submitted before DNS.
      },
    );
  }
  submit();
}

function lookupOnce(index) {
  return new Promise((resolve) => {
    const submittedAt = monotonicNowMs();
    dns.lookup(dnsName, (error, address, family) => {
      const latencyMs = monotonicNowMs() - submittedAt;
      const event = {
        ev: 'lookup',
        i: index,
        latencyMs,
        ok: !error,
        family: family ?? null,
      };
      if (error) {
        event.errorCode = error.code ?? 'UNKNOWN';
      } else {
        event.address = address;
      }
      emit(event);
      resolve(event);
    });
  });
}

async function runSteadyLookups() {
  const concurrency = Math.max(1, Math.min(steadyConcurrency, lookups));
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < lookups) {
      const index = nextIndex;
      nextIndex += 1;
      await lookupOnce(index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

async function runBurstLookups() {
  await Promise.all(Array.from({ length: lookups }, (_, index) => lookupOnce(index)));
}

async function main() {
  const { fsBlockers, cpuBlockers } = computeBlockerMix();
  const cpuTargetMs = targetCpuMs(cpuBlockers);
  const cpuIterations = cpuBlockers > 0 ? await calibrateIterations(cpuTargetMs) : 0;

  makeFifos(fsBlockers);

  emit({
    ev: 'start',
    poolSize,
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? null,
    blockers,
    fsBlockers,
    cpuBlockers,
    cpuTargetMs,
    cpuIterations,
    lookups,
    mode,
    dnsName,
  });

  for (let index = 0; index < fsBlockers; index += 1) {
    startFsBlocker(index);
  }
  for (let index = 0; index < cpuBlockers; index += 1) {
    startCpuBlocker(index, cpuIterations);
  }

  if (mode === 'burst') {
    await runBurstLookups();
  } else {
    await runSteadyLookups();
  }

  stopped = true;
  releaseFifos();
  clearTimeout(safetyTimer);

  // Give FIFO writers/readers a short chance to unwind so the child exits cleanly.
  setTimeout(() => {
    cleanup({ shouldReleaseFifos: false });
    if (!finished) {
      finished = true;
      emit({ ev: 'done' });
    }
  }, 250);
}

main().catch((error) => {
  emit({ ev: 'error', reason: error instanceof Error ? error.message : String(error) });
  cleanup({ shouldReleaseFifos: true });
  process.exit(1);
});
