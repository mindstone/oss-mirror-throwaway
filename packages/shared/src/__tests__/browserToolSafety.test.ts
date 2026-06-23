/**
 * browserToolSafety unit tests (post-review B2 + B3).
 *
 * Covers:
 *   - Sensitive-field heuristic: expanded keyword list (cc / cvc / ssn /
 *     tax-id / iban / seed-phrase / …).
 *   - Value-level sensitivity fallback: Luhn-valid credit-card numbers,
 *     SSN-shaped strings, and short digit-only OTPs are always masked
 *     even when the selector and label look benign.
 *   - NFKC-normalisation of labels so fullwidth `Ｄｅｌｅｔｅ` and
 *     ligatures like `ﬁle` still match the destructive-click filter
 *     and `labelsMatch`.
 */

import { describe, expect, it } from 'vitest';
import {
  isSensitiveBrowserField,
  sanitizeFillFormFields,
  isDestructiveClickLabel,
  labelsMatch,
  valueLooksSensitive,
} from '../browserToolSafety';

// ---------------------------------------------------------------------------
// isSensitiveBrowserField — widened keyword list (B2)
// ---------------------------------------------------------------------------

describe('isSensitiveBrowserField — widened keywords (B2)', () => {
  const cases: Array<[string, string]> = [
    ['input[name=cc-number]', 'password-like CC number'],
    ['input[name=card_number]', 'card_number synonym'],
    ['input[name=pan]', 'PAN synonym (ISO 7812)'],
    ['input[name=cvc]', 'cvc'],
    ['input[name=csc]', 'csc (Card Security Code)'],
    ['input[autocomplete="cc-csc"]', 'autocomplete cc-csc'],
    ['input[autocomplete="cc-exp-month"]', 'card expiry month'],
    ['input[autocomplete="bday-year"]', 'birthday year'],
    ['input[name=ssn]', 'SSN'],
    ['input[name=social-security-number]', 'spelled out SSN'],
    ['input[name=tax_id]', 'tax id'],
    ['input[name=dob]', 'DOB abbreviation'],
    ['input[name=date-of-birth]', 'DOB spelled out'],
    ['input[name=iban]', 'IBAN'],
    ['input[name=swift_code]', 'SWIFT code'],
    ['input[name=routing_number]', 'routing number'],
    ['input[name=account_number]', 'bank account number'],
    ['input[name=sort_code]', 'UK sort code'],
    ['input[name=seed_phrase]', 'crypto seed phrase'],
    ['input[name=mnemonic]', 'crypto mnemonic'],
    ['input[name=private_key]', 'crypto private key'],
    ['input[name=api_key]', 'API key'],
  ];

  it.each(cases)('marks %s sensitive (%s)', (selector, _desc) => {
    expect(
      isSensitiveBrowserField({ selector, value: 'x' }),
    ).toBe(true);
  });

  it('does not flag a plain email input', () => {
    expect(
      isSensitiveBrowserField({
        selector: 'input[name=email]',
        value: 'user@example.com',
      }),
    ).toBe(false);
  });

  it('matches sensitive keywords hidden behind NFKC-foldable characters (B3)', () => {
    // `ｐａｓｓｗｏｒｄ` is fullwidth — renders identically to `password`
    // on screen, but a naive regex wouldn't match it.
    expect(
      isSensitiveBrowserField({
        selector: 'input[name=ｐａｓｓｗｏｒｄ]',
        value: 'hunter2',
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// valueLooksSensitive — Luhn / SSN / OTP (B2)
// ---------------------------------------------------------------------------

describe('valueLooksSensitive — value-level fallback (B2)', () => {
  it('flags a Luhn-valid credit card number with hyphens', () => {
    // 4111 1111 1111 1111 — Visa Luhn-valid test number.
    expect(valueLooksSensitive('4111-1111-1111-1111')).toBe(true);
  });

  it('flags a Luhn-valid credit card number with spaces', () => {
    expect(valueLooksSensitive('4111 1111 1111 1111')).toBe(true);
  });

  it('does NOT flag a 16-digit number that fails Luhn', () => {
    expect(valueLooksSensitive('1234 5678 9012 3456')).toBe(false);
  });

  it('flags SSN-shaped values', () => {
    expect(valueLooksSensitive('123-45-6789')).toBe(true);
  });

  it('does NOT flag a plain 9-digit string without dashes', () => {
    // Could be a phone number, tracking id, etc — too ambiguous.
    expect(valueLooksSensitive('123456789')).toBe(false);
  });

  it('flags a 6-digit OTP', () => {
    expect(valueLooksSensitive('123456')).toBe(true);
  });

  it('does NOT flag a 10-digit number (too long for OTP, not a Luhn card)', () => {
    expect(valueLooksSensitive('1234567890')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(valueLooksSensitive(undefined)).toBe(false);
    expect(valueLooksSensitive(null)).toBe(false);
    expect(valueLooksSensitive(42)).toBe(false);
    expect(valueLooksSensitive({})).toBe(false);
  });

  it('returns false for an empty or whitespace string', () => {
    expect(valueLooksSensitive('')).toBe(false);
    expect(valueLooksSensitive('   ')).toBe(false);
  });
});

describe('sanitizeFillFormFields — value masking (B2)', () => {
  it('masks a Luhn-valid credit card even if the selector looks benign', () => {
    const out = sanitizeFillFormFields([
      {
        selector: 'input[name=membership_code]',
        value: '4111 1111 1111 1111',
      },
    ]);
    expect(out[0]?.sensitive).toBe(true);
    expect(out[0]?.valuePreview).toBe('***');
  });

  it('masks SSN-shaped value in a "pet-name" field', () => {
    const out = sanitizeFillFormFields([
      { selector: 'input[name=pet_name]', value: '123-45-6789' },
    ]);
    expect(out[0]?.sensitive).toBe(true);
    expect(out[0]?.valuePreview).toBe('***');
  });

  it('passes plain text values through untouched when not sensitive', () => {
    const out = sanitizeFillFormFields([
      { selector: 'input[name=company]', value: 'Acme Corp' },
    ]);
    expect(out[0]?.sensitive).toBe(false);
    expect(out[0]?.valuePreview).toBe('Acme Corp');
  });
});

// ---------------------------------------------------------------------------
// isDestructiveClickLabel — NFKC + widened verbs (B3)
// ---------------------------------------------------------------------------

describe('isDestructiveClickLabel — NFKC + widened verbs (B3)', () => {
  it.each([
    'Delete account',
    'Permanently delete',
    'Remove user',
    'Uninstall',
    'Unsubscribe',
    'Cancel subscription',
    'Confirm purchase',
    'Pay now',
    'Pay $100',
    'Submit payment',
    'Place order',
    'Checkout',
    'Buy now',
    'Terminate',
    'Revoke access',
    'Wipe data',
    'Erase everything',
    'Reset all data',
  ])('flags "%s"', (label) => {
    expect(isDestructiveClickLabel(label)).toBe(true);
  });

  it.each([
    'Save',
    'Cancel', // bare "Cancel" is often harmless (close a dialog, revert a draft). We only match phrases.
    'OK',
    'Go to dashboard',
  ])('does not flag "%s"', (label) => {
    expect(isDestructiveClickLabel(label)).toBe(false);
  });

  it('flags NFKC-foldable labels (fullwidth characters)', () => {
    // Fullwidth `Delete`.
    expect(isDestructiveClickLabel('Ｄｅｌｅｔｅ ａｃｃｏｕｎｔ')).toBe(true);
  });

  it('flags ligature variants (e.g. ﬁ → fi)', () => {
    // `Conﬁrm purchase` with a U+FB01 ligature.
    expect(isDestructiveClickLabel('Con\u{FB01}rm purchase')).toBe(true);
  });

  it('returns false for empty or non-string input', () => {
    expect(isDestructiveClickLabel('')).toBe(false);
    expect(isDestructiveClickLabel(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// labelsMatch — NFKC-aware equality (B3)
// ---------------------------------------------------------------------------

describe('labelsMatch — NFKC + case-insensitive (B3)', () => {
  it('considers fullwidth + ASCII equivalent', () => {
    expect(labelsMatch('Delete account', 'Ｄｅｌｅｔｅ ａｃｃｏｕｎｔ')).toBe(true);
  });

  it('treats different casing as equal', () => {
    expect(labelsMatch('Delete Account', 'DELETE ACCOUNT')).toBe(true);
  });

  it('treats a missing side as "no mismatch" (true)', () => {
    expect(labelsMatch('', 'Delete')).toBe(true);
    expect(labelsMatch('Delete', '')).toBe(true);
  });

  it('returns false for different non-empty labels', () => {
    expect(labelsMatch('Delete', 'Cancel')).toBe(false);
  });
});
