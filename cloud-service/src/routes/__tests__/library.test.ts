import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getWorkspaceFileSystem, setWorkspaceFileSystemFactory } from '@core/workspaceFileSystem';
import type { CloudServiceDeps } from '../../bootstrap';
import { CloudWorkspaceFileSystem } from '../../services/cloudWorkspaceFileSystem';
import { handleLibrary } from '../library';

interface MockRes {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
  statusCode: number;
  setHeader(key: string, value: string): void;
  getHeader(key: string): string | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function createMockReq(
  body: unknown,
  action: string,
  method: 'GET' | 'POST' = 'POST',
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.headers = { host: 'cloud.local', 'content-type': 'application/json' };
  req.url = `/api/library/${action}`;
  setImmediate(() => {
    if (body !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'));
    }
    req.emit('end');
  });
  return req;
}

function createMockRes(): http.ServerResponse & MockRes {
  const res: MockRes = {
    _status: 0,
    _body: '',
    _headers: {},
    statusCode: 0,
    setHeader(key: string, value: string) {
      this._headers[key] = value;
    },
    getHeader(key: string) {
      return this._headers[key];
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      this.statusCode = status;
      if (headers) Object.assign(this._headers, headers);
    },
    end(body?: string) {
      if (body) this._body = body;
    },
  };
  return res as unknown as http.ServerResponse & MockRes;
}

function createDeps(workspaceRoot: string): CloudServiceDeps {
  return {
    getSettings: () => ({ coreDirectory: workspaceRoot }),
  } as unknown as CloudServiceDeps;
}

describe('handleLibrary upload-file security', () => {
  let tempRoot: string;
  let workspacePath: string;
  let outsidePath: string;
  let previousWorkspaceFileSystem: ReturnType<typeof getWorkspaceFileSystem>;

  beforeEach(async () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rebel-library-route-'));
    workspacePath = path.join(tempRoot, 'workspace');
    outsidePath = path.join(tempRoot, 'outside');

    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(outsidePath, { recursive: true });
    previousWorkspaceFileSystem = getWorkspaceFileSystem();
    setWorkspaceFileSystemFactory(() => new CloudWorkspaceFileSystem());
  });

  afterEach(async () => {
    setWorkspaceFileSystemFactory(() => previousWorkspaceFileSystem);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('rejects symlink escape writes via upload-file', async () => {
    const symlinkPath = path.join(workspacePath, 'escaped');

    try {
      await fs.symlink(outsidePath, symlinkPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'EPERM' || nodeError.code === 'EACCES' || nodeError.code === 'ENOTSUP') {
        return;
      }
      throw error;
    }

    const req = createMockReq(
      {
        path: 'escaped/owned.txt',
        content: Buffer.from('owned').toString('base64'),
        encoding: 'base64',
      },
      'upload-file',
    );
    const res = createMockRes();

    await handleLibrary(req, res, ['api', 'library', 'upload-file'], createDeps(workspacePath));

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toMatchObject({
      error: {
        code: 'INVALID_PATH',
      },
    });
    await expect(fs.readFile(path.join(outsidePath, 'owned.txt'), 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('handleLibrary GET /files', () => {
  function createFilesDeps(listFiles: () => Promise<unknown>): CloudServiceDeps {
    return {
      getSettings: () => ({ coreDirectory: '/data/workspace' }),
      listFiles,
    } as unknown as CloudServiceDeps;
  }

  it('returns the shallow listing on success', async () => {
    const payload = { entries: [{ name: 'a.md', kind: 'file' }] };
    const req = createMockReq(undefined, 'files', 'GET');
    const res = createMockRes();

    await handleLibrary(
      req,
      res,
      ['api', 'library', 'files'],
      createFilesDeps(async () => payload),
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toMatchObject(payload);
  });

  it('surfaces a listing failure as LIST_FILES_FAILED (not an empty/complete dir)', async () => {
    const req = createMockReq(undefined, 'files', 'GET');
    const res = createMockRes();

    await handleLibrary(
      req,
      res,
      ['api', 'library', 'files'],
      createFilesDeps(async () => {
        throw new Error('EACCES: permission denied');
      }),
    );

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({
      error: { code: 'LIST_FILES_FAILED' },
    });
  });
});
