/**
 * Utility functions for Meeting Bot Worker
 */

import type { Env, SessionTokenPayload } from './types';

// Canonical extractMeetingId from shared package (bundled by wrangler/esbuild)
export { extractMeetingId } from '../../packages/shared/src/utils/extractMeetingId';

/**
 * Hash a string using SHA-256
 */
export async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hash a meeting URL, normalizing it first to handle variations
 */
export async function hashMeetingUrl(meetingUrl: string): Promise<string> {
  const url = new URL(meetingUrl);
  
  // Remove password and tracking params
  const paramsToRemove = [
    'pwd', 'jst', 'omn', 'zak', 'zc', 'uname',  // Zoom
    'authuser', 'hs',  // Google Meet
    'context',  // Microsoft Teams
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',  // Analytics
  ];
  
  for (const param of paramsToRemove) {
    url.searchParams.delete(param);
  }
  
  url.hash = '';
  const normalized = url.toString().toLowerCase();
  
  return sha256(normalized);
}

/**
 * Generate a bot display name from user's name or custom trigger phrase
 */
export function getBotDisplayName(userName?: string, triggerPhrase?: string | null): string {
  // Use custom trigger phrase if provided
  if (triggerPhrase && typeof triggerPhrase === 'string' && triggerPhrase.trim()) {
    return triggerPhrase.trim().slice(0, 80);
  }
  
  // Default: "{firstName}'s Rebel"
  if (!userName || typeof userName !== 'string') {
    return 'Rebel Mindstone';
  }
  const firstName = userName.trim().split(/\s+/)[0];
  if (!firstName || firstName.length < 2) {
    return 'Rebel Mindstone';
  }
  const truncatedName = firstName.slice(0, 80);
  return `${truncatedName}'s Rebel`;
}

/**
 * Verify HMAC-based user auth header
 */
export async function verifyUserAuth(request: Request, env: Env): Promise<string | null> {
  const authHeader = request.headers.get('X-Mindstone-Auth');
  if (!authHeader) return null;

  const parts = authHeader.split(':');
  if (parts.length !== 3) return null;

  const [userId, timestamp, signature] = parts;
  
  // Check timestamp freshness (5 minute window)
  const ts = parseInt(timestamp, 10);
  const now = Date.now();
  if (isNaN(ts) || Math.abs(now - ts) > 5 * 60 * 1000) {
    return null;
  }

  // Verify HMAC signature
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.MINDSTONE_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signatureData = encoder.encode(`${userId}:${timestamp}`);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, signatureData);
  const expectedSig = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

  if (signature !== expectedSig) return null;
  return userId;
}

const DEFAULT_TOKEN_TTL_SECONDS = 4 * 60 * 60; // 4 hours
const MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours cap

/**
 * Generate a JWT session token for bot access.
 * @param ttlSeconds - Token TTL in seconds (default: 4 hours, max: 24 hours).
 *   For scheduled bots, pass a TTL that covers the time until meeting end
 *   so the avatar token is still valid when Recall opens the avatar webpage.
 */
export async function generateSessionToken(
  botId: string,
  userId: string,
  meetingUrlHash: string,
  role: 'owner' | 'viewer',
  env: Env,
  ttlSeconds: number = DEFAULT_TOKEN_TTL_SECONDS
): Promise<string> {
  const clampedTtl = Math.min(Math.max(ttlSeconds, DEFAULT_TOKEN_TTL_SECONDS), MAX_TOKEN_TTL_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionTokenPayload = {
    botId,
    userId,
    role,
    meetingUrlHash,
    iat: now,
    exp: now + clampedTtl,
  };

  // Create JWT header
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '');
  const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, '');
  
  // Sign
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signatureData = encoder.encode(`${encodedHeader}.${encodedPayload}`);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, signatureData);
  const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verify and decode a JWT session token
 */
export async function verifySessionToken(
  token: string,
  env: Env
): Promise<SessionTokenPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, signature] = parts;
    
    // Verify signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const signatureData = encoder.encode(`${encodedHeader}.${encodedPayload}`);
    const signatureBytes = Uint8Array.from(
      atob(signature.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );
    
    const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, signatureData);
    if (!valid) return null;

    // Decode payload
    const payload = JSON.parse(atob(encodedPayload)) as SessionTokenPayload;
    
    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Add CORS headers to response
 */
export function addCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Handle CORS preflight
 */
export function handleCors(): Response {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Mindstone-Auth, X-Client-Secret',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/**
 * Create JSON response with proper typing
 */
export function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
