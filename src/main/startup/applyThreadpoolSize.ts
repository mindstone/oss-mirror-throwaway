/* eslint-disable no-console -- runs before the structured logger (pino) is initialised; same constraint as installGracefulFs */
/**
 * Desktop boot-time application of the libuv threadpool buffer.
 *
 * MUST be imported as the VERY FIRST side-effect in `bootstrap.ts` — before
 * `installGracefulFs` (the first fs touch) and before any other import that
 * could perform an async threadpool op. libuv reads `UV_THREADPOOL_SIZE` exactly
 * once, at first async-pool use; setting it afterwards is a silent no-op. See
 * `@core/startup/threadpoolSize` for the full rationale and the empirical proof
 * (Electron 42 / Node 22: the pool is not initialised at the main entry's first
 * JS line, so a first-line env set genuinely grows the pool — no relaunch needed).
 *
 * This module ONLY mutates `process.env` + logs. It performs no async fs/dns/
 * crypto itself (which would defeat the purpose). `os.availableParallelism()` is
 * synchronous and does not touch the threadpool.
 */

import os from 'node:os';
import {
  computeThreadpoolSize,
  decideThreadpoolBuffer,
  snapshotThreadpoolBuffer,
} from '@core/startup/threadpoolSize';

function availableParallelism(): number {
  return typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
}

/**
 * Apply the threadpool-size buffer to `process.env.UV_THREADPOOL_SIZE`. Returns
 * the human-readable outcome so callers can log it; never throws (a sizing
 * failure must never break boot — the worst case is the pre-fix default of 4).
 *
 * The log line reports the EFFECTIVE value libuv will read (a read-back
 * snapshot), not merely what we intended to set — so field diagnostics reveal a
 * silent no-op if the EMITTED bundle ever reorders this below an async pool op
 * (GPT review F1; we can't prove emitted-bundle order from a source-order test).
 */
export function applyThreadpoolSizeAtBoot(): string {
  try {
    const parallelism = availableParallelism();
    const desired = computeThreadpoolSize(parallelism);
    const decision = decideThreadpoolBuffer(process.env.UV_THREADPOOL_SIZE, desired);
    if (decision.applied) {
      process.env.UV_THREADPOOL_SIZE = decision.value;
    }
    const snapshot = snapshotThreadpoolBuffer(process.env.UV_THREADPOOL_SIZE, parallelism);
    return `UV_THREADPOOL_SIZE effective=${snapshot.effectiveSize ?? 'unset→libuv default 4'} desired=${desired} bufferApplied=${snapshot.bufferApplied} (${decision.reason}; parallelism=${parallelism})`;
  } catch (err) {
    return `threadpool buffer skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Side-effect on import: applied immediately so it precedes the first async
// threadpool op. The single console line is intentional (pre-logger boot).
const outcome = applyThreadpoolSizeAtBoot();
console.log(`[bootstrap] ${outcome}`);
