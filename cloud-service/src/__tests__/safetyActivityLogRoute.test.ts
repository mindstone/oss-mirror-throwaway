import { beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { setHandlerRegistry } from '@core/handlerRegistry';
import { MapHandlerRegistry } from '@core/handlerRegistry/mapHandlerRegistry';
import {
  addEvaluationEntry,
  addVersionChangeEntry,
  clearActivityLog,
  resetStoreForTesting,
} from '@core/safetyActivityLogStore';
import { SAFETY_ACTIVITY_LOG_MAX_ENTRIES } from '@core/safetyActivityLogTypes';
import type { ActivityLogEntry } from '@core/safetyActivityLogTypes';
import { CLOUD_IPC_ALLOWLIST as SHARED_IPC_ALLOWLIST } from '@shared/cloudChannelPolicies';
import { registerSafetyActivityLogHandlers } from '../../../src/main/ipc/cloudIpcHandlers';
import type { CloudServiceDeps } from '../bootstrap';
import { CLOUD_IPC_ALLOWLIST, handleGenericIpc } from '../routes/ipc';

function createMockReq(body: unknown): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.method = 'POST';
  req.push(JSON.stringify(body));
  req.push(null);
  return req;
}

type MockResShape = {
  _status: number;
  _body: unknown;
  _headers: Record<string, string | number>;
};

function createMockRes(): http.ServerResponse & { _status: number; _body: unknown } {
  return {
    _status: 0,
    _body: null as unknown,
    _headers: {} as Record<string, string | number>,
    writeHead(this: MockResShape, status: number, headers?: Record<string, string | number>) {
      this._status = status;
      if (headers) Object.assign(this._headers, headers);
      return this;
    },
    end(this: MockResShape, data?: string | Buffer) {
      const str = typeof data === 'string' ? data : data ? data.toString('utf8') : undefined;
      if (str) {
        this._body = JSON.parse(str);
      }
      return this;
    },
    setHeader() { return this; },
    getHeader() { return undefined; },
  } as unknown as http.ServerResponse & { _status: number; _body: unknown };
}

function ipcSegments(channel: string): string[] {
  return ['', 'ipc', encodeURIComponent(channel)];
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

const mockDeps = {} as CloudServiceDeps;

describe('cloud-service IPC route - safety-activity-log:get', () => {
  beforeEach(() => {
    setHandlerRegistry(new MapHandlerRegistry());
    resetStoreForTesting();
    clearActivityLog();
    registerSafetyActivityLogHandlers();
  });

  it('is server-allowlisted without becoming a shared cloud-routable desktop IPC channel', () => {
    expect(CLOUD_IPC_ALLOWLIST.has('safety-activity-log:get')).toBe(true);
    expect(SHARED_IPC_ALLOWLIST.has('safety-activity-log:get')).toBe(false);
  });

  it('reaches the registered handler through the generic route and returns seeded entries intact', async () => {
    addVersionChangeEntry(1, 2, 'chat-intent');
    addEvaluationEntry({
      toolDisplayName: 'Send message',
      toolId: 'slack_send_message',
      actionSummary: 'Send a message to the team channel',
      decision: 'allowed',
      reason: 'Matches the current safety rules',
      sessionType: 'automation',
      automationName: 'Daily digest',
      source: 'safety-prompt',
      flagged: false,
    });

    const req = createMockReq({ params: [{ limit: SAFETY_ACTIVITY_LOG_MAX_ENTRIES }] });
    const res = createMockRes();
    await handleGenericIpc(req, res, ipcSegments('safety-activity-log:get'), mockDeps);

    expect(res._status).toBe(200);
    const body = res._body as { entries?: ActivityLogEntry[] };
    expect(body.entries).toHaveLength(2);
    expect(body.entries).toContainEqual(expect.objectContaining({
      type: 'version-change',
      fromVersion: 1,
      toVersion: 2,
      source: 'chat-intent',
    }));
    expect(body.entries).toContainEqual(expect.objectContaining({
      type: 'evaluation',
      toolDisplayName: 'Send message',
      toolId: 'slack_send_message',
      actionSummary: 'Send a message to the team channel',
      decision: 'allowed',
      reason: 'Matches the current safety rules',
      sessionType: 'automation',
      automationName: 'Daily digest',
      source: 'safety-prompt',
      flagged: false,
    }));
  });

  it('accepts an omitted args payload because the get contract permits undefined', async () => {
    addVersionChangeEntry(2, 3, 'settings-editor');

    const req = createMockReq({ params: [] });
    const res = createMockRes();
    await handleGenericIpc(req, res, ipcSegments('safety-activity-log:get'), mockDeps);

    expect(res._status).toBe(200);
    expect((res._body as { entries?: ActivityLogEntry[] }).entries).toHaveLength(1);
  });

  it('rejects limits above the activity-log cap at the route layer', async () => {
    const req = createMockReq({ params: [{ limit: SAFETY_ACTIVITY_LOG_MAX_ENTRIES + 1 }] });
    const res = createMockRes();
    await handleGenericIpc(req, res, ipcSegments('safety-activity-log:get'), mockDeps);

    expect(res._status).toBe(400);
    expect(errorCode(res._body)).toBe('VALIDATION_ERROR');
  });
});
