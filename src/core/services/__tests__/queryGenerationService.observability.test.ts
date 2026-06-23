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

vi.mock('../promptFileService', () => ({
  getPrompt: vi.fn(() => 'query generation prompt'),
  PROMPT_IDS: { INTELLIGENCE_QUERY_GENERATION: 'intelligence/query-generation' },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => testState.log,
}));

import { generateSearchQueries } from '../queryGenerationService';
import { CodexDisconnectedBtsError } from '../behindTheScenesClient';

function makeSettings(): AppSettings {
  return {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
  } as AppSettings;
}

describe('queryGenerationService Codex observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetErrorReporter();
    testState.resolveBtsModel.mockReturnValue('profile:future-codex-id-abc');
  });

  afterEach(() => {
    resetErrorReporter();
  });

  it('logs codex-blocked BTS errors and preserves the null fallback without capturing at this layer', async () => {
    testState.callWithModelAuthAware.mockRejectedValue(new CodexDisconnectedBtsError());
    const captured = installCaptureRecorder();

    const result = await generateSearchQueries('Find relevant docs', makeSettings());

    expect(result).toBeNull();
    expect(testState.log.error).toHaveBeenCalledWith(
      { reason: 'codex-profile-bts-blocked', caller: 'queryGeneration' },
      'Query generation BTS blocked'
    );
    expect(testState.log.warn).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
  });

  it('keeps the generic warn path for non-codex BTS errors', async () => {
    testState.callWithModelAuthAware.mockRejectedValue(new Error('boom'));
    const captured = installCaptureRecorder();

    const result = await generateSearchQueries('Find relevant docs', makeSettings());

    expect(result).toBeNull();
    expect(testState.log.error).not.toHaveBeenCalled();
    expect(testState.log.warn).toHaveBeenCalledWith(
      { err: 'boom', model: 'profile:future-codex-id-abc' },
      'Query generation failed, caller should fall back to raw prompt'
    );
    expect(captured).toHaveLength(0);
  });
});
