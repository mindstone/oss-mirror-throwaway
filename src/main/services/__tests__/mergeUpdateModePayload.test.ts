import { describe, expect, it } from 'vitest';
import type { McpServerConfigDetails, McpServerUpsertPayload } from '@shared/types';
import { mergeUpdateModePayload, type UpdateModeCatalogSetupField } from '../mergeUpdateModePayload';

const INTERNAL_KEYS = new Set(['ACCOUNTS_PATH', 'MINDSTONE_REBEL_BRIDGE_STATE']);

const makeExistingEntry = (
  overrides: Partial<McpServerConfigDetails> = {},
): McpServerConfigDetails => ({
  name: 'Gamma-existing',
  type: null,
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  url: null,
  cwd: null,
  env: null,
  headers: null,
  description: null,
  catalogId: 'bundled-gamma',
  email: 'user@example.com',
  workspace: null,
  lastConnectedAt: 1_700_000_000_000,
  ...overrides,
});

const makePayload = (overrides: Partial<McpServerUpsertPayload> = {}): McpServerUpsertPayload => ({
  name: 'Gamma-new',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  catalogId: 'bundled-gamma',
  email: 'user@example.com',
  env: null,
  headers: null,
  lastConnectedAt: 1_800_000_000_000,
  ...overrides,
});

