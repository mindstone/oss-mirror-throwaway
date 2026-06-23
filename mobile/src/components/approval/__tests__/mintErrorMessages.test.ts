/**
 * mintErrorMessages tests — verifies the capability-mint error copy map
 * remains in sync with the canonical code catalog in
 * `src/shared/ipc/channels/memory.ts`. If a new code is added there, this
 * test will (deliberately) still pass via the default branch, but the
 * new-code test below should be extended.
 */

import { describeMintError } from '../mintErrorMessages';

describe('describeMintError', () => {
  it('returns removed-staged-file copy for UNKNOWN_STAGED_FILE', () => {
    expect(describeMintError('UNKNOWN_STAGED_FILE')).toBe(
      'This staged file was removed. Please refresh.',
    );
  });

  it('returns unavailable copy for SERVICE_UNAVAILABLE', () => {
    expect(describeMintError('SERVICE_UNAVAILABLE')).toBe(
      'Unable to prepare conflict resolution. Please try again.',
    );
  });

  it('returns retry copy for INVALID_INPUT', () => {
    expect(describeMintError('INVALID_INPUT')).toBe(
      'Could not start conflict resolution. Please try again.',
    );
  });

  it('returns read-only copy for READ_ONLY', () => {
    expect(describeMintError('READ_ONLY')).toBe(
      'Conflict resolution is currently unavailable.',
    );
  });

  it('falls back to generic retry copy for unknown codes', () => {
    expect(describeMintError('SOMETHING_ELSE')).toBe(
      'Could not start conflict resolution. Please try again.',
    );
  });

  it('falls back for empty string', () => {
    expect(describeMintError('')).toBe(
      'Could not start conflict resolution. Please try again.',
    );
  });
});
