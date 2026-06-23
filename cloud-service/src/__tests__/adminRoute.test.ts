import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';

vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('rec-existing-123'),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@core/services/cloud/cloudflareDns', () => ({
  deleteDnsRecord: vi.fn().mockResolvedValue({ success: true }),
}));

const hygieneSchedulerHandleMock = {
  current: undefined as
    | undefined
    | { getLastResult: () => unknown; getNextRunAt: () => number | undefined },
};

vi.mock('../services/cloudHygieneScheduler', () => ({
  getCloudHygieneSchedulerHandle: () => hygieneSchedulerHandleMock.current,
}));

const lkgStoreMock = {
  record: null as unknown,
  shouldThrow: false,
};

vi.mock('../services/lastKnownGoodImageTagStore', () => ({
  createLastKnownGoodImageTagStore: () => ({
    read: () => {
      if (lkgStoreMock.shouldThrow) {
        throw new Error('disk error');
      }
      return lkgStoreMock.record;
    },
  }),
}));

import { handleAdmin } from '../routes/admin';
import fs from 'node:fs/promises';
import { deleteDnsRecord } from '@core/services/cloud/cloudflareDns';

function createMockReq(body: unknown, method = 'POST'): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.headers = {};
  process.nextTick(() => {
    if (body !== null) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', Buffer.from(data));
    }
    req.emit('end');
  });
  return req;
}

type MockResShape = { _status: number; _body: string };

function createMockRes(): http.ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(this: MockResShape, status: number) {
      this._status = status;
    },
    end(this: MockResShape, body: string) {
      this._body = body;
    },
  } as unknown as http.ServerResponse & { _status: number; _body: string };
  return res;
}

describe('handleAdmin /api/admin/update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes signal file and tag file on valid request', async () => {
    const req = createMockReq({ targetTag: 'prod-abc123' });
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'update']);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toEqual({ signaled: true, targetTag: 'prod-abc123' });
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('rebel-cloud.tag'), 'prod-abc123', 'utf-8');
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining('.update-signal'), 'prod-abc123', 'utf-8');
  });

  it('defaults to prod-latest when no targetTag provided', async () => {
    const req = createMockReq({});
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'update']);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.targetTag).toBe('prod-latest');
  });

  it('accepts dev-latest tag', async () => {
    const req = createMockReq({ targetTag: 'dev-latest' });
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'update']);

    expect(res._status).toBe(200);
  });

  it('rejects invalid tag format', async () => {
    const req = createMockReq({ targetTag: 'my-custom-tag' });
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'update']);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error.code).toBe('INVALID_TAG');
  });

  it('rejects tag with special characters', async () => {
    const req = createMockReq({ targetTag: 'prod-abc; rm -rf /' });
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'update']);

    expect(res._status).toBe(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const req = createMockReq('not-valid-json{{{');
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'update']);

    expect(res._status).toBe(400);
  });

  it('returns 500 when file write fails', async () => {
    vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('Disk full'));

    const req = createMockReq({ targetTag: 'prod-abc123' });
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'update']);

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error.code).toBe('WRITE_FAILED');
  });
});

describe('handleAdmin /api/admin/dns/cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOUDFLARE_ZONE_ID = 'zone-test';
    process.env.CLOUDFLARE_DNS_TOKEN = 'token-test';
  });

  afterEach(() => {
    delete process.env.CLOUDFLARE_ZONE_ID;
    delete process.env.CLOUDFLARE_DNS_TOKEN;
  });

  it('deletes DNS record using stored record ID', async () => {
    const req = createMockReq(null);
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'dns', 'cleanup']);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ deleted: true, recordId: 'rec-existing-123' });
    expect(deleteDnsRecord).toHaveBeenCalledWith({
      zoneId: 'zone-test',
      apiToken: 'token-test',
      recordId: 'rec-existing-123',
    });
  });

  it('cleans up record ID file after successful deletion', async () => {
    const req = createMockReq(null);
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'dns', 'cleanup']);

    expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('.dns-record-id'));
  });

  it('returns graceful response when no record ID file exists (ENOENT)', async () => {
    const enoent = new Error('ENOENT') as NodeJS.ErrnoException;
    enoent.code = 'ENOENT';
    vi.mocked(fs.readFile).mockRejectedValueOnce(enoent);

    const req = createMockReq(null);
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'dns', 'cleanup']);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ deleted: false, reason: 'no-record-id' });
  });

  it('returns 500 for non-ENOENT read errors', async () => {
    const eio = new Error('EIO') as NodeJS.ErrnoException;
    eio.code = 'EIO';
    vi.mocked(fs.readFile).mockRejectedValueOnce(eio);

    const req = createMockReq(null);
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'dns', 'cleanup']);

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error.code).toBe('READ_ERROR');
  });

  it('returns error when Cloudflare credentials not configured', async () => {
    delete process.env.CLOUDFLARE_ZONE_ID;

    const req = createMockReq(null);
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'dns', 'cleanup']);

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error.code).toBe('DNS_NOT_CONFIGURED');
  });

  it('returns 502 when Cloudflare returns error', async () => {
    vi.mocked(deleteDnsRecord).mockResolvedValueOnce({ success: false, error: 'Record not found' });

    const req = createMockReq(null);
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'dns', 'cleanup']);

    expect(res._status).toBe(502);
    expect(JSON.parse(res._body).error.code).toBe('DNS_DELETE_FAILED');
  });

  it('returns 404 for unknown admin route', async () => {
    const req = createMockReq(null);
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'unknown']);

    expect(res._status).toBe(404);
  });
});

