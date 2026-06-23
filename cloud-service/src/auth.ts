/**
 * Authentication utilities for the cloud service.
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { log } from './httpUtils';

export const AUTH_TOKEN = process.env.REBEL_CLOUD_TOKEN || process.env.REBEL_BRIDGE_TOKEN || '';

export function extractBearerTokenFromAuthorizationHeader(
  header: string | string[] | undefined,
): string | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  const [scheme, token] = raw.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

export function bearerTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function getBearerTokenHash(req: http.IncomingMessage): string | null {
  const token = extractBearerTokenFromAuthorizationHeader(req.headers.authorization);
  return token ? bearerTokenHash(token) : null;
}

export function authorize(req: http.IncomingMessage): boolean {
  if (!AUTH_TOKEN) {
    if (process.env.NODE_ENV === 'production') {
      log({ level: 'error', msg: 'REBEL_CLOUD_TOKEN not set in production mode - rejecting all requests' });
      return false;
    }
    return true; // No token configured = open (dev mode only)
  }
  const token = extractBearerTokenFromAuthorizationHeader(req.headers.authorization);
  if (!token) return false;
  // Timing-safe comparison to prevent timing attacks
  if (token.length !== AUTH_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
}
