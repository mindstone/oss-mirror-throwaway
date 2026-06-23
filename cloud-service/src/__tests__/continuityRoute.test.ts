/**
 * Tests for the continuity state route.
 *
 * Tests route-level PUT sanitization and activeOnly filtering integration guardrails.
 * State-machine unit coverage lives in cloudContinuityStateService.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import type http from 'node:http';
import { EventEmitter } from 'node:events';
import { readContinuityStateMap, resetCloudContinuityStateServiceForTests } from '@core/services/cloudContinuityStateService';

const TEST_DATA_DIR = '/tmp/test-continuity-route';
process.env.REBEL_USER_DATA = TEST_DATA_DIR;

function createBodyReq(method: 'PUT' | 'GET', url: string, body?: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost' };
  process.nextTick(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body)));
    }
    req.emit('end');
  });
  return req;
}

function createMockRes(): {
  res: http.ServerResponse;
  statusCode: () => number;
  body: () => unknown;
} {
  let capturedStatus = 200;
  let capturedBody = '';
  const res = {
    writeHead: (status: number) => {
      capturedStatus = status;
      return res;
    },
    end: (body?: string) => {
      capturedBody = body || '';
      return res;
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    statusCode: () => capturedStatus,
    body: () => (capturedBody ? JSON.parse(capturedBody) : null),
  };
}

beforeEach(async () => {
  process.env.REBEL_USER_DATA = TEST_DATA_DIR;
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  resetCloudContinuityStateServiceForTests();
});

afterEach(async () => {
  resetCloudContinuityStateServiceForTests();
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('continuity route', () => {
  describe('activeOnly session filtering logic', () => {
    it('includes active cloud_active sessions, excludes local_only', async () => {
      const { filterActiveOnlySessions } = await import('@core/services/cloudSessionMergeService');
      const stateMap = {
        's1': { state: 'cloud_active' as const },
        's2': { state: 'local_only' as const },
      };
      const sessions = [
        { id: 's1', updatedAt: 1000, doneAt: null },
        { id: 's2', updatedAt: 2000, doneAt: null },
      ];

      const filtered = filterActiveOnlySessions(sessions, stateMap);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('s1');
    });

    it('excludes sessions not in state map from activeOnly', async () => {
      const { filterActiveOnlySessions } = await import('@core/services/cloudSessionMergeService');
      const stateMap = {
        's1': { state: 'cloud_active' as const },
      };
      const sessions = [
        { id: 's1', updatedAt: 1000, doneAt: null },
        { id: 's3', updatedAt: 3000, doneAt: null },
      ];

      const filtered = filterActiveOnlySessions(sessions, stateMap);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('s1');
    });

    it('returns pinned non-deleted sessions when state map is null', async () => {
      const { filterActiveOnlySessions } = await import('@core/services/cloudSessionMergeService');
      const sessions = [
        { id: 's1', updatedAt: 1000, doneAt: null },
        { id: 's2', updatedAt: 2000, doneAt: null },
      ];

      const filtered = filterActiveOnlySessions(sessions, null);

      expect(filtered).toHaveLength(2);
    });

    it('returns empty array when all sessions are local_only', async () => {
      const { filterActiveOnlySessions } = await import('@core/services/cloudSessionMergeService');
      const stateMap = {
        's1': { state: 'local_only' as const },
        's2': { state: 'local_only' as const },
      };
      const sessions = [
        { id: 's1', updatedAt: 1000, doneAt: null },
        { id: 's2', updatedAt: 2000, doneAt: null },
      ];

      const filtered = filterActiveOnlySessions(sessions, stateMap);

      expect(filtered).toHaveLength(0);
    });

    it('excludes deleted sessions even if cloud_active', async () => {
      const { filterActiveOnlySessions } = await import('@core/services/cloudSessionMergeService');
      const stateMap = {
        's1': { state: 'cloud_active' as const },
        's2': { state: 'cloud_active' as const },
      };
      const sessions = [
        { id: 's1', updatedAt: 1000, doneAt: null, deletedAt: 900 },
        { id: 's2', updatedAt: 2000, doneAt: null },
      ];

      const filtered = filterActiveOnlySessions(sessions, stateMap);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('s2');
    });

    it('excludes Done sessions even if cloud_active', async () => {
      const { filterActiveOnlySessions } = await import('@core/services/cloudSessionMergeService');
      const stateMap = {
        's1': { state: 'cloud_active' as const },
        's2': { state: 'cloud_active' as const },
      };
      const sessions = [
        { id: 's1', updatedAt: 1000, doneAt: 1000 }, // Done → excluded
        { id: 's2', updatedAt: 2000, doneAt: null },
      ];

      const filtered = filterActiveOnlySessions(sessions, stateMap);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('s2');
    });

    it('Done and deleted filters apply even when state map is null', async () => {
      const { filterActiveOnlySessions } = await import('@core/services/cloudSessionMergeService');
      const sessions = [
        { id: 's1', updatedAt: 1000, doneAt: 1000 }, // Done → excluded
        { id: 's2', updatedAt: 2000, doneAt: null },
        { id: 's3', updatedAt: 3000, doneAt: null, deletedAt: 2500 },
      ];

      const filtered = filterActiveOnlySessions(sessions, null);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('s2');
    });
  });

  describe('PUT sanitization', () => {
    it('drops unsupported timestamp fields from incoming continuity entries', async () => {
      const { handleContinuity } = await import('../routes/continuity');
      const payload = {
        'session-a': {
          state: 'cloud_active',
          lastCloudActivityAt: 123,
          updatedAt: 9_999_999_999_999,
          cloudUpdatedAt: 9_999_999_999_999,
        },
      };
      const { res, statusCode } = createMockRes();

      await handleContinuity(
        createBodyReq('PUT', '/api/continuity/state', payload),
        res,
        ['api', 'continuity', 'state'],
        {
          listSessions: () => [],
          deleteSession: async () => {},
        } as unknown as import('../bootstrap').CloudServiceDeps,
      );

      expect(statusCode()).toBe(200);
      const stored = await readContinuityStateMap();
      expect(stored?.['session-a']).toEqual({
        state: 'cloud_active',
        lastCloudActivityAt: 123,
      });
    });

    it('returns refusedDemotions when refusing unsafe cloud_active -> local_only demotion', async () => {
      const { handleContinuity } = await import('../routes/continuity');
      const sessionId = 'unsafe-demotion-session';
      const now = Date.now();

      const seedRes = createMockRes();
      await handleContinuity(
        createBodyReq('PUT', '/api/continuity/state', {
          [sessionId]: {
            state: 'cloud_active',
            lastCloudActivityAt: now,
          },
        }),
        seedRes.res,
        ['api', 'continuity', 'state'],
        {
          listSessions: () => [],
          deleteSession: async () => {},
        } as unknown as import('../bootstrap').CloudServiceDeps,
      );
      expect(seedRes.statusCode()).toBe(200);

      const demotionRes = createMockRes();
      await handleContinuity(
        createBodyReq('PUT', '/api/continuity/state', {
          [sessionId]: { state: 'local_only' },
        }),
        demotionRes.res,
        ['api', 'continuity', 'state'],
        {
          listSessions: () => [],
          deleteSession: async () => {},
        } as unknown as import('../bootstrap').CloudServiceDeps,
      );

      expect(demotionRes.statusCode()).toBe(200);
      expect(demotionRes.body()).toEqual({
        success: true,
        refusedDemotions: 1,
        preserved: 0,
      });

      const stored = await readContinuityStateMap();
      expect(stored?.[sessionId]).toEqual(
        expect.objectContaining({ state: 'cloud_active' }),
      );
    });
  });
});
