import { describe, it, expect } from 'vitest';
import { buildHeadersFromSetupFields, buildEnvFromSetupFields } from '@shared/utils/setupFieldUtils';
import type { SetupField } from '@shared/types';

describe('buildHeadersFromSetupFields', () => {
  it('builds header with key and prefix', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', headerKey: 'Authorization', headerPrefix: 'Bearer ' }
    ];
    const values = { apiKey: 'phx_123' };

    expect(buildHeadersFromSetupFields(fields, values)).toEqual({ Authorization: 'Bearer phx_123' });
  });

  it('builds header without prefix when headerPrefix is undefined', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', headerKey: 'X-API-Key' }
    ];
    const values = { apiKey: 'secret123' };

    expect(buildHeadersFromSetupFields(fields, values)).toEqual({ 'X-API-Key': 'secret123' });
  });

  it('skips fields with empty value', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', headerKey: 'Authorization' }
    ];

    expect(buildHeadersFromSetupFields(fields, { apiKey: '' })).toEqual({});
  });

  it('skips fields with whitespace-only value', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', headerKey: 'Authorization' }
    ];

    expect(buildHeadersFromSetupFields(fields, { apiKey: '   ' })).toEqual({});
  });

  it('skips fields when value key is missing from fieldValues', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', headerKey: 'Authorization' }
    ];

    expect(buildHeadersFromSetupFields(fields, {})).toEqual({});
  });

  it('only includes fields with headerKey, ignores envVar fields', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', headerKey: 'Authorization', headerPrefix: 'Bearer ' },
      { id: 'dbUrl', label: 'Database URL', type: 'url', envVar: 'DATABASE_URL' }
    ];
    const values = { apiKey: 'secret', dbUrl: 'postgres://...' };

    expect(buildHeadersFromSetupFields(fields, values)).toEqual({ Authorization: 'Bearer secret' });
  });

  it('returns empty object when no fields have headerKey', () => {
    const fields: SetupField[] = [
      { id: 'url', label: 'URL', type: 'url' },
      { id: 'token', label: 'Token', type: 'password', envVar: 'TOKEN' }
    ];
    const values = { url: 'https://example.com', token: 'abc' };

    expect(buildHeadersFromSetupFields(fields, values)).toEqual({});
  });

  it('trims whitespace from values', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', headerKey: 'Authorization', headerPrefix: 'Bearer ' }
    ];

    expect(buildHeadersFromSetupFields(fields, { apiKey: '  phx_123  ' })).toEqual({ Authorization: 'Bearer phx_123' });
  });
});

describe('buildEnvFromSetupFields', () => {
  it('builds env from fields with envVar', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', envVar: 'API_KEY' }
    ];

    expect(buildEnvFromSetupFields(fields, { apiKey: 'secret' })).toEqual({ API_KEY: 'secret' });
  });

  it('ignores fields with headerKey (only processes envVar)', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', headerKey: 'Authorization' }
    ];

    expect(buildEnvFromSetupFields(fields, { apiKey: 'secret' })).toEqual({});
  });

  it('handles multiple envVar fields', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', envVar: 'API_KEY' },
      { id: 'dbUrl', label: 'Database', type: 'url', envVar: 'DATABASE_URL' }
    ];
    const values = { apiKey: 'key123', dbUrl: 'postgres://localhost' };

    expect(buildEnvFromSetupFields(fields, values)).toEqual({
      API_KEY: 'key123',
      DATABASE_URL: 'postgres://localhost'
    });
  });

  it('skips fields with empty value', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', envVar: 'API_KEY' }
    ];

    expect(buildEnvFromSetupFields(fields, { apiKey: '' })).toEqual({});
  });

  it('trims whitespace from values', () => {
    const fields: SetupField[] = [
      { id: 'apiKey', label: 'API Key', type: 'password', envVar: 'API_KEY' }
    ];

    expect(buildEnvFromSetupFields(fields, { apiKey: '  secret  ' })).toEqual({ API_KEY: 'secret' });
  });

  describe('boolean fields', () => {
    it('passes "true" through to env', () => {
      const fields: SetupField[] = [
        { id: 'showWindow', label: 'Show window', type: 'boolean', envVar: 'SHOW_WINDOW', default: 'true' },
      ];

      expect(buildEnvFromSetupFields(fields, { showWindow: 'true' })).toEqual({ SHOW_WINDOW: 'true' });
    });

    it('passes "false" through to env (does NOT skip on falsy)', () => {
      const fields: SetupField[] = [
        { id: 'showWindow', label: 'Show window', type: 'boolean', envVar: 'SHOW_WINDOW', default: 'true' },
      ];

      expect(buildEnvFromSetupFields(fields, { showWindow: 'false' })).toEqual({ SHOW_WINDOW: 'false' });
    });

    it('falls back to field default when value is unset', () => {
      const fields: SetupField[] = [
        { id: 'showWindow', label: 'Show window', type: 'boolean', envVar: 'SHOW_WINDOW', default: 'true' },
      ];

      expect(buildEnvFromSetupFields(fields, {})).toEqual({ SHOW_WINDOW: 'true' });
    });

    it('skips boolean fields when value is unset and no default is configured', () => {
      const fields: SetupField[] = [
        { id: 'showWindow', label: 'Show window', type: 'boolean', envVar: 'SHOW_WINDOW' },
      ];

      expect(buildEnvFromSetupFields(fields, {})).toEqual({});
    });

    it('boolean field with headerKey is silently skipped (defensive — booleans are not header values)', () => {
      const fields: SetupField[] = [
        { id: 'showWindow', label: 'Show window', type: 'boolean', headerKey: 'X-Show-Window' },
      ];

      expect(buildHeadersFromSetupFields(fields, { showWindow: 'true' })).toEqual({});
    });
  });
});
