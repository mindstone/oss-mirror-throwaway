/**
 * Discourse Auth Service
 *
 * Handles Discourse User API Key generation via browser-based auth flow.
 * Flow: Generate RSA keypair → Open browser → User authorizes → Discourse redirects
 *       to Cloudflare worker → Deep link callback → Decrypt payload → Save user API key
 *
 * This uses Discourse's User API Key spec (not Admin API keys), so users can
 * self-service without needing admin involvement.
 *
 * @see https://meta.discourse.org/t/user-api-keys-specification/48536
 */

import { generateKeyPairSync, privateDecrypt, constants, randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { shell } from 'electron';
import { createScopedLogger } from '@core/logger';
import { trackOAuthBrowserOpened } from './oauthTelemetry';
import { bringAppToForeground } from './oauthPrimitives';
import { writeDiscourseUserApiProfile } from './bundledMcpManager';

const log = createScopedLogger({ service: 'discourse-auth' });

const DEFAULT_REDIRECT_URI = 'https://rebel-auth.mindstone.com/discourse/callback';
const APPLICATION_NAME = 'Mindstone Rebel';
const DEFAULT_SCOPES = 'read,write';
const DISCOURSE_PADDING_MODE = 'oaep';
const AUTH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function getRedirectUri(): string {
  return process.env.DISCOURSE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
}

export interface DiscourseAuthResult {
  username: string;
}

let pendingAuth: {
  siteUrl: string;
  privateKey: string;
  nonce: string;
  clientId: string;
  resolve: (result: DiscourseAuthResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
} | null = null;

/**
 * Cancel any pending Discourse auth flow.
 */
export function cancelDiscourseAuth(): void {
  if (pendingAuth) {
    log.info('Cancelling pending Discourse auth');
    clearTimeout(pendingAuth.timeout);
    pendingAuth.reject(new Error('Auth cancelled by user'));
    pendingAuth = null;
  }
}

/**
 * Start Discourse User API Key auth flow.
 * Opens system browser to Discourse authorization page.
 * Returns a promise that resolves when the deep link callback is received.
 */
export function startDiscourseAuth(siteUrl: string): {
  authUrl: string;
  completion: Promise<DiscourseAuthResult>;
} {
  log.info({ siteUrl }, 'Starting Discourse User API Key flow');

  cancelDiscourseAuth();

  // Generate RSA 2048-bit keypair (MUST be 2048, not 4096 - Discourse rejects 4096)
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const nonce = randomBytes(16).toString('hex');
  const clientId = `mindstone-rebel-${randomBytes(8).toString('hex')}`;
  const redirectUri = getRedirectUri();

  const authUrl = new URL(`${siteUrl}/user-api-key/new`);
  authUrl.searchParams.set('auth_redirect', redirectUri);
  authUrl.searchParams.set('application_name', APPLICATION_NAME);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('scopes', DEFAULT_SCOPES);
  authUrl.searchParams.set('public_key', publicKey);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('padding', DISCOURSE_PADDING_MODE);

  const completion = new Promise<DiscourseAuthResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuth) {
        pendingAuth = null;
        reject(new Error('Authorization timed out'));
      }
    }, AUTH_TIMEOUT_MS);

    pendingAuth = { siteUrl, privateKey, nonce, clientId, resolve, reject, timeout };

    shell.openExternal(authUrl.toString()).then(() => {
      trackOAuthBrowserOpened({ connectorName: 'Discourse', connectorType: 'bundled', oauthUrl: authUrl.toString(), callbackMethod: 'deep_link' });
    }).catch((err) => {
      log.error({ err }, 'Failed to open browser for Discourse auth');
      clearTimeout(timeout);
      pendingAuth = null;
      reject(new Error('Failed to open browser for authentication'));
    });
  });

  return { authUrl: authUrl.toString(), completion };
}

/**
 * Handle the OAuth-like callback from the deep link.
 * Called when mindstone://discourse/callback?payload=<encrypted> is received.
 */
export async function handleDiscourseAuthCallback(url: string): Promise<void> {
  if (!pendingAuth) {
    log.warn('Received Discourse auth callback but no auth is pending');
    return;
  }

  const { siteUrl, privateKey, nonce, clientId, resolve, reject, timeout } = pendingAuth;
  pendingAuth = null;
  clearTimeout(timeout);

  try {
    const callbackUrl = new URL(url);
    let payload = callbackUrl.searchParams.get('payload');

    if (!payload) {
      reject(new Error('No payload received from Discourse'));
      return;
    }

    // Fix base64 encoding issues: `+` can be converted to spaces during URL redirects
    payload = payload.replace(/ /g, '+');

    // Decrypt payload with our private key
    const buffer = Buffer.from(payload, 'base64');
    let decrypted: string;
    try {
      decrypted = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        buffer
      ).toString('utf8');
    } catch (decryptErr) {
      log.error({ err: decryptErr }, 'Failed to decrypt Discourse auth payload');
      reject(new Error('Failed to decrypt authorization response. Please try again.'));
      return;
    }

    let result: { key?: string; nonce?: string; username?: string };
    try {
      result = JSON.parse(decrypted);
    } catch {
      log.error('Failed to parse decrypted Discourse auth payload');
      reject(new Error('Failed to decrypt authorization response. Please try again.'));
      return;
    }

    if (!result.key) {
      reject(new Error('Invalid authorization response: missing API key'));
      return;
    }

    // Validate nonce to prevent replay attacks — require exact match
    if (result.nonce !== nonce) {
      log.error('[SECURITY] Discourse auth nonce mismatch or missing - possible replay attack');
      reject(new Error('Security validation failed - please try again'));
      return;
    }

    // Write profile with user_api_key format
    const profileName = 'discourse-write';
    await writeDiscourseUserApiProfile(profileName, {
      siteUrl,
      userApiKey: result.key,
      userApiClientId: clientId,
    });

    log.info({ siteUrl }, 'Discourse User API Key saved successfully');
    bringAppToForeground();
    resolve({ username: result.username || 'authorized-user' });
  } catch (err) {
    log.error({ err }, 'Failed to complete Discourse auth flow');
    reject(err instanceof Error ? err : new Error('Unknown error during Discourse auth'));
  }
}
