import { describe, expect, it } from 'vitest';
import {
  detectPeerInstanceCount,
  isMultiRebelWorkspace,
  normalizePeerInstanceCount,
} from '../multiRebelWorkspaceDetector';

describe('multiRebelWorkspaceDetector', () => {
  it('normalizes valid peerInstanceCount values', () => {
    expect(normalizePeerInstanceCount(0)).toBe(0);
    expect(normalizePeerInstanceCount(1)).toBe(1);
    expect(normalizePeerInstanceCount(2)).toBe(2);
    expect(normalizePeerInstanceCount(2.9)).toBe(2);
  });

  it('drops invalid peerInstanceCount values', () => {
    expect(normalizePeerInstanceCount(-1)).toBeUndefined();
    expect(normalizePeerInstanceCount(Number.NaN)).toBeUndefined();
    expect(normalizePeerInstanceCount(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizePeerInstanceCount('2')).toBeUndefined();
    expect(normalizePeerInstanceCount(null)).toBeUndefined();
  });

  it('detects peer instance count from workspace objects', () => {
    expect(detectPeerInstanceCount({ peerInstanceCount: 4 })).toBe(4);
    expect(detectPeerInstanceCount({ peerInstanceCount: undefined })).toBeUndefined();
    expect(detectPeerInstanceCount(null)).toBeUndefined();
  });

  it('flags multi-Rebel workspaces only when peerInstanceCount > 1', () => {
    expect(isMultiRebelWorkspace({ peerInstanceCount: 0 })).toBe(false);
    expect(isMultiRebelWorkspace({ peerInstanceCount: 1 })).toBe(false);
    expect(isMultiRebelWorkspace({ peerInstanceCount: 2 })).toBe(true);
    expect(isMultiRebelWorkspace({ peerInstanceCount: '2' })).toBe(false);
  });
});
