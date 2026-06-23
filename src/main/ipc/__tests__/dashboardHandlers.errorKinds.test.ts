import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelError } from '@core/rebelCore/modelErrors';

const registeredHandlers = new Map<string, (event: unknown, request?: unknown) => Promise<unknown>>();
const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockCallBehindTheScenesWithAuth = vi.fn();

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request?: unknown) => Promise<unknown>) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock();
});

vi.mock('../../services/useCaseGeneratorService', () => ({
  generatePersonalizedUseCases: vi.fn(),
}));

vi.mock('../../services/spaceActivityService', () => ({
  getSpaceActivity: vi.fn(),
}));

vi.mock('../../services/spacesSynthesisService', () => ({
  getOrGenerateSynthesis: vi.fn(),
}));

vi.mock('../../services/behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenesWithAuth(...args),
}));

vi.mock('../../settingsStore', () => ({
  settingsStore: {
    set: vi.fn(),
    store: {},
  },
}));

import { registerDashboardHandlers } from '../dashboardHandlers';

describe('dashboardHandlers error shaping', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockCallBehindTheScenesWithAuth.mockReset();

    registerDashboardHandlers({
      getSettings: () => ({ coreDirectory: '/workspace' } as any),
    });
  });

  it('humanizes billing errors and returns errorKind for ensure-goals-in-frontmatter', async () => {
    mockReadFile.mockResolvedValue(`---
title: Chief of Staff
---

## Goals

- Close the quarter well.`);
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new ModelError(
        'billing',
        'This request requires more credits, or fewer max_tokens.',
        402,
        'OpenRouter',
        { rawMessage: '402 {"error":{"message":"This request requires more credits, or fewer max_tokens."}}' },
      ),
    );

    const handler = registeredHandlers.get('dashboard:ensure-goals-in-frontmatter');
    const result = await handler?.({});

    expect(result).toEqual({
      success: false,
      action: 'error',
      // Stage 6b: classification-first humanization now produces subtype+provider-aware copy.
      // See docs/plans/260421_classification_driven_error_humanizer.md.
      error:
        'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
      errorKind: 'billing',
    });
  });
});
