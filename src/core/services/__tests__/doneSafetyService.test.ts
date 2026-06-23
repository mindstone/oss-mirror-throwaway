import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import {
  installCaptureRecorder,
  resetErrorReporter,
} from './testUtils/errorReporterCapture';

const MockCodexDisconnectedBtsError = vi.hoisted(() =>
  class CodexDisconnectedBtsError extends Error {
    constructor() {
      super(
        'Background task cannot use the selected ChatGPT Pro model because ChatGPT Pro is not connected. ' +
        'Reconnect ChatGPT Pro in Settings or choose a different model for this task.'
      );
      this.name = 'CodexDisconnectedBtsError';
    }
  }
);

const testState = vi.hoisted(() => ({
  callWithModelAuthAware: vi.fn(),
  resolveBtsModel: vi.fn(),
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: (...args: unknown[]) => testState.callWithModelAuthAware(...args),
  CodexDisconnectedBtsError: MockCodexDisconnectedBtsError,
}));

vi.mock('@shared/utils/btsModelResolver', () => ({
  resolveBtsModel: (...args: unknown[]) => testState.resolveBtsModel(...args),
}));

vi.mock('@shared/utils/safeJsonParse', () => ({
  safeJsonParseFromModelText: vi.fn(),
}));

vi.mock('../promptFileService', () => ({
  getRawPrompt: vi.fn(() => 'done safety prompt {{user_message}} {{response_text}}'),
  PROMPT_IDS: { SAFETY_DONE_EVALUATION: 'safety/done-evaluation' },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => testState.log,
}));

import { evaluateDoneSafety } from '../doneSafetyService';
import { CodexDisconnectedBtsError } from '../behindTheScenesClient';

function makeSettings(): AppSettings {
  return {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
  } as AppSettings;
}

describe('doneSafetyService Codex observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetErrorReporter();
    testState.resolveBtsModel.mockReturnValue('profile:future-codex-id-abc');
  });

  afterEach(() => {
    resetErrorReporter();
  });

  it('logs codex-blocked BTS errors and preserves the fail-closed result without capturing at this layer', async () => {
    testState.callWithModelAuthAware.mockRejectedValue(new CodexDisconnectedBtsError());
    const captured = installCaptureRecorder();

    const result = await evaluateDoneSafety(makeSettings(), {
      lastUserMessage: 'Send the email',
      responseText: 'Done.',
    });

    expect(result).toEqual({
      safeToMarkDone: false,
      reason: 'Safety evaluation failed - keeping conversation visible',
    });
    expect(testState.log.error).toHaveBeenCalledWith(
      { reason: 'codex-profile-bts-blocked', caller: 'doneSafety' },
      'Done safety BTS blocked'
    );
    expect(captured).toHaveLength(0);
  });

  it('keeps the generic error path for non-codex BTS failures', async () => {
    testState.callWithModelAuthAware.mockRejectedValue(new Error('boom'));
    const captured = installCaptureRecorder();

    const result = await evaluateDoneSafety(makeSettings(), {
      lastUserMessage: 'Send the email',
      responseText: 'Done.',
    });

    expect(result).toEqual({
      safeToMarkDone: false,
      reason: 'Safety evaluation failed - keeping conversation visible',
    });
    expect(testState.log.error).toHaveBeenCalledWith(
      { error: 'boom' },
      'Done safety evaluation failed'
    );
    expect(testState.log.error).not.toHaveBeenCalledWith(
      { reason: 'codex-profile-bts-blocked', caller: 'doneSafety' },
      'Done safety BTS blocked'
    );
    expect(captured).toHaveLength(0);
  });
});
