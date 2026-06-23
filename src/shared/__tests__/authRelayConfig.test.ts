import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELAY_PROVIDERS,
  isSafeRelativePath,
  resolveProviderBasePath,
} from '../authRelayConfig';

describe('authRelayConfig', () => {
  describe('RELAY_PROVIDERS', () => {
    it('contains the expected provider set', () => {
      expect(RELAY_PROVIDERS).toEqual([
        'super-mcp',
        'freshdesk',
        'google-workspace',
        'slack',
        'hubspot',
        'salesforce',
        'microsoft',
      ]);
    });
  });

  describe('resolveProviderBasePath', () => {
    const dataPath = '/app/data';
    const homeDir = '/Users/tester';

    it('resolves super-mcp under the user home directory', () => {
      expect(resolveProviderBasePath('super-mcp', dataPath, homeDir)).toBe(
        path.join(homeDir, '.super-mcp', 'oauth-tokens'),
      );
    });

    it('resolves OAuth providers under the app data path', () => {
      expect(resolveProviderBasePath('freshdesk', dataPath, homeDir)).toBe(
        path.join(dataPath, 'mcp', 'freshdesk'),
      );
      expect(resolveProviderBasePath('google-workspace', dataPath, homeDir)).toBe(
        path.join(dataPath, 'google-workspace-mcp'),
      );
      expect(resolveProviderBasePath('slack', dataPath, homeDir)).toBe(path.join(dataPath, 'mcp', 'slack'));
    });
  });

  describe('isSafeRelativePath', () => {
    it('rejects empty, absolute, colon-based, and traversal paths', () => {
      expect(isSafeRelativePath('')).toBe(false);
      expect(isSafeRelativePath('   ')).toBe(false);
      expect(isSafeRelativePath('/absolute/path')).toBe(false);
      expect(isSafeRelativePath('C:\\Windows\\System32')).toBe(false);
      expect(isSafeRelativePath('mcp:slack/token.json')).toBe(false);
      expect(isSafeRelativePath('../secrets/token.json')).toBe(false);
      expect(isSafeRelativePath('nested/../../secrets/token.json')).toBe(false);
      expect(isSafeRelativePath('nested\\..\\secrets\\token.json')).toBe(false);
    });

    it('accepts valid nested relative paths', () => {
      expect(isSafeRelativePath('google-workspace-mcp/credentials.json')).toBe(true);
      expect(isSafeRelativePath('mcp/slack/token.json')).toBe(true);
      expect(isSafeRelativePath('nested\\folder\\token.json')).toBe(true);
    });
  });
});
