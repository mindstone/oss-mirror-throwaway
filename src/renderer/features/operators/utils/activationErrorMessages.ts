import type { OperatorActivationErrorCode } from '@shared/types/operators';

type ActivationErrorSeverity = 'error' | 'warning';

type ActivationErrorMessageRecord = {
  title: string;
  message: string;
  severity: ActivationErrorSeverity;
};

const ACTIVATION_ERROR_MESSAGES: Record<OperatorActivationErrorCode, ActivationErrorMessageRecord> = {
  already_activated: {
    title: 'Already set up',
    message: 'Already set up in {Space}. Use the existing one, rename it, or remove it first.',
    severity: 'warning',
  },
  source_not_found: {
    title: 'Source operator missing',
    message: 'Couldn’t find the source operator file. Try refreshing.',
    severity: 'error',
  },
  target_not_writable: {
    title: 'Space isn’t writable',
    message: '{Space} isn’t writable. Check folder permissions.',
    severity: 'error',
  },
  copy_failed: {
    title: 'Copy failed',
    message: 'Couldn’t copy the operator file to {Space}.',
    severity: 'error',
  },
  operator_not_found: {
    title: 'Operator not found',
    message: 'Couldn’t find this operator. Try refreshing.',
    severity: 'error',
  },
  space_not_found: {
    title: 'Space not found',
    message: 'Couldn’t find {Space}. Try refreshing.',
    severity: 'error',
  },
  broadcast_failed: {
    title: 'Couldn’t start personalisation',
    message: 'Rebel couldn’t open a personalisation conversation. Try again.',
    severity: 'error',
  },
  delete_failed: {
    title: 'Couldn’t remove operator',
    message: 'Couldn’t remove the operator. Try again.',
    severity: 'error',
  },
  display_name_too_long: {
    title: 'Name is too long',
    message: 'Name is too long. Keep it under 120 characters.',
    severity: 'warning',
  },
  write_failed: {
    title: 'Couldn’t save operator',
    message: 'Couldn’t save the operator file in {Space}. Check folder permissions and try again.',
    severity: 'error',
  },
  slug_collision_unresolvable: {
    title: 'Couldn’t pick a unique name',
    message: 'Too many duplicates with similar names. Try a different display name.',
    severity: 'warning',
  },
  live_prompt_missing: {
    title: 'Add live meeting instructions first',
    message: 'This Operator has no live meeting prompt yet. Open Instructions and add a `live_prompt:` block before enabling the live coach.',
    severity: 'warning',
  },
  roles_would_be_empty: {
    title: 'Can’t turn off the only role',
    message: 'This is only a live coach. Remove it instead, or add an Operator role in Instructions.',
    severity: 'warning',
  },
};

export function getActivationErrorMessage(
  errorCode: string,
  context: { spaceName?: string; details?: string },
): { title: string; message: string; severity: ActivationErrorSeverity; details?: string } {
  const spaceName = context.spaceName?.trim() || 'this space';
  const details = context.details?.trim() || errorCode;

  const mapped = ACTIVATION_ERROR_MESSAGES[errorCode as OperatorActivationErrorCode];
  if (!mapped) {
    return {
      title: 'Setup issue',
      message: 'Couldn’t finish this setup action. Try again.',
      severity: 'error',
      details,
    };
  }

  return {
    ...mapped,
    message: mapped.message
      .replace(/\{Space\}/gu, spaceName)
      .replace(/([.!?])\1+/gu, '$1'),
    details,
  };
}
