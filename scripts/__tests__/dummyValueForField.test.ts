import { describe, expect, it } from 'vitest';

import { dummyValueForField } from '../mcp-discovery';

describe('dummyValueForField — select handling (#9 from 260504_fix_ci_failures)', () => {
  it('returns the field default when present', () => {
    const result = dummyValueForField({
      type: 'select',
      default: 'production',
      options: [
        { value: 'production', label: 'Production' },
        { value: 'sandbox', label: 'Sandbox' },
      ],
    });
    expect(result).toBe('production');
  });

  it('falls back to first option value when default is missing', () => {
    const result = dummyValueForField({
      type: 'select',
      options: [
        { value: 'us', label: 'US' },
        { value: 'eu', label: 'EU' },
      ],
    });
    expect(result).toBe('us');
  });

  it('falls back to "smoke-test-dummy" when both default and options are absent', () => {
    const result = dummyValueForField({ type: 'select' });
    expect(result).toBe('smoke-test-dummy');
  });

  it('ignores empty-string default and falls through to first option', () => {
    const result = dummyValueForField({
      type: 'select',
      default: '',
      options: [{ value: 'first', label: 'First' }],
    });
    expect(result).toBe('first');
  });

  it('ignores option with empty-string value and falls through to dummy', () => {
    const result = dummyValueForField({
      type: 'select',
      options: [{ value: '', label: 'Empty' }],
    });
    expect(result).toBe('smoke-test-dummy');
  });
});

describe('dummyValueForField — preserved legacy behavior', () => {
  it('returns numeric placeholder when present', () => {
    expect(dummyValueForField({ type: 'text', placeholder: '993' })).toBe('993');
  });

  it('returns boolean placeholder when present', () => {
    expect(dummyValueForField({ type: 'text', placeholder: 'true' })).toBe('true');
    expect(dummyValueForField({ type: 'text', placeholder: 'false' })).toBe('false');
  });

  it('returns http placeholder when present', () => {
    expect(dummyValueForField({ type: 'text', placeholder: 'https://example.com' })).toBe(
      'https://example.com',
    );
  });

  it('returns localhost URL for type=url with no usable placeholder', () => {
    expect(dummyValueForField({ type: 'url' })).toBe('http://localhost:9999');
  });

  it('returns smoke-test-dummy for password and text fields with no placeholder', () => {
    expect(dummyValueForField({ type: 'password' })).toBe('smoke-test-dummy');
    expect(dummyValueForField({ type: 'text' })).toBe('smoke-test-dummy');
  });
});
