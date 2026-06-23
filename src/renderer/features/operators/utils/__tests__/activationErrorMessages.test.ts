import { describe, expect, it } from 'vitest';
import { OPERATOR_ACTIVATION_ERROR_CODES } from '@shared/types/operators';
import { getActivationErrorMessage } from '../activationErrorMessages';

describe('getActivationErrorMessage', () => {
  it('has explicit renderer copy for every canonical operator activation error code', () => {
    for (const code of OPERATOR_ACTIVATION_ERROR_CODES) {
      const result = getActivationErrorMessage(code, {
        spaceName: 'Acme Inc.',
        details: code,
      });

      // Non-vacuous exhaustiveness guard: if the map entry is removed, this
      // falls through to the generic unknown-code copy and fails.
      expect(result.title, `${code} title`).not.toBe('Setup issue');
      expect(result.message, `${code} message`).not.toBe('Couldn’t finish this setup action. Try again.');
      expect(result.title.trim(), `${code} title`).not.toBe('');
      expect(result.message.trim(), `${code} message`).not.toBe('');
      expect(result.details).toBe(code);
    }
  });

  it.each([
    ['already_activated', 'Already set up in Acme Inc. Use the existing one, rename it, or remove it first.'],
    ['source_not_found', 'Couldn’t find the source operator file. Try refreshing.'],
    ['target_not_writable', 'Acme Inc. isn’t writable. Check folder permissions.'],
    ['copy_failed', 'Couldn’t copy the operator file to Acme Inc.'],
    ['operator_not_found', 'Couldn’t find this operator. Try refreshing.'],
    ['space_not_found', 'Couldn’t find Acme Inc. Try refreshing.'],
    ['broadcast_failed', 'Rebel couldn’t open a personalisation conversation. Try again.'],
    ['delete_failed', 'Couldn’t remove the operator. Try again.'],
    ['display_name_too_long', 'Name is too long. Keep it under 120 characters.'],
    ['write_failed', 'Couldn’t save the operator file in Acme Inc. Check folder permissions and try again.'],
    ['slug_collision_unresolvable', 'Too many duplicates with similar names. Try a different display name.'],
    ['live_prompt_missing', 'This Operator has no live meeting prompt yet. Open Instructions and add a `live_prompt:` block before enabling the live coach.'],
    ['roles_would_be_empty', 'This is only a live coach. Remove it instead, or add an Operator role in Instructions.'],
  ] as const)('maps %s to a user-facing message', (code, expectedMessage) => {
    const result = getActivationErrorMessage(code, {
      spaceName: 'Acme Inc.',
      details: code,
    });

    expect(result.message).toBe(expectedMessage);
    expect(result.details).toBe(code);
  });

  it('returns a generic fallback for unknown codes and preserves details', () => {
    const result = getActivationErrorMessage('unexpected_code', { spaceName: 'Acme Inc.' });

    expect(result.title).toBe('Setup issue');
    expect(result.message).toBe('Couldn’t finish this setup action. Try again.');
    expect(result.details).toBe('unexpected_code');
  });

  it('uses "this space" when no space name is provided', () => {
    const result = getActivationErrorMessage('target_not_writable', { details: 'target_not_writable' });

    expect(result.message).toBe('this space isn’t writable. Check folder permissions.');
  });
});
