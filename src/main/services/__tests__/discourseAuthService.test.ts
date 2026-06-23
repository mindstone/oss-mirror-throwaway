import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { publicEncrypt, constants } from 'node:crypto';

// Mock electron before importing the service
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  app: { getPath: vi.fn().mockReturnValue('/tmp/test-userdata') },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

vi.mock('../oauthPrimitives', () => ({
  bringAppToForeground: vi.fn(),
}));

vi.mock('../bundledMcpManager', () => ({
  writeDiscourseUserApiProfile: vi.fn().mockResolvedValue('/tmp/test-profile.json'),
  buildDiscourseWritePayload: vi.fn().mockReturnValue({ name: 'test' }),
}));

import {
  startDiscourseAuth,
  handleDiscourseAuthCallback,
  cancelDiscourseAuth,
} from '../discourseAuthService';
import { shell } from 'electron';

describe('discourseAuthService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Cancel any lingering auth, swallowing the expected rejection
    cancelDiscourseAuth();
  });

  afterEach(() => {
    cancelDiscourseAuth();
    vi.unstubAllEnvs();
  });

  // Helper: start auth and attach a .catch to prevent unhandled rejection in cleanup
  function startAuthWithCatch(siteUrl: string) {
    const result = startDiscourseAuth(siteUrl);
    result.completion.catch(() => { /* expected rejection during cleanup */ });
    return result;
  }

  describe('startDiscourseAuth', () => {
    it('opens browser with correct auth URL params', () => {
      const { authUrl } = startAuthWithCatch('https://rebels.mindstone.com');
      const parsed = new URL(authUrl);

      expect(parsed.origin + parsed.pathname).toBe('https://rebels.mindstone.com/user-api-key/new');
      expect(parsed.searchParams.get('auth_redirect')).toBe('https://rebel-auth.mindstone.com/discourse/callback');
      expect(parsed.searchParams.get('application_name')).toBe('Mindstone Rebel');
      expect(parsed.searchParams.get('scopes')).toBe('read,write');
      expect(parsed.searchParams.get('padding')).toBe('oaep');
      expect(parsed.searchParams.get('public_key')).toContain('BEGIN PUBLIC KEY');
      expect(parsed.searchParams.get('nonce')).toBeTruthy();
      expect(parsed.searchParams.get('client_id')).toContain('mindstone-rebel-');

      expect(shell.openExternal).toHaveBeenCalledWith(authUrl);
    });

    it('uses DISCOURSE_REDIRECT_URI when configured', () => {
      vi.stubEnv('DISCOURSE_REDIRECT_URI', 'https://example.test/discourse/callback');

      const { authUrl } = startAuthWithCatch('https://rebels.mindstone.com');
      const parsed = new URL(authUrl);

      expect(parsed.searchParams.get('auth_redirect')).toBe(
        'https://example.test/discourse/callback',
      );
    });

    it('cancels previous pending auth when starting new one', async () => {
      const first = startDiscourseAuth('https://rebels.mindstone.com');
      first.completion.catch(() => { /* expected */ });
      const second = startAuthWithCatch('https://rebels.mindstone.com');

      await expect(first.completion).rejects.toThrow('Auth cancelled by user');
      expect(second.authUrl).toBeTruthy();
    });
  });

  describe('handleDiscourseAuthCallback', () => {
    it('decrypts payload and saves user API key profile', async () => {
      const { writeDiscourseUserApiProfile } = await import('../bundledMcpManager');

      // Start auth to capture the public key
      const { authUrl, completion } = startDiscourseAuth('https://rebels.mindstone.com');
      const parsed = new URL(authUrl);
      const publicKeyPem = parsed.searchParams.get('public_key')!;
      const nonce = parsed.searchParams.get('nonce')!;

      // Simulate Discourse encrypting a response with our public key
      const responsePayload = JSON.stringify({
        key: 'test-user-api-key-12345',
        nonce,
        username: 'testuser',
      });

      const encrypted = publicEncrypt(
        { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        Buffer.from(responsePayload)
      );
      const base64Payload = encrypted.toString('base64');

      // Handle the callback
      await handleDiscourseAuthCallback(
        `mindstone://discourse/callback?payload=${encodeURIComponent(base64Payload)}`
      );

      const result = await completion;
      expect(result.username).toBe('testuser');
      expect(writeDiscourseUserApiProfile).toHaveBeenCalledWith('discourse-write', {
        siteUrl: 'https://rebels.mindstone.com',
        userApiKey: 'test-user-api-key-12345',
        userApiClientId: expect.stringContaining('mindstone-rebel-'),
      });
    });

    it('handles base64 payload with spaces (+ converted to space)', async () => {
      const { authUrl, completion } = startDiscourseAuth('https://rebels.mindstone.com');
      const parsed = new URL(authUrl);
      const publicKeyPem = parsed.searchParams.get('public_key')!;
      const nonce = parsed.searchParams.get('nonce')!;

      const responsePayload = JSON.stringify({
        key: 'another-user-api-key',
        nonce,
        username: 'anotheruser',
      });

      const encrypted = publicEncrypt(
        { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        Buffer.from(responsePayload)
      );
      // Simulate + being converted to space in URL redirect chain
      const base64WithSpaces = encrypted.toString('base64').replace(/\+/g, ' ');

      await handleDiscourseAuthCallback(
        `mindstone://discourse/callback?payload=${encodeURIComponent(base64WithSpaces)}`
      );

      const result = await completion;
      expect(result.username).toBe('anotheruser');
    });

    it('rejects when nonce does not match', async () => {
      const { authUrl, completion } = startDiscourseAuth('https://rebels.mindstone.com');
      completion.catch(() => { /* expected rejection */ });
      const parsed = new URL(authUrl);
      const publicKeyPem = parsed.searchParams.get('public_key')!;

      const responsePayload = JSON.stringify({
        key: 'some-key',
        nonce: 'wrong-nonce',
        username: 'badactor',
      });

      const encrypted = publicEncrypt(
        { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        Buffer.from(responsePayload)
      );
      const base64Payload = encrypted.toString('base64');

      await handleDiscourseAuthCallback(
        `mindstone://discourse/callback?payload=${encodeURIComponent(base64Payload)}`
      );

      await expect(completion).rejects.toThrow('Security validation failed');
    });

    it('rejects when nonce is missing from response', async () => {
      const { authUrl, completion } = startDiscourseAuth('https://rebels.mindstone.com');
      completion.catch(() => { /* expected rejection */ });
      const parsed = new URL(authUrl);
      const publicKeyPem = parsed.searchParams.get('public_key')!;

      const responsePayload = JSON.stringify({
        key: 'some-key',
        username: 'someone',
        // nonce intentionally omitted
      });

      const encrypted = publicEncrypt(
        { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
        Buffer.from(responsePayload)
      );
      const base64Payload = encrypted.toString('base64');

      await handleDiscourseAuthCallback(
        `mindstone://discourse/callback?payload=${encodeURIComponent(base64Payload)}`
      );

      await expect(completion).rejects.toThrow('Security validation failed');
    });

    it('rejects when no payload parameter', async () => {
      const { completion } = startDiscourseAuth('https://rebels.mindstone.com');
      completion.catch(() => { /* expected rejection */ });

      await handleDiscourseAuthCallback('mindstone://discourse/callback');

      await expect(completion).rejects.toThrow('No payload received');
    });

    it('ignores callback when no auth is pending', async () => {
      await handleDiscourseAuthCallback(
        'mindstone://discourse/callback?payload=garbage'
      );
    });

    it('rejects on invalid encrypted payload', async () => {
      const { completion } = startDiscourseAuth('https://rebels.mindstone.com');
      completion.catch(() => { /* expected rejection */ });

      await handleDiscourseAuthCallback(
        'mindstone://discourse/callback?payload=not-valid-base64-encrypted-data'
      );

      await expect(completion).rejects.toThrow('Failed to decrypt');
    });
  });

  describe('cancelDiscourseAuth', () => {
    it('rejects pending auth with cancellation error', async () => {
      const { completion } = startDiscourseAuth('https://rebels.mindstone.com');
      completion.catch(() => { /* expected rejection */ });
      cancelDiscourseAuth();
      await expect(completion).rejects.toThrow('Auth cancelled by user');
    });

    it('does nothing when no auth is pending', () => {
      expect(() => cancelDiscourseAuth()).not.toThrow();
    });
  });
});
