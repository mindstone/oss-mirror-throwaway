import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@core/logger';
import { ResolutionFailureSchema } from '@shared/ipc/schemas/agent';
import type { AssetResolutionReason } from '@shared/types/agent';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import {
  getRecentResolutionFailures,
  recordAssetResolutionFailure,
  resetAssetResolutionFailuresForTests,
} from '../assetResolutionObservability';

function createMockLogger(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

describe('assetResolutionObservability', () => {
  beforeEach(() => {
    resetAssetResolutionFailuresForTests();
  });

  it('recordAssetResolutionFailure emits structured warn with hashed IDs', () => {
    const log = createMockLogger();
    recordAssetResolutionFailure({
      sessionId: 'session-1',
      assetId: 'asset-1',
      reason: 'not-found',
      context: 'hydrate',
      metadata: { provider: 'openai' },
      log,
    });

    expect(log.warn).toHaveBeenCalledWith(
      {
        provider: 'openai',
        sessionIdHash: hashSessionIdForBreadcrumb('session-1'),
        assetIdHash: hashSessionIdForBreadcrumb('asset-1'),
        reason: 'not-found',
        context: 'hydrate',
      },
      'asset-resolution-failure',
    );
  });

  it('ring buffer is capped to last 100 failures per session', () => {
    const log = createMockLogger();
    for (let i = 0; i < 105; i += 1) {
      recordAssetResolutionFailure({
        sessionId: 'session-cap',
        assetId: `asset-${i}`,
        reason: 'upload-failed',
        context: 'upload',
        metadata: { index: i },
        log,
      });
    }

    const recent = getRecentResolutionFailures('session-cap');
    expect(recent).toHaveLength(100);
    expect(recent[0]?.metadata).toEqual({ index: 5 });
    expect(recent[99]?.metadata).toEqual({ index: 104 });
  });

  it('getRecentResolutionFailures returns only entries for requested session', () => {
    const log = createMockLogger();
    recordAssetResolutionFailure({
      sessionId: 'session-a',
      assetId: 'asset-a1',
      reason: 'not-found',
      context: 'protocol',
      log,
    });
    recordAssetResolutionFailure({
      sessionId: 'session-b',
      assetId: 'asset-b1',
      reason: 'corrupt',
      context: 'cloud-get',
      log,
    });

    const aFailures = getRecentResolutionFailures('session-a');
    const bFailures = getRecentResolutionFailures('session-b');

    expect(aFailures).toHaveLength(1);
    expect(bFailures).toHaveLength(1);
    expect(aFailures[0]?.assetIdHash).toBe(hashSessionIdForBreadcrumb('asset-a1'));
    expect(bFailures[0]?.assetIdHash).toBe(hashSessionIdForBreadcrumb('asset-b1'));
  });

  it('ResolutionFailureSchema accepts JSON-scalar metadata bags', () => {
    const result = ResolutionFailureSchema.safeParse({
      timestamp: 1,
      sessionIdHash: 'h',
      reason: 'not-found',
      context: 'hydrate',
      metadata: { providerKey: 'openai', byteSize: 1024, oversized: false, tags: ['a', 'b'] },
    });
    expect(result.success).toBe(true);
  });

  it('ResolutionFailureSchema rejects non-JSON metadata values (function)', () => {
    const result = ResolutionFailureSchema.safeParse({
      timestamp: 1,
      sessionIdHash: 'h',
      reason: 'not-found',
      context: 'hydrate',
      metadata: { handler: () => {} },
    });
    expect(result.success).toBe(false);
  });

  it('accepts and logs unknown open-union reason codes', () => {
    const log = createMockLogger();
    const futureReason: AssetResolutionReason = 'future-reason';

    recordAssetResolutionFailure({
      sessionId: 'session-future',
      assetId: 'asset-future',
      reason: futureReason,
      context: 'persist',
      log,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'future-reason',
      }),
      'asset-resolution-failure',
    );
    expect(getRecentResolutionFailures('session-future')[0]?.reason).toBe('future-reason');
  });
});
