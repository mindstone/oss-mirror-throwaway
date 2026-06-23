import { describe, expect, it } from 'vitest';
import { canonicalOrganisationKey } from '../spaceOrganisationHeuristics';

describe('canonicalOrganisationKey', () => {
  it.each([
    { value: 'Mindstone', expected: 'mindstone' },
    { value: 'mindstone', expected: 'mindstone' },
    { value: ' Mindstone ', expected: 'mindstone' },
    { value: 'Mindstone\u00a0Inc', expected: 'mindstone inc' },
    { value: '', expected: '' },
    { value: '   ', expected: '' },
    { value: 'Acme   Corp', expected: 'acme corp' },
  ])('normalizes "$value" to "$expected"', ({ value, expected }) => {
    expect(canonicalOrganisationKey(value)).toBe(expected);
  });
});
