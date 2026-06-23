/**
 * Contract tests for the pendingLocalUploadsStore transport discriminator.
 *
 * Stage 1 adds a `transport: 'worker' | 'direct'` field. These tests assert:
 *  - new records are written with `transport: 'worker'`;
 *  - old persisted records (no `transport`) load/migrate as `'worker'`;
 *  - the store version is bumped to 2 by the migration.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingLocalUpload } from '../pendingLocalUploadsStore';

type PendingLocalUploadsState = {
  version: number;
  uploads: PendingLocalUpload[];
};

const mockStoreState = vi.hoisted(() => ({
  state: { version: 2, uploads: [] as PendingLocalUpload[] },
}));

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get store() {
      return mockStoreState.state;
    },
    set store(next: PendingLocalUploadsState) {
      mockStoreState.state = next;
    },
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  })),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  addPendingLocalUpload,
  getPendingLocalUploads,
} from '../pendingLocalUploadsStore';

describe('pendingLocalUploadsStore transport discriminator', () => {
  beforeEach(() => {
    mockStoreState.state = { version: 2, uploads: [] };
    vi.resetModules();
  });

  it('writes new records with transport "worker"', () => {
    addPendingLocalUpload({
      uploadId: 'up_new',
      clientSecret: 'secret',
      meetingTitle: 'New meeting',
      transport: 'worker',
    });

    const record = getPendingLocalUploads().find(u => u.uploadId === 'up_new');
    expect(record?.transport).toBe('worker');
    expect(record?.status).toBe('uploading');
    expect(record?.pollAttempts).toBe(0);
  });

  it('migrates old persisted records without a transport field to "worker"', async () => {
    // Simulate a v1 store: a record persisted before the discriminator existed.
    mockStoreState.state = {
      version: 1,
      uploads: [
        {
          uploadId: 'up_legacy',
          clientSecret: 'legacy-secret',
          meetingTitle: 'Legacy meeting',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          status: 'uploading',
          pollAttempts: 3,
          // NOTE: no `transport` field — this is the v1 shape.
        } as unknown as PendingLocalUpload,
      ],
    };

    // Re-import so the lazy getStore() runs the migration against the seeded state.
    vi.resetModules();
    const store = await import('../pendingLocalUploadsStore');

    const uploads = store.getPendingLocalUploads();
    const legacy = uploads.find(u => u.uploadId === 'up_legacy');
    expect(legacy?.transport).toBe('worker');
    // Other fields preserved unchanged.
    expect(legacy?.clientSecret).toBe('legacy-secret');
    expect(legacy?.pollAttempts).toBe(3);
    // Version bumped to current.
    expect(mockStoreState.state.version).toBe(2);
  });

  it('leaves an already-tagged record untouched on load', async () => {
    mockStoreState.state = {
      version: 2,
      uploads: [
        {
          uploadId: 'up_direct',
          clientSecret: 'unused',
          meetingTitle: 'Direct meeting',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          status: 'uploading',
          pollAttempts: 0,
          transport: 'direct',
          recallUploadId: 'recall_xyz',
        },
      ],
    };

    vi.resetModules();
    const store = await import('../pendingLocalUploadsStore');

    const record = store.getPendingLocalUploads().find(u => u.uploadId === 'up_direct');
    expect(record?.transport).toBe('direct');
    expect(record?.recallUploadId).toBe('recall_xyz');
  });
});
