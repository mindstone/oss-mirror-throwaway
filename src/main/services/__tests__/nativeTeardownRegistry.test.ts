/**
 * Tests for the native-teardown coverage/liveness CONTRACT
 * (Stage 1 of docs/plans/260622_teardown-lifecycle-contract/PLAN.md).
 *
 * Asserts the manifest is well-formed: every inventoried owner is present with
 * the expected classification, the liveness accessors are wired (callable), and
 * the two known gaps (moonshine, file-index) are classified `tracked-gap`. The
 * companion test (nativeLivenessSnapshot.test.ts) proves the snapshot derives
 * its values from this registry while preserving the prior emitted shape.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock every owner's underlying accessor so liveness reads are deterministic
// without standing up real fsevents/ORT/LanceDB/super-mcp/BLE.
vi.mock('../fseventsLeakGuard', () => ({ liveNativeInstanceCount: vi.fn(() => 0) }));
vi.mock('../moonshineTranscriber', () => ({ getMoonshineLiveSessionCount: vi.fn(() => 0) }));
vi.mock('../conversationIndexService', () => ({ getConversationLanceLiveConnectionCount: vi.fn(() => 0) }));
vi.mock('../fileIndexService', () => ({ getFileLanceLiveConnectionCount: vi.fn(() => 0) }));
vi.mock('../toolIndexService', () => ({ getToolLanceLiveConnectionCount: vi.fn(() => 0) }));
vi.mock('../embeddingService', () => ({
  getEmbeddingLivenessSnapshot: vi.fn(() => ({ workerAlive: false, gpuBackendAlive: false, disposed: true })),
}));
vi.mock('../superMcpHttpManager', () => ({
  superMcpHttpManager: { getState: vi.fn(() => ({ isRunning: false, process: null })) },
}));
// NOTE: physicalRecordingService is deliberately NOT imported by the registry
// anymore (noble-ble is manifest-only, no liveness accessor) — so there is no
// mock for it here. That decoupling is the gate fix (its child_process.execFile
// transcription graph must not enter the registry's import graph).

import {
  NATIVE_TEARDOWN_OWNERS,
  getNativeTeardownOwner,
  getNativeTeardownOwnerNames,
  type NativeTeardownClassification,
} from '../nativeTeardownRegistry';

describe('nativeTeardownRegistry manifest', () => {
  it('registers every inventoried native owner with its expected classification', () => {
    const byName = new Map(NATIVE_TEARDOWN_OWNERS.map((o) => [o.name, o.classification]));
    const expected: Record<string, NativeTeardownClassification> = {
      fsevents: 'main-owner',
      'conversation-lancedb': 'main-owner',
      'tool-lancedb': 'main-owner',
      embedding: 'out-of-process-child',
      'super-mcp': 'out-of-process-child',
      // Stage 4 closed these two gaps: both now have a bounded disposer on the
      // normal-quit roster (gracefulShutdown.ts), so they are HANDLED main-owners.
      'moonshine-onnx': 'main-owner',
      'file-lancedb': 'main-owner',
      // Remaining tracked-gaps: noble-ble (user-initiated, idle by default) and
      // local-stt-sherpa (no release API exists — see the ORT release spike).
      'noble-ble': 'tracked-gap',
      'local-stt-sherpa': 'tracked-gap',
    };
    expect(Object.fromEntries(byName)).toEqual(expected);
  });

  it('has unique owner names', () => {
    const names = getNativeTeardownOwnerNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it('classifies the now-handled disposal owners (moonshine, file-index) as main-owner (Stage 4)', () => {
    // Stage 4 wired bounded disposers for both onto the normal-quit roster, so
    // they are no longer tracked-gaps.
    expect(getNativeTeardownOwner('moonshine-onnx')?.classification).toBe('main-owner');
    expect(getNativeTeardownOwner('file-lancedb')?.classification).toBe('main-owner');
  });

  it('wires a callable, synchronous liveness accessor for every HANDLED (snapshot-read) owner', () => {
    // The durable snapshot reads exactly these owners; each needs a liveness
    // accessor. Manifest-only tracked-gaps (noble-ble, local-stt-sherpa) carry
    // NO accessor by design — see the registry header's KEY PRINCIPLE.
    const handled = new Set([
      'fsevents',
      'conversation-lancedb',
      'tool-lancedb',
      'embedding',
      'super-mcp',
      'moonshine-onnx',
      'file-lancedb',
    ]);
    for (const owner of NATIVE_TEARDOWN_OWNERS) {
      if (!handled.has(owner.name)) {
        // Manifest-only owner: no live accessor (keeps its native graph out of
        // every consumer's static import graph).
        expect(owner.liveness).toBeUndefined();
        continue;
      }
      expect(typeof owner.liveness).toBe('function');
      const value = owner.liveness!();
      // Synchronous (not a Promise) and of the contract's value union.
      expect(value).not.toBeInstanceOf(Promise);
      expect(
        typeof value === 'number' || typeof value === 'boolean' || value === null,
      ).toBe(true);
    }
  });

  it('keeps the manifest-only tracked-gaps accessor-free (noble-ble, local-stt-sherpa)', () => {
    expect(getNativeTeardownOwner('noble-ble')?.liveness).toBeUndefined();
    expect(getNativeTeardownOwner('local-stt-sherpa')?.liveness).toBeUndefined();
  });

  it('reflects the underlying accessor value through the registry (single source of truth)', async () => {
    const { liveNativeInstanceCount } = await import('../fseventsLeakGuard');
    vi.mocked(liveNativeInstanceCount).mockReturnValue(7);
    expect(getNativeTeardownOwner('fsevents')?.liveness?.()).toBe(7);
  });

  it('returns undefined for an unknown owner name', () => {
    expect(getNativeTeardownOwner('does-not-exist')).toBeUndefined();
  });
});
