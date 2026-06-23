#!/usr/bin/env tsx
/**
 * GPU-WORKER WASM SMOKE GATE (Pathologist prevention rec #2 — postmortem
 * docs-private/postmortems/260616_electron42_gpu_worker_wasm_streaming_crash_postmortem.md).
 *
 * The durable, by-construction gate for the REBEL-68M/68Q crash class: on a
 * runtime/Electron upgrade, the local-embeddings gpu-worker can crash during
 * onnxruntime WebAssembly compilation (render-process-gone, exitCode:11 mac /
 * ACCESS_VIOLATION win) — invisible to unit tests and to diff review. This gate
 * launches the BUILT gpu-worker on the target Electron, drives it through
 * init + one embed, and FAILS RED (exit 1) if the renderer crashes or the
 * embedding contract drifts. Mirrors the structure of
 * scripts/check-packaged-app-boot-smoke.ts: a dumb Electron-main runner emits a
 * JSON snapshot; this orchestrator classifies it with a pure, unit-tested
 * function and a setup-vs-gate exit-code contract.
 *
 * Exit codes:
 *   0  pass — worker reached "ready" (WASM compiled) and produced a 384-dim vector, no crash.
 *   1  GATE failure — the crash class reproduced (render-process-gone) OR the embedding
 *      contract drifted (wrong vector length / embed failed after a successful compile).
 *   2  SETUP/precondition failure — built worker missing, model download/network flake,
 *      or compile/embed too slow within the budget. NEVER an interception verdict, so a
 *      flaky HuggingFace download can't false-red the gate.
 *
 * Usage: npx tsx scripts/check-gpu-worker-wasm-smoke.ts [--timeout-ms <n>] [--verbose]
 *   env: GPU_SMOKE_CACHE_DIR (reuse a model cache to skip download — set locally for speed;
 *        CI leaves it unset → fresh temp dir + download), GPU_SMOKE_WORKER_DIR (default
 *        out/main/gpu-worker), GPU_SMOKE_RUNNER_TIMEOUT_MS.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Embedding dimensionality. Both the production model (Xenova/bge-small-en-v1.5)
 * and the vendored smoke fixture (Xenova/all-MiniLM-L6-v2) are 384-dim, so the
 * contract-drift check holds whether the gate runs against the real model
 * (locally) or the offline fixture (CI).
 */
export const EXPECTED_VECTOR_LENGTH = 384;

/**
 * Locally-vendored, mirror-excluded model fixture (Apache-2.0 all-MiniLM-L6-v2,
 * under private/ so it never reaches the public mirror). When present and the
 * caller hasn't pinned its own cache dir, the gate drives the worker against it
 * so headless CI — which cannot fetch the default model — still EXECUTES the
 * onnxruntime-web WASM-compile crash path instead of green-skipping. Absent
 * (e.g. the public mirror, or a fresh checkout without the fixture) → the gate
 * falls back to the default model and degrades to a SKIP via --skip-on-setup.
 */
const FIXTURE_DIR = path.resolve(__dirname, '..', 'private', 'test-fixtures', 'gpu-worker-model');
const FIXTURE_MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const FIXTURE_MODEL_DTYPE = 'q8';

/** Structural subset of the runner's JSON result (scripts/gpu-worker-wasm-smoke-runner.cjs). */
export interface GpuWorkerSmokeSnapshot {
  kind?: string;
  reachedReady?: boolean;
  gpuAvailable?: boolean | null;
  embeddingReceived?: boolean;
  vectorLength?: number | null;
  crashed?: { reason?: string; exitCode?: number } | null;
  error?: string | null;
  disableLogSeen?: boolean;
  timedOut?: boolean;
}

export type GpuWorkerSmokeClassification =
  | { ok: true; reason: string }
  | { ok: false; kind: 'setup' | 'gate'; reason: string };