describe('mergeUpdateModePayload', () => {
  it('merges blank password fields by preserving existing env value', () => {
    const fields: UpdateModeCatalogSetupField[] = [
      { id: 'apiKey', envVar: 'GAMMA_API_KEY' },
    ];

    const merged = mergeUpdateModePayload(
      makeExistingEntry({ env: { GAMMA_API_KEY: 'old-secret' } }),
      makePayload({ env: { GAMMA_API_KEY: '' } }),
      fields,
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({ GAMMA_API_KEY: 'old-secret' });
  });

  it('multi-secret connector preserves existing secret when only one is supplied', () => {
    const fields: UpdateModeCatalogSetupField[] = [
      { id: 'accessKey', envVar: 'KLING_ACCESS_KEY' },
      { id: 'secretKey', envVar: 'KLING_SECRET_KEY' },
    ];

    const merged = mergeUpdateModePayload(
      makeExistingEntry({
        env: {
          KLING_ACCESS_KEY: 'old-access',
          KLING_SECRET_KEY: 'old-secret',
        },
      }),
      makePayload({ env: { KLING_ACCESS_KEY: 'new-access' } }),
      fields,
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({
      KLING_ACCESS_KEY: 'new-access',
      KLING_SECRET_KEY: 'old-secret',
    });
  });

  it('non-blank fields override existing env values', () => {
    const fields: UpdateModeCatalogSetupField[] = [
      { id: 'apiKey', envVar: 'GAMMA_API_KEY' },
    ];

    const merged = mergeUpdateModePayload(
      makeExistingEntry({ env: { GAMMA_API_KEY: 'old-secret' } }),
      makePayload({ env: { GAMMA_API_KEY: 'new-secret' } }),
      fields,
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({ GAMMA_API_KEY: 'new-secret' });
  });

  it('internal env keys never copied from existing entry', () => {
    const fields: UpdateModeCatalogSetupField[] = [
      { id: 'accountsPath', envVar: 'ACCOUNTS_PATH' },
      { id: 'apiKey', envVar: 'GAMMA_API_KEY' },
    ];

    const merged = mergeUpdateModePayload(
      makeExistingEntry({
        env: {
          ACCOUNTS_PATH: '/old/internal/accounts.json',
          GAMMA_API_KEY: 'old-secret',
        },
      }),
      makePayload({ env: {} }),
      fields,
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({ GAMMA_API_KEY: 'old-secret' });
  });

  it('unresolved {{...}} placeholders in existing entry are not preserved (catalog must re-resolve)', () => {
    const fields: UpdateModeCatalogSetupField[] = [
      { id: 'bridgeState', envVar: 'BRIDGE_STATE_PATH' },
      { id: 'apiKey', envVar: 'GAMMA_API_KEY' },
    ];

    const merged = mergeUpdateModePayload(
      makeExistingEntry({
        env: {
          BRIDGE_STATE_PATH: '{{BRIDGE_STATE_PATH}}',
          GAMMA_API_KEY: 'old-secret',
        },
      }),
      makePayload({ env: {} }),
      fields,
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({ GAMMA_API_KEY: 'old-secret' });
  });

  it('lastConnectedAt is preserved from existing entry', () => {
    const merged = mergeUpdateModePayload(
      makeExistingEntry({ lastConnectedAt: 123_456 }),
      makePayload({ lastConnectedAt: 999_999 }),
      [],
      INTERNAL_KEYS,
    );

    expect(merged.lastConnectedAt).toBe(123_456);
  });

  it('email/catalogId are preserved from existing entry', () => {
    const merged = mergeUpdateModePayload(
      makeExistingEntry({
        catalogId: 'existing-catalog',
        email: '[external-email]',
      }),
      makePayload({
        catalogId: 'incoming-catalog',
        email: 'incoming@example.com',
      }),
      [],
      INTERNAL_KEYS,
    );

    expect(merged.catalogId).toBe('existing-catalog');
    expect(merged.email).toBe('[external-email]');
  });

  it('preserves non-catalog user env keys (mergePreservedUserEnv parity)', () => {
    const fields: UpdateModeCatalogSetupField[] = [
      { id: 'apiKey', envVar: 'GAMMA_API_KEY' },
    ];

    const merged = mergeUpdateModePayload(
      makeExistingEntry({
        env: {
          GAMMA_API_KEY: 'old-secret',
          USER_CUSTOM_FLAG: 'true',
          HTTPS_PROXY: 'http://corp.proxy:8080',
        },
      }),
      makePayload({ env: { GAMMA_API_KEY: 'new-secret' } }),
      fields,
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({
      GAMMA_API_KEY: 'new-secret',
      USER_CUSTOM_FLAG: 'true',
      HTTPS_PROXY: 'http://corp.proxy:8080',
    });
  });

  it('catalog-resolved values win over previous env values for the same key', () => {
    const fields: UpdateModeCatalogSetupField[] = [
      { id: 'apiKey', envVar: 'GAMMA_API_KEY' },
    ];

    const merged = mergeUpdateModePayload(
      makeExistingEntry({
        env: {
          GAMMA_API_KEY: 'old-secret',
          // Catalog now controls this key but the existing entry has a stale literal.
          MCP_CONFIG_DIR: '/old/literal/path',
        },
      }),
      // Catalog-resolved value supplied via newPayload.env (no setupField for it).
      makePayload({ env: { GAMMA_API_KEY: '', MCP_CONFIG_DIR: '/resolved/from/catalog' } }),
      fields,
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({
      GAMMA_API_KEY: 'old-secret',
      MCP_CONFIG_DIR: '/resolved/from/catalog',
    });
  });

  it('F-1: user-set RUNWAY_ALLOWED_ROOT survives an update-mode flow', () => {
    const merged = mergeUpdateModePayload(
      makeExistingEntry({
        env: {
          GAMMA_API_KEY: 'old-secret',
          RUNWAY_ALLOWED_ROOT: '/Users/foo/custom-runway',
        },
      }),
      makePayload({
        env: {
          GAMMA_API_KEY: 'new-secret',
          RUNWAY_ALLOWED_ROOT: '/var/folders/tmp',
        },
      }),
      [{ id: 'apiKey', envVar: 'GAMMA_API_KEY' }],
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({
      GAMMA_API_KEY: 'new-secret',
      RUNWAY_ALLOWED_ROOT: '/Users/foo/custom-runway',
    });
  });

  it('F-1: user-set RUNWAY_DOWNLOAD_ROOT survives an update-mode flow', () => {
    const merged = mergeUpdateModePayload(
      makeExistingEntry({
        env: {
          RUNWAY_DOWNLOAD_ROOT: '/Users/foo/custom-downloads',
        },
      }),
      makePayload({
        env: {
          RUNWAY_DOWNLOAD_ROOT: '/var/folders/tmp/runway-mcp',
        },
      }),
      [],
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({
      RUNWAY_DOWNLOAD_ROOT: '/Users/foo/custom-downloads',
    });
  });

  it('F-1: when user has no override the catalog-resolved sandbox value is used', () => {
    const merged = mergeUpdateModePayload(
      makeExistingEntry({ env: {} }),
      makePayload({
        env: {
          RUNWAY_ALLOWED_ROOT: '/var/folders/tmp',
        },
      }),
      [],
      INTERNAL_KEYS,
    );

    expect(merged.env).toEqual({
      RUNWAY_ALLOWED_ROOT: '/var/folders/tmp',
    });
  });

  it('headers merge identically to env', () => {
    const fields: UpdateModeCatalogSetupField[] = [
      { id: 'bearerToken', headerKey: 'Authorization', headerPrefix: 'Bearer ' },
      { id: 'projectKey', headerKey: 'X-Project-Key' },
    ];

    const merged = mergeUpdateModePayload(
      makeExistingEntry({
        headers: {
          Authorization: 'Bearer old-token',
          'X-Project-Key': 'old-project',
        },
      }),
      makePayload({
        headers: {
          Authorization: 'Bearer ',
          'X-Project-Key': 'new-project',
        },
      }),
      fields,
      INTERNAL_KEYS,
    );

    expect(merged.headers).toEqual({
      Authorization: 'Bearer old-token',
      'X-Project-Key': 'new-project',
    });
  });
});
