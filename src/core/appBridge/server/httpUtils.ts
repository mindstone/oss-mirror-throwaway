/**
 * httpUtils — shared helpers for bridge HTTP route handlers (Stage 2).
 *
 * Small, internal-only utilities so every router renders JSON, reads JSON
 * bodies, and translates `AppBridgeError`s consistently.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createAppBridgeError,
  ErrorCode,
  type AppBridgeError,
} from '../shared/errors';

/**
 * Router signature used by every bridge sub-router: return `true` if the
 * router served the request, `false` to fall through to the next router or
 * the bridge's catch-all 404.
 */
export type RouterHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

/** Max JSON body size we'll ever parse. Aligns with R33 / D28 envelope. */
const MAX_BODY_BYTES = 500_000;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isAppBridgeError(value: unknown): value is AppBridgeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AppBridgeError).code === 'string' &&
    typeof (value as AppBridgeError).status === 'number' &&
    typeof (value as AppBridgeError).message === 'string'
  );
}

export function applyErrorResponse(res: ServerResponse, err: unknown): void {
  if (isAppBridgeError(err)) {
    sendJson(res, err.status, {
      success: false,
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  const fallback = createAppBridgeError(
    ErrorCode.INTERNAL_ERROR,
    'An unexpected error occurred while handling the request.',
  );
  sendJson(res, fallback.status, {
    success: false,
    code: fallback.code,
    message: fallback.message,
  });
}

export async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    // Fast-path reject if the caller already aborted/destroyed the
    // request before we started reading. Without this check a promise
    // created here would never receive a `data`/`end`/`close` event and
    // would hang until the process exits. See
    // docs-private/investigations/260423_tofu_vs_claim_timeout_bug.md for the
    // resilience hardening that motivated this branch.
    if (req.destroyed || req.aborted === true) {
      reject(
        createAppBridgeError(
          ErrorCode.BAD_REQUEST,
          'Request was aborted before the body could be read.',
        ),
      );
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    // Collect every listener we attach so a single `cleanup()` call can
    // remove all of them without repeating the event names twice.
    // Defining the registry BEFORE the handlers keeps the lint rule
    // `no-use-before-define` happy (handlers push into this array; no
    // handler references another by name).
    //
    // Node's EventEmitter signature is `(...args: any[]) => void`, so we
    // keep the storage type permissive and cast each handler once at
    // attach time rather than polluting the per-handler types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches EventEmitter
    type AnyListener = (...args: any[]) => void;
    const listeners: Array<{ event: string; fn: AnyListener }> = [];
    const cleanup = (): void => {
      for (const { event, fn } of listeners) {
        req.off(event, fn);
      }
      listeners.length = 0;
    };

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > MAX_BODY_BYTES) {
        cleanup();
        settled = true;
        reject(
          createAppBridgeError(
            ErrorCode.BAD_REQUEST,
            `Request body exceeds ${MAX_BODY_BYTES} bytes.`,
          ),
        );
        req.destroy();
        return;
      }
      chunks.push(buf);
    };

    const onError = (err: Error): void => {
      if (settled) return;
      cleanup();
      settled = true;
      reject(err);
    };

    const onAbort = (): void => {
      if (settled) return;
      cleanup();
      settled = true;
      reject(
        createAppBridgeError(
          ErrorCode.BAD_REQUEST,
          'Request was aborted before the body could be read.',
        ),
      );
    };

    const onEnd = (): void => {
      if (settled) return;
      cleanup();
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(
            createAppBridgeError(
              ErrorCode.BAD_REQUEST,
              'Request body must be a JSON object.',
            ),
          );
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(
          createAppBridgeError(
            ErrorCode.BAD_REQUEST,
            'Request body is not valid JSON.',
          ),
        );
      }
    };

    // `'close'` fires when the underlying socket closes before `'end'`
    // was emitted (i.e. the caller aborted mid-body). `'aborted'` is the
    // IncomingMessage-specific signal retained for older Node versions.
    // Keeping both handlers attached covers every release line we
    // support.
    const subscribe = (event: string, fn: AnyListener): void => {
      listeners.push({ event, fn });
      req.on(event, fn);
    };
    subscribe('data', onData as AnyListener);
    subscribe('error', onError as AnyListener);
    subscribe('end', onEnd as AnyListener);
    subscribe('close', onAbort as AnyListener);
    subscribe('aborted', onAbort as AnyListener);
  });
}

export function extractBearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return '';
  }
  return header.replace(/^Bearer\s+/i, '').trim();
}