describe('handleAdmin /api/admin/hygiene-status', () => {
  beforeEach(() => {
    hygieneSchedulerHandleMock.current = undefined;
  });

  it('returns 503 when scheduler is not initialized', async () => {
    const req = createMockReq(null, 'GET');
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'hygiene-status']);

    expect(res._status).toBe(503);
    const body = JSON.parse(res._body);
    expect(body.error).toBe('Hygiene scheduler not initialized');
  });

  it('returns lastResult and nextRunAt when scheduler has run', async () => {
    const lastResult = {
      deletedSessionFiles: 4,
      deletedSessionBytes: 8192,
      removedLegacyFiles: ['agent-session-history.json'],
      sessionLogResult: { deleted: 2, errors: 0, remainingCount: 30, remainingBytes: 1024 },
      oldTranscripts: { deleted: 1, errors: 0 },
      errors: [],
      durationMs: 123,
    };
    const nextRunAt = 1_700_000_000_000;
    hygieneSchedulerHandleMock.current = {
      getLastResult: () => lastResult,
      getNextRunAt: () => nextRunAt,
    };

    const req = createMockReq(null, 'GET');
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'hygiene-status']);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.lastResult).toEqual(lastResult);
    expect(body.nextRunAt).toBe(nextRunAt);
  });

  it('returns null fields when scheduler exists but has not run yet', async () => {
    hygieneSchedulerHandleMock.current = {
      getLastResult: () => undefined,
      getNextRunAt: () => undefined,
    };

    const req = createMockReq(null, 'GET');
    const res = createMockRes();

    await handleAdmin(req, res, ['api', 'admin', 'hygiene-status']);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.lastResult).toBeNull();
    expect(body.nextRunAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stage D of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
// ---------------------------------------------------------------------------

describe('handleAdmin GET /api/admin/lkg-image', () => {
  beforeEach(() => {
    lkgStoreMock.record = null;
    lkgStoreMock.shouldThrow = false;
  });

  it('returns { record: null } when the cloud has no LKG yet', async () => {
    const req = createMockReq(null, 'GET');
    const res = createMockRes();
    await handleAdmin(req, res, ['api', 'admin', 'lkg-image']);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ record: null });
  });

  it('returns the full record (including previousLastKnownGood) on hit', async () => {
    lkgStoreMock.record = {
      version: 1,
      imageTag: 'ghcr.io/mindstone/rebel-cloud:prod-good',
      buildCommit: 'abc1234',
      schemaFingerprint: 'a'.repeat(64),
      recordedAt: 1700000000000,
      previousLastKnownGood: {
        imageTag: 'ghcr.io/mindstone/rebel-cloud:prod-older',
        schemaFingerprint: 'b'.repeat(64),
        recordedAt: 1690000000000,
      },
    };

    const req = createMockReq(null, 'GET');
    const res = createMockRes();
    await handleAdmin(req, res, ['api', 'admin', 'lkg-image']);

    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.record.imageTag).toBe(
      'ghcr.io/mindstone/rebel-cloud:prod-good',
    );
    expect(body.record.previousLastKnownGood.imageTag).toBe(
      'ghcr.io/mindstone/rebel-cloud:prod-older',
    );
  });

  it('returns 500 LKG_READ_FAILED when the store throws', async () => {
    lkgStoreMock.shouldThrow = true;
    const req = createMockReq(null, 'GET');
    const res = createMockRes();
    await handleAdmin(req, res, ['api', 'admin', 'lkg-image']);
    expect(res._status).toBe(500);
    expect(res._body).toContain('LKG_READ_FAILED');
  });

  it('returns 404 for other methods on /api/admin/lkg-image', async () => {
    const req = createMockReq({}, 'POST');
    const res = createMockRes();
    await handleAdmin(req, res, ['api', 'admin', 'lkg-image']);
    expect(res._status).toBe(404);
  });
});
