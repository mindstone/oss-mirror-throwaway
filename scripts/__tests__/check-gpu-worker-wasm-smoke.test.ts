import { describe, expect, it } from 'vitest';
import {
  classifyGpuWorkerSmoke,
  EXPECTED_VECTOR_LENGTH,
} from '../check-gpu-worker-wasm-smoke';

const base = {
  kind: 'gpu-worker-smoke-result' as const,
  reachedReady: false,
  gpuAvailable: null,
  embeddingReceived: false,
  vectorLength: null,
  crashed: null,
  error: null,
  disableLogSeen: true,
  timedOut: false,
};

describe('classifyGpuWorkerSmoke', () => {
  it('PASS: reached ready + correct vector length, no crash (gpuAvailable irrelevant)', () => {
    const v = classifyGpuWorkerSmoke({ ...base, reachedReady: true, gpuAvailable: false, vectorLength: EXPECTED_VECTOR_LENGTH });
    expect(v.ok).toBe(true);
  });

  it('PASS holds even when WebGPU is unavailable (headless CI: device=cpu, WASM still compiles)', () => {
    // The crux of the CI-validity argument: gpuAvailable:false must NOT be a failure.
    const v = classifyGpuWorkerSmoke({ ...base, reachedReady: true, gpuAvailable: false, vectorLength: 384 });
    expect(v).toEqual({ ok: true, reason: expect.stringContaining('384-dim') });
  });

  it('GATE (the crash class): render-process-gone → not ok, kind=gate', () => {
    const v = classifyGpuWorkerSmoke({ ...base, crashed: { reason: 'crashed', exitCode: 11 } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.kind).toBe('gate');
  });

  it('GATE: a crash beats reachedReady (crash checked first)', () => {
    const v = classifyGpuWorkerSmoke({ ...base, reachedReady: true, vectorLength: 384, crashed: { reason: 'oom', exitCode: 5 } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.kind).toBe('gate');
  });

  it('GATE: embedding contract drift (wrong vector length) → gate', () => {
    const v = classifyGpuWorkerSmoke({ ...base, reachedReady: true, embeddingReceived: true, vectorLength: 768 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.kind).toBe('gate');
  });

  it('GATE: malformed embedding response (received but no/invalid vector) → gate, not setup', () => {
    // SHOULD-1 (cross-family review): an `embedding` response with a missing vector must
    // be a contract failure, distinct from "no response yet" (slow → setup).
    const v = classifyGpuWorkerSmoke({ ...base, reachedReady: true, embeddingReceived: true, vectorLength: null });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.kind).toBe('gate');
  });

  it('GATE: ready (WASM compiled) but embed errored → gate', () => {
    const v = classifyGpuWorkerSmoke({ ...base, reachedReady: true, error: 'embed boom' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.kind).toBe('gate');
  });

  it('SETUP (not a red): timed out before ready (slow download/compile)', () => {
    const v = classifyGpuWorkerSmoke({ ...base, timedOut: true });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.kind).toBe('setup');
  });

  it('SETUP: init error before ready (model download / network)', () => {
    const v = classifyGpuWorkerSmoke({ ...base, error: 'ENOTFOUND huggingface.co' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.kind).toBe('setup');
  });

  it('SETUP: ready but slow embed (no vector, no error) is not a crash verdict', () => {
    const v = classifyGpuWorkerSmoke({ ...base, reachedReady: true });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.kind).toBe('setup');
  });

  it('SETUP: null / wrong-shape snapshot', () => {
    expect(classifyGpuWorkerSmoke(null)).toMatchObject({ ok: false, kind: 'setup' });
    expect(classifyGpuWorkerSmoke({ kind: 'other' })).toMatchObject({ ok: false, kind: 'setup' });
    expect(classifyGpuWorkerSmoke('nope')).toMatchObject({ ok: false, kind: 'setup' });
  });

  it('non-vacuity: a clean PASS snapshot and a crash snapshot disagree', () => {
    const pass = classifyGpuWorkerSmoke({ ...base, reachedReady: true, vectorLength: 384 });
    const crash = classifyGpuWorkerSmoke({ ...base, crashed: { reason: 'crashed', exitCode: 11 } });
    expect(pass.ok).toBe(true);
    expect(crash.ok).toBe(false);
  });
});
