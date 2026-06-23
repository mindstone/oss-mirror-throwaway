/**
 * HTTP utility functions shared across route handlers.
 */

import http from 'node:http';
import { promisify } from 'node:util';
import { gzip as gzipWithCallback, gunzip as gunzipWithCallback } from 'node:zlib';
import { createScopedLogger } from '@core/logger';
import { CLOUD_ERROR_CATALOG, type CloudErrorCode } from '@core/services/cloudErrorCatalog';
import { fireAndForget } from '@shared/utils/fireAndForget';

const cloudLog = createScopedLogger({ service: 'rebel-cloud' });
const gzip = promisify(gzipWithCallback);
const gunzip = promisify(gunzipWithCallback);
const GZIP_THRESHOLD_BYTES = 4 * 1024;

/**
 * Structured logger for cloud service.
 * Backward-compatible wrapper around @core/logger (pino).
 * Accepts { level, msg, ...context } and delegates to the pino logger.
 */
export function log(obj: Record<string, unknown>): void {
  const { level = 'info', msg = '', ...rest } = obj;
  const message = String(msg);
  switch (level) {
    case 'fatal': cloudLog.fatal(rest, message); break;
    case 'error': cloudLog.error(rest, message); break;
    case 'warn': cloudLog.warn(rest, message); break;
    case 'debug': cloudLog.debug(rest, message); break;
    default: cloudLog.info(rest, message); break;
  }
}

function requestAcceptsGzip(req: http.IncomingMessage): boolean {
  const acceptEncoding = req.headers['accept-encoding'];
  if (!acceptEncoding) return false;
  const encodingValue = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
  return /\bgzip\b/i.test(encodingValue);
}

function getVaryHeader(res: http.ServerResponse): string {
  const existing = res.getHeader('Vary');
  const varyValues = (
    Array.isArray(existing) ? existing.map((value) => String(value)).join(',')
      : typeof existing === 'string' ? existing
        : existing == null ? ''
          : String(existing)
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!varyValues.some((value) => value.toLowerCase() === 'accept-encoding')) {
    varyValues.push('Accept-Encoding');
  }
  return varyValues.join(', ');
}

function writeJsonResponse(
  res: http.ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  const contentLength = Buffer.isBuffer(body) ? body.byteLength : Buffer.byteLength(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(contentLength),
    ...headers,
  });
  res.end(body);
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  data: unknown,
  req?: http.IncomingMessage,
): void {
  const body = JSON.stringify(data);
  const bodySizeBytes = Buffer.byteLength(body);
  const shouldCompress = Boolean(
    req
    && bodySizeBytes >= GZIP_THRESHOLD_BYTES
    && requestAcceptsGzip(req),
  );

  if (!shouldCompress) {
    writeJsonResponse(res, status, body);
    return;
  }

  fireAndForget(
    gzip(Buffer.from(body))
      .then((compressedBody) => {
        writeJsonResponse(res, status, compressedBody, {
          'Content-Encoding': 'gzip',
          Vary: getVaryHeader(res),
        });
      })
      .catch((error: unknown) => {
        log({
          level: 'error',
          msg: 'Failed to gzip JSON response; sending uncompressed fallback',
          status,
          payloadSizeBytes: bodySizeBytes,
          error: error instanceof Error ? error.message : String(error),
        });
        writeJsonResponse(res, status, body);
      }),
    'cloud.httpUtils.sendJson.gzip',
  );
}

export function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export interface RouteErrorOptions {
  message?: string;
  status?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class RouteError extends Error {
  public readonly code: CloudErrorCode;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;
  public readonly cause?: unknown;

  constructor(code: CloudErrorCode, options: RouteErrorOptions = {}) {
    const entry = CLOUD_ERROR_CATALOG[code];
    if (!entry) {
      throw new Error(`RouteError: unknown error code "${String(code)}"`);
    }
    if (options.details && Object.prototype.hasOwnProperty.call(options.details, 'error')) {
      throw new Error('RouteError details cannot contain "error" key');
    }
    super(options.message ?? entry.defaultMessage);
    this.name = 'RouteError';
    this.code = code;
    this.status = options.status ?? entry.defaultStatus;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function sendRouteError(
  res: http.ServerResponse,
  _req: http.IncomingMessage | undefined,
  err: RouteError,
): void {
  const body = err.details
    ? { error: { code: err.code, message: err.message }, ...err.details }
    : { error: { code: err.code, message: err.message } };
  sendJson(res, err.status, body);
}

const MAX_BODY_SIZE = 100 * 1024 * 1024; // 100MB — raised from 25MB per Stage A4 of cloud sync reconciliation hardening (260518). Stage A5 byte-budgeted chunking ensures no single request approaches this cap in normal operation; this is defense in depth for the legacy pushFullSession recovery paths until Stage C retires them.

export function readBody(req: http.IncomingMessage): Promise<unknown> {
  const isGzip = req.headers['content-encoding']?.toLowerCase() === 'gzip';

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        rejected = true;
        req.removeAllListeners('data');
        req.resume();
        reject(new RouteError('BODY_TOO_LARGE', {
          status: 413,
          message: `Request body exceeds ${MAX_BODY_SIZE / (1024 * 1024)}MB limit`,
        }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!rejected) reject(err); });
  }).then(async (raw) => {
    let bytes: Buffer;
    if (isGzip) {
      try {
        bytes = await gunzip(raw, { maxOutputLength: MAX_BODY_SIZE });
      } catch (err) {
        const errCode = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
        if (errCode === 'ERR_BUFFER_TOO_LARGE' || (err instanceof Error && err.message.includes('buffer too large'))) {
          throw new RouteError('BODY_TOO_LARGE', {
            status: 413,
            message: `Decompressed request body exceeds ${MAX_BODY_SIZE / (1024 * 1024)}MB limit`,
          });
        }
        throw err;
      }
    } else {
      bytes = raw;
    }
    const text = bytes.toString('utf-8');
    return text ? JSON.parse(text) : null;
  });
}

/**
 * Read the raw request body as a Buffer (for HMAC signature verification).
 * Returns both raw bytes and parsed JSON.
 */
export function readRawBody(req: http.IncomingMessage): Promise<{ raw: Buffer; parsed: unknown }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        rejected = true;
        req.removeAllListeners('data');
        req.resume();
        reject(new RouteError('BODY_TOO_LARGE', {
          status: 413,
          message: `Request body exceeds ${MAX_BODY_SIZE / (1024 * 1024)}MB limit`,
        }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf-8');
        resolve({ raw, parsed: text ? JSON.parse(text) : null });
      } catch {
        reject(new Error('Invalid JSON in request body'));
      }
    });
    req.on('error', (err) => { if (!rejected) reject(err); });
  });
}

export function parsePath(url: string | undefined): string[] {
  return (url || '').split('?')[0].split('/').filter(Boolean);
}
