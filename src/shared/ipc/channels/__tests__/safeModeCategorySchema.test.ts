import { describe, expect, it } from 'vitest';
import { appChannels } from '../app';
import { errorRecoveryChannels } from '../errorRecovery';

describe('SafeModeErrorCategorySchema IPC propagation', () => {
  it('accepts new Safe Mode categories through app safe-mode schemas', () => {
    expect(appChannels['app:enter-safe-mode'].request.parse({
      reason: 'failure',
      errorCategory: 'missing_bundle',
    })).toEqual({
      reason: 'failure',
      errorCategory: 'missing_bundle',
    });

    expect(appChannels['app:safe-mode-state'].response.parse({
      isEnabled: true,
      reason: 'failure',
      errorCategory: 'fs_exhaustion',
    })).toEqual({
      isEnabled: true,
      reason: 'failure',
      errorCategory: 'fs_exhaustion',
    });
  });

  it('accepts new Safe Mode categories through error-recovery schemas', () => {
    expect(errorRecoveryChannels['error-recovery:evaluate'].request.parse({
      errorCategory: 'health_timeout',
    })).toEqual({
      errorCategory: 'health_timeout',
    });

    expect(errorRecoveryChannels['error-recovery:get-state'].response.parse({
      evaluationId: null,
      status: 'idle',
      errorCategory: 'spawn_missing_executable',
      evaluation: null,
      startedAt: null,
      quipIndex: 0,
    })).toEqual({
      evaluationId: null,
      status: 'idle',
      errorCategory: 'spawn_missing_executable',
      evaluation: null,
      startedAt: null,
      quipIndex: 0,
    });
  });
});