/**
 * Pure + total classifier. The RED (gate, exit 1) conditions are deliberately
 * narrow — only a renderer crash or an embedding-contract drift — so network /
 * model-download / slowness on CI degrade to SETUP (exit 2), never a false red.
 */
export function classifyGpuWorkerSmoke(snapshot: unknown): GpuWorkerSmokeClassification {
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') {
    return { ok: false, kind: 'setup', reason: 'no result snapshot from the runner (Electron failed to launch or emit a result)' };
  }
  const s = snapshot as GpuWorkerSmokeSnapshot;
  if (s.kind !== 'gpu-worker-smoke-result') {
    return { ok: false, kind: 'setup', reason: `unexpected snapshot shape (kind=${String(s.kind)})` };
  }

  // THE gate: a render-process-gone during WASM compile is the crash class.
  if (s.crashed) {
    return {
      ok: false,
      kind: 'gate',
      reason: `gpu-worker renderer crashed (reason=${s.crashed.reason ?? '?'}, exitCode=${s.crashed.exitCode ?? '?'}) — the REBEL-68M/68Q WASM-compile crash class reproduced`,
    };
  }

  if (s.reachedReady === true) {
    if (s.vectorLength === EXPECTED_VECTOR_LENGTH) {
      return {
        ok: true,
        reason: `worker reached ready + produced a ${s.vectorLength}-dim embedding (gpuAvailable=${String(s.gpuAvailable)}), no crash`,
      };
    }
    // An `embedding` response arrived but the vector is wrong/missing — a real contract
    // failure (gate), distinct from "no response yet" (slow, setup). The worker compiled
    // WASM (reached ready) so this is post-compile, not the crash class — but still red.
    if (s.embeddingReceived === true) {
      return {
        ok: false,
        kind: 'gate',
        reason: `embedding contract drift: vector length ${String(s.vectorLength)}, expected ${EXPECTED_VECTOR_LENGTH}`,
      };
    }
    if (s.error) {
      return { ok: false, kind: 'gate', reason: `worker reached ready (WASM compiled) but embed failed: ${s.error}` };
    }
    // Ready but no embedding response and no error within budget → slow embed, not a crash.
    return { ok: false, kind: 'setup', reason: 'worker reached ready but no embedding within the budget (slow embed)' };
  }

  // Never reached ready, and did NOT hard-crash → init/download/compile failure or slowness.
  // The crash class is a hard render-process-gone (handled above); everything else here is
  // env/precondition (setup), to keep network/model flakes from false-redding the gate.
  if (s.timedOut) {
    return { ok: false, kind: 'setup', reason: 'worker never reached ready within the budget (model download / WASM compile too slow, or hung) — setup, not a crash verdict' };
  }
  if (s.error) {
    return { ok: false, kind: 'setup', reason: `worker init failed before ready (likely model download / env): ${s.error}` };
  }
  return { ok: false, kind: 'setup', reason: 'worker never reached ready and reported no error (indeterminate) — setup' };
}

// --- CLI orchestration ----------------------------------------------------------------

const RESULT_SENTINEL = '__GPU_WORKER_SMOKE_RESULT__ ';
const DEFAULT_TIMEOUT_MS = 180_000;

