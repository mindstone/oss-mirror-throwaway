import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';

vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));

const loggerState = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerState,
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(),
}));

vi.mock('../fileIndexService', () => ({
  getUnenhancedChunks: vi.fn(),
  getChunkCounts: vi.fn(),
  updateChunkEmbedding: vi.fn(),
  updateEnhancementState: vi.fn(),
}));

vi.mock('../embeddingService', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: vi.fn(),
}));

vi.mock('../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCostOrWarn: vi.fn(() => 0),
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: vi.fn(),
}));

import { resolveEnhancementModel } from '../enhancementService';

function makeSettings(
  overrides: Partial<Pick<AppSettings, 'behindTheScenesModel'>> = {},
): Pick<AppSettings, 'behindTheScenesModel'> {
  return {
    behindTheScenesModel: undefined,
    ...overrides,
  };
}

describe('resolveEnhancementModel prefix decoding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decodes model:gpt-5.4-mini to bare model id', () => {
    expect(resolveEnhancementModel(makeSettings({
      behindTheScenesModel: 'model:gpt-5.4-mini',
    }))).toBe('gpt-5.4-mini');
  });

  it('returns undefined for model: and warns', () => {
    expect(resolveEnhancementModel(makeSettings({
      behindTheScenesModel: 'model:',
    }))).toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalledTimes(1);
    expect(loggerState.warn).toHaveBeenCalledWith(
      {
        siteId: 'enhancementService:resolveEnhancementModel',
        rawTruncated: 'model:',
        rejectionReason: 'empty-model-id',
      },
      expect.stringContaining('empty model id'),
    );
  });

  it('returns undefined for profile: and warns', () => {
    expect(resolveEnhancementModel(makeSettings({
      behindTheScenesModel: 'profile:',
    }))).toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalledTimes(1);
    expect(loggerState.warn).toHaveBeenCalledWith(
      {
        siteId: 'enhancementService:resolveEnhancementModel',
        rawTruncated: 'profile:',
        rejectionReason: 'empty-profile-id',
      },
      expect.stringContaining('empty profile id'),
    );
  });

  it('returns undefined for whitespace-only input and warns', () => {
    expect(resolveEnhancementModel(makeSettings({
      behindTheScenesModel: '   ',
    }))).toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalledTimes(1);
    expect(loggerState.warn).toHaveBeenCalledWith(
      {
        siteId: 'enhancementService:resolveEnhancementModel',
        rawTruncated: '   ',
        rejectionReason: 'empty-or-whitespace',
      },
      expect.stringContaining('empty or whitespace input'),
    );
  });

  it('returns undefined for non-string input and warns with raw type', () => {
    expect(resolveEnhancementModel(makeSettings({
      behindTheScenesModel: 42,
    } as unknown as Partial<Pick<AppSettings, 'behindTheScenesModel'>>))).toBeUndefined();
    expect(loggerState.warn).toHaveBeenCalledTimes(1);
    expect(loggerState.warn).toHaveBeenCalledWith(
      {
        siteId: 'enhancementService:resolveEnhancementModel',
        rawType: 'number',
        rejectionReason: 'invalid-type',
      },
      expect.stringContaining('invalid type (not a string)'),
    );
  });

  it('preserves profile:abc-123 values', () => {
    expect(resolveEnhancementModel(makeSettings({
      behindTheScenesModel: 'profile:abc-123',
    }))).toBe('profile:abc-123');
  });

  it('returns undefined when behindTheScenesModel is not configured', () => {
    expect(resolveEnhancementModel(makeSettings())).toBeUndefined();
  });
});
