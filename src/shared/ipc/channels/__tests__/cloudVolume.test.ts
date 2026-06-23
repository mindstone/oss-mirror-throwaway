import { describe, expect, it } from 'vitest';
import { cloudChannels } from '../cloud';

describe('cloud volume IPC channels', () => {
  it('preserves VM tier display metadata in cloud:get-vm-tier responses', () => {
    const channel = cloudChannels['cloud:get-vm-tier'];

    expect(channel.response.parse({
      success: true,
      tier: {
        id: 'standard',
        label: 'Standard',
        description: 'Everyday continuity',
        cpuKind: 'shared',
        cpus: 4,
        memoryMb: 4096,
        estimatedMonthlyCostUsd: 19,
        workingRoom: 'Standard',
        speedRank: 1,
      },
    })).toMatchObject({
      tier: {
        workingRoom: 'Standard',
        speedRank: 1,
      },
    });
  });

  it('validates cloud:get-volume-status request and response', () => {
    const channel = cloudChannels['cloud:get-volume-status'];

    expect(channel.request.parse(undefined)).toBeUndefined();
    expect(channel.response.parse({
      kind: 'ok',
      sizeGb: 10,
      totalBytes: 10,
      usedBytes: 4,
      availableBytes: 6,
      lastCheckedAt: 123,
    })).toMatchObject({ kind: 'ok', sizeGb: 10 });
    expect(channel.response.parse({
      kind: 'cloud_unreachable',
      sizeGb: 10,
      reason: 'endpoint_missing',
      error: 'CLOUD_STORAGE_ENDPOINT_NOT_FOUND',
      lastCheckedAt: 123,
    })).toMatchObject({ kind: 'cloud_unreachable', reason: 'endpoint_missing' });
    expect(channel.response.parse({ kind: 'fly_token_missing' })).toEqual({ kind: 'fly_token_missing' });
  });

  it('validates cloud:resize-volume request and response', () => {
    const channel = cloudChannels['cloud:resize-volume'];

    expect(channel.request.parse({ targetSizeGb: 25 })).toEqual({ targetSizeGb: 25 });
    expect(() => channel.request.parse({ targetSizeGb: 9 })).toThrow();
    expect(channel.response.parse({
      success: false,
      applied: false,
      helpKey: 'in_flight_conflict',
      error: 'A capacity change is already in progress. Wait for it to finish.',
    })).toMatchObject({ success: false, helpKey: 'in_flight_conflict' });
  });
});
