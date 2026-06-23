import { describe, expect, it } from 'vitest';
import { validateEmail, validateFirstName } from '../userIdentityValidation';
import {
  EMAIL_ACCEPT,
  EMAIL_NORMALIZED,
  EMAIL_REJECT,
  FIRST_NAME_ACCEPT,
  FIRST_NAME_REJECT,
} from './identityValidationCorpus';

describe('validateFirstName', () => {
  it.each(FIRST_NAME_ACCEPT)('accepts %j', (name) => {
    const result = validateFirstName(name);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(name.trim());
  });

  it.each(FIRST_NAME_REJECT)('rejects %j', (name) => {
    expect(validateFirstName(name).ok).toBe(false);
  });

  it('trims surrounding whitespace before validating and returns the trimmed value', () => {
    const result = validateFirstName('  Alex  ');
    expect(result).toEqual({ ok: true, value: 'Alex' });
  });

  it('rejects a name that is only whitespace', () => {
    expect(validateFirstName('   ').ok).toBe(false);
  });
});

describe('validateEmail', () => {
  it.each(EMAIL_ACCEPT)('accepts %j and normalises to its lowercased form', (input) => {
    const result = validateEmail(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(EMAIL_NORMALIZED[input]);
  });

  it.each(EMAIL_REJECT)('rejects %j', (email) => {
    expect(validateEmail(email).ok).toBe(false);
  });
});
