/**
 * Tests for Microsoft 365 OAuth scope preservation on reconnection (FOX-2581).
 *
 * TDD approach:
 * - Pure function tests (parseScopes, validateScopeExpansion) pass before and after the fix
 * - getExtraScopesForAccount tests FAIL until the fix exports the function
 * - Reconnection scenario tests verify the decision logic
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted runs before vi.mock hoisting, so mocks can reference these
const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/fake-userdata' },
  shell: { openExternal: vi.fn() },
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mockReadFile,
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
  },
}));

import {
  parseScopes,
  validateScopeExpansion,
  MICROSOFT_BASE_SCOPES,
} from '../microsoftAuthService';

// ---------------------------------------------------------------------------
// parseScopes
// ---------------------------------------------------------------------------
describe('parseScopes', () => {
  it('parses space-delimited scopes into a lowercase set', () => {
    const scopes = parseScopes('User.Read Mail.Read Files.ReadWrite');
    expect(scopes).toEqual(new Set(['user.read', 'mail.read', 'files.readwrite']));
  });

  it('handles mixed casing', () => {
    const scopes = parseScopes('SITES.READ.ALL user.read');
    expect(scopes.has('sites.read.all')).toBe(true);
    expect(scopes.has('user.read')).toBe(true);
  });

  it('handles empty string', () => {
    expect(parseScopes('').size).toBe(0);
  });

  it('handles extra whitespace', () => {
    expect(parseScopes('  User.Read   Mail.Read  ').size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// validateScopeExpansion
// ---------------------------------------------------------------------------
describe('validateScopeExpansion', () => {
  it('returns true when new scopes are a superset', () => {
    expect(validateScopeExpansion('User.Read Files.ReadWrite', 'User.Read Files.ReadWrite Sites.Read.All')).toBe(true);
  });

  it('returns true when scopes are identical', () => {
    expect(validateScopeExpansion('User.Read Files.ReadWrite', 'User.Read Files.ReadWrite')).toBe(true);
  });

  it('returns false when new scopes lose an existing scope', () => {
    expect(validateScopeExpansion('User.Read Files.ReadWrite Sites.Read.All', 'User.Read Files.ReadWrite')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(validateScopeExpansion('sites.read.all', 'SITES.READ.ALL User.Read')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getExtraScopesForAccount (requires the fix to export this function)
// ---------------------------------------------------------------------------
describe('getExtraScopesForAccount', () => {
  beforeEach(() => {
    mockReadFile.mockReset().mockRejectedValue(new Error('ENOENT'));
  });

  it('is exported from microsoftAuthService', async () => {
    const mod = await import('../microsoftAuthService');
    expect(mod.getExtraScopesForAccount).toBeDefined();
    expect(typeof mod.getExtraScopesForAccount).toBe('function');
  });

  it('returns empty array when no token file exists', async () => {
    const { getExtraScopesForAccount } = await import('../microsoftAuthService');
    const extras = await getExtraScopesForAccount('nobody@example.com');
    expect(extras).toEqual([]);
  });

  it('returns empty array when token has only base scopes', async () => {
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('.token.json')) {
        return JSON.stringify({
          access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3600000,
          token_type: 'Bearer', scope: MICROSOFT_BASE_SCOPES.join(' '),
        });
      }
      throw new Error('ENOENT');
    });

    const { getExtraScopesForAccount } = await import('../microsoftAuthService');
    const extras = await getExtraScopesForAccount('user@example.com');
    expect(extras).toEqual([]);
  });

  it('returns Sites.Read.All when token has SharePoint scopes', async () => {
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('.token.json')) {
        return JSON.stringify({
          access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3600000,
          token_type: 'Bearer', scope: [...MICROSOFT_BASE_SCOPES, 'Sites.Read.All'].join(' '),
        });
      }
      throw new Error('ENOENT');
    });

    const { getExtraScopesForAccount } = await import('../microsoftAuthService');
    const extras = await getExtraScopesForAccount('[external-email]');
    expect(extras).toEqual(['Sites.Read.All']);
  });

  it('returns multiple extra scopes', async () => {
    mockReadFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('.token.json')) {
        return JSON.stringify({
          access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3600000,
          token_type: 'Bearer', scope: [...MICROSOFT_BASE_SCOPES, 'Sites.Read.All', 'Files.ReadWrite.All'].join(' '),
        });
      }
      throw new Error('ENOENT');
    });

    const { getExtraScopesForAccount } = await import('../microsoftAuthService');
    const extras = await getExtraScopesForAccount('[external-email]');
    expect(extras).toContain('Sites.Read.All');
    expect(extras).toContain('Files.ReadWrite.All');
    expect(extras).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Reconnection scenario tests (FOX-2581 regression)
// ---------------------------------------------------------------------------

function getExtraScopes(scopeString: string, baseScopes: string[]): string[] {
  const baseSet = new Set(baseScopes.map((s) => s.toLowerCase()));
  const extras: string[] = [];
  for (const scope of scopeString.split(' ')) {
    const trimmed = scope.trim();
    if (trimmed && !baseSet.has(trimmed.toLowerCase())) extras.push(trimmed);
  }
  return extras;
}

function simulateReconnectionDecision(
  accounts: Array<{ email: string; status: 'active' | 'expired' | 'error'; storedScopes: string }>,
) {
  const existingAccount = accounts.find((a) => a.status === 'active') ?? accounts[0];
  let additionalScopes: string[] | undefined;
  let loginHint: string | undefined;

  if (existingAccount) {
    const extras = getExtraScopes(existingAccount.storedScopes, MICROSOFT_BASE_SCOPES);
    if (extras.length > 0) {
      additionalScopes = extras;
      loginHint = existingAccount.email;
    }
  }

  const requestedScopes = additionalScopes
    ? [...new Set([...MICROSOFT_BASE_SCOPES, ...additionalScopes])]
    : [...MICROSOFT_BASE_SCOPES];

  return { additionalScopes, loginHint, requestedScopes };
}

describe('Reconnection scenarios (FOX-2581)', () => {
  const ORG_SCOPES = [...MICROSOFT_BASE_SCOPES, 'Sites.Read.All', 'Files.ReadWrite.All'].join(' ');
  const BASE_ONLY_SCOPES = MICROSOFT_BASE_SCOPES.join(' ');

  describe('BUG REPRODUCTION: reconnection without fix loses org scopes', () => {
    it('reconnecting with base scopes only would lose Sites.Read.All', () => {
      const newTokenScopes = [...MICROSOFT_BASE_SCOPES].join(' ');
      expect(validateScopeExpansion(ORG_SCOPES, newTokenScopes)).toBe(false);
    });

    it('if Microsoft returns all admin-consented scopes anyway, no regression detected', () => {
      const newTokenScopes = [...MICROSOFT_BASE_SCOPES, 'Sites.Read.All', 'Files.ReadWrite.All'].join(' ');
      expect(validateScopeExpansion(ORG_SCOPES, newTokenScopes)).toBe(true);
    });
  });

  describe('FIX VERIFICATION: reconnection now preserves org scopes', () => {
    it('reconnecting with active account that has org scopes preserves them', () => {
      const result = simulateReconnectionDecision([
        { email: '[external-email]', status: 'active', storedScopes: ORG_SCOPES },
      ]);
      expect(result.additionalScopes).toContain('Sites.Read.All');
      expect(result.additionalScopes).toContain('Files.ReadWrite.All');
      expect(result.loginHint).toBe('[external-email]');
      expect(validateScopeExpansion(ORG_SCOPES, result.requestedScopes.join(' '))).toBe(true);
    });

    it('reconnecting with expired account still preserves scopes', () => {
      const result = simulateReconnectionDecision([
        { email: '[external-email]', status: 'expired', storedScopes: ORG_SCOPES },
      ]);
      expect(result.additionalScopes).toContain('Sites.Read.All');
      expect(result.loginHint).toBe('[external-email]');
    });

    it('reconnecting with error account still preserves scopes', () => {
      const result = simulateReconnectionDecision([
        { email: '[external-email]', status: 'error', storedScopes: ORG_SCOPES },
      ]);
      expect(result.additionalScopes).toContain('Sites.Read.All');
    });

    it('first-time connection (no accounts) requests only base scopes', () => {
      const result = simulateReconnectionDecision([]);
      expect(result.additionalScopes).toBeUndefined();
      expect(result.loginHint).toBeUndefined();
      expect(result.requestedScopes).toEqual(MICROSOFT_BASE_SCOPES);
    });

    it('reconnecting with only base scopes does not add extras', () => {
      const result = simulateReconnectionDecision([
        { email: '[external-email]', status: 'active', storedScopes: BASE_ONLY_SCOPES },
      ]);
      expect(result.additionalScopes).toBeUndefined();
      expect(result.loginHint).toBeUndefined();
    });

    it('prefers active account over expired when both exist', () => {
      const result = simulateReconnectionDecision([
        { email: '[external-email]', status: 'expired', storedScopes: BASE_ONLY_SCOPES },
        { email: '[external-email]', status: 'active', storedScopes: ORG_SCOPES },
      ]);
      expect(result.loginHint).toBe('[external-email]');
      expect(result.additionalScopes).toContain('Sites.Read.All');
    });

    it('falls back to first expired account when no active accounts', () => {
      const result = simulateReconnectionDecision([
        { email: '[external-email]', status: 'expired', storedScopes: ORG_SCOPES },
        { email: '[external-email]', status: 'expired', storedScopes: BASE_ONLY_SCOPES },
      ]);
      expect(result.loginHint).toBe('[external-email]');
      expect(result.additionalScopes).toContain('Sites.Read.All');
    });
  });

  describe('Scope round-trip: preserved scopes survive validateScopeExpansion', () => {
    it('reconnection with preserved SharePoint scopes passes validation', () => {
      const existingScopes = [...MICROSOFT_BASE_SCOPES, 'Sites.Read.All'].join(' ');
      const result = simulateReconnectionDecision([
        { email: '[external-email]', status: 'active', storedScopes: existingScopes },
      ]);
      expect(validateScopeExpansion(existingScopes, result.requestedScopes.join(' '))).toBe(true);
    });

    it('reconnection with multiple extra scopes passes validation', () => {
      const existingScopes = [...MICROSOFT_BASE_SCOPES, 'Sites.Read.All', 'Sites.ReadWrite.All', 'Files.ReadWrite.All'].join(' ');
      const result = simulateReconnectionDecision([
        { email: '[external-email]', status: 'active', storedScopes: existingScopes },
      ]);
      expect(validateScopeExpansion(existingScopes, result.requestedScopes.join(' '))).toBe(true);
    });
  });
});