function fail(code: 1 | 2, message: string): never {
  console.error(`[gpu-worker-smoke] FAIL (exit ${code}): ${message}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose');
  const ti = argv.indexOf('--timeout-ms');
  const timeoutMs = ti >= 0 && Number.isFinite(Number(argv[ti + 1])) ? Number(argv[ti + 1]) : DEFAULT_TIMEOUT_MS;

  // The `electron` npm package's main export (from Node) is the path to the binary.
  const electronPath = require('electron') as unknown as string;
  const runner = path.resolve(__dirname, 'gpu-worker-wasm-smoke-runner.cjs');

  // Resolve the model source. Precedence: an explicit caller-pinned
  // GPU_SMOKE_CACHE_DIR wins (local dev pointing at the real bge-small cache);
  // otherwise, if the vendored fixture is present, drive the worker against it
  // offline; otherwise leave both unset so the worker fetches its default model
  // (which green-skips in headless CI). Never override a caller-pinned cache dir.
  const childEnv = { ...process.env };
  const callerPinnedCacheDir = Boolean(process.env.GPU_SMOKE_CACHE_DIR);
  const usingFixture = !callerPinnedCacheDir && existsSync(FIXTURE_DIR);
  if (usingFixture) {
    childEnv.GPU_SMOKE_CACHE_DIR = FIXTURE_DIR;
    childEnv.GPU_SMOKE_MODEL_NAME = FIXTURE_MODEL_NAME;
    childEnv.GPU_SMOKE_MODEL_DTYPE = FIXTURE_MODEL_DTYPE;
    console.log(
      `[gpu-worker-smoke] using vendored offline fixture ${FIXTURE_MODEL_NAME} (${FIXTURE_MODEL_DTYPE}) at ${FIXTURE_DIR}`,
    );
  } else if (callerPinnedCacheDir) {
    console.log(`[gpu-worker-smoke] using caller-pinned GPU_SMOKE_CACHE_DIR=${process.env.GPU_SMOKE_CACHE_DIR}`);
  } else {
    console.log('[gpu-worker-smoke] no vendored fixture found — worker will fetch its default model (CI will likely SKIP on setup)');
  }

  console.log(`[gpu-worker-smoke] launching built gpu-worker on ${electronPath} (timeout ${timeoutMs}ms)…`);

  const child = spawn(electronPath, [runner], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    const text = String(d);
    stdout += text;
    if (verbose) process.stdout.write(text);
  });
  child.stderr.on('data', (d) => { stderr += String(d); });

  const killTimer = setTimeout(() => {
    if (verbose) console.log('[gpu-worker-smoke] hard timeout — killing runner');
    child.kill('SIGKILL');
  }, timeoutMs + 10_000);

  const exitCode: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
    child.on('error', () => resolve(-1));
  });
  clearTimeout(killTimer);

  const line = stdout.split('\n').find((l) => l.startsWith(RESULT_SENTINEL));
  if (!line) {
    fail(2, `runner emitted no result (electron exit ${exitCode}). stderr tail: ${stderr.slice(-400) || 'none'}`);
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(line.slice(RESULT_SENTINEL.length));
  } catch (e) {
    fail(2, `could not parse runner result JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const verdict = classifyGpuWorkerSmoke(snapshot);
  if (verdict.ok) {
    const s = snapshot as GpuWorkerSmokeSnapshot;
    console.log(`[gpu-worker-smoke] PASS: ${verdict.reason}${s.disableLogSeen ? ' [streaming-disable log seen]' : ''}`);
    process.exit(0);
  }
  // `--skip-on-setup` (env GPU_SMOKE_SKIP_ON_SETUP): on a SETUP verdict (no embedding
  // backend available in this environment — e.g. headless CI with no WebGPU and the
  // model/wasm not fetchable), exit 0 with a SKIPPED note instead of failing. A GATE
  // verdict (render-process-gone crash / vector drift) is NEVER skipped. This keeps the
  // CI jobs green-but-honest where the smoke physically can't run, while still going RED
  // on the actual crash class. See docs/plans/260616_gpu-embedding-boot-smoke-gate/PLAN.md.
  const allowSkip = argv.includes('--skip-on-setup') || process.env.GPU_SMOKE_SKIP_ON_SETUP === '1';
  if (verdict.kind === 'setup' && allowSkip) {
    console.log(`[gpu-worker-smoke] SKIPPED (setup, --skip-on-setup): ${verdict.reason}`);
    process.exit(0);
  }
  fail(verdict.kind === 'gate' ? 1 : 2, verdict.reason);
}

if (require.main === module) {
  void main().catch((err) => fail(2, `unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
}
