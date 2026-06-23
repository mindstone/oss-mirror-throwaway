 

jest.mock('@rebel/cloud-client', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }),
  useAuthStore: () => ({
    cloudUrl: null,
    token: null,
  }),
  useOfflineQueueStore: () => [],
}));

jest.mock('../context/NetworkContext', () => ({
  useNetworkContext: () => ({ isOnline: true }),
}));

jest.mock('../utils/meetingManifest', () => ({
  readMeetingManifest: jest.fn(),
}));

import { deriveMeetingHealthStatus } from '../hooks/useMeetingHealthIndicator';

describe('deriveMeetingHealthStatus', () => {
  it('reports connected when the device is online and uploads are caught up', () => {
    expect(
      deriveMeetingHealthStatus({
        isOnline: true,
        pendingChunks: 2,
        failedChunks: 0,
        lastCloudAckAgeMs: 30_000,
      }),
    ).toBe('connected');
  });

  it('reports uploading when the local queue is backing up', () => {
    expect(
      deriveMeetingHealthStatus({
        isOnline: true,
        pendingChunks: 3,
        failedChunks: 0,
        lastCloudAckAgeMs: 30_000,
      }),
    ).toBe('uploading');
  });

  it('reports offline before upload lag when the device has no connection', () => {
    expect(
      deriveMeetingHealthStatus({
        isOnline: false,
        pendingChunks: 6,
        failedChunks: 0,
        lastCloudAckAgeMs: 30_000,
      }),
    ).toBe('offline');
  });

  it('reports error when either local chunk failures or cloud session failure are present', () => {
    expect(
      deriveMeetingHealthStatus({
        isOnline: true,
        pendingChunks: 0,
        failedChunks: 1,
        lastCloudAckAgeMs: 30_000,
      }),
    ).toBe('error');

    expect(
      deriveMeetingHealthStatus({
        isOnline: true,
        pendingChunks: 0,
        failedChunks: 0,
        cloudStatus: 'failed',
        lastCloudAckAgeMs: 30_000,
      }),
    ).toBe('error');
  });

  it('degrades to uploading when the cloud acknowledgement goes stale', () => {
    expect(
      deriveMeetingHealthStatus({
        isOnline: true,
        pendingChunks: 0,
        failedChunks: 0,
        lastCloudAckAgeMs: 120_000,
      }),
    ).toBe('connected');

    expect(
      deriveMeetingHealthStatus({
        isOnline: true,
        pendingChunks: 0,
        failedChunks: 0,
        lastCloudAckAgeMs: 120_001,
      }),
    ).toBe('uploading');
  });
});
