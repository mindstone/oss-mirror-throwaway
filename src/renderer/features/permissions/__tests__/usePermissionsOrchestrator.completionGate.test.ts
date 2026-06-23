// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@renderer/test-utils';
import type { AppSettings } from '@shared/types';
import { hasCoachCompletionSignal } from '@renderer/features/onboarding/utils/coachCompletionState';
import { usePermissionsOrchestrator } from '../usePermissionsOrchestrator';

type OrchestratorOptions = Parameters<typeof usePermissionsOrchestrator>[0];
type SaveSettingsWith = OrchestratorOptions['saveSettingsWith'];
type ValidateWorkspaceAccess = typeof window.systemHealthApi.validateWorkspaceAccess;

const coreDirectory = '/Users/test/Library/Mindstone Rebel';

function makeSettings(): AppSettings {
  return {
    coreDirectory,
    mcpConfigFile: null,
    onboardingCompleted: false,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {},
    models: {},
    diagnostics: {},
  } as AppSettings;
}

function makeAutomationState() {
  return {
    version: 1,
    definitions: [],
    runs: [],
    quarantined: [],
    sessionTypeFilter: 'all',
  };
}

describe('usePermissionsOrchestrator completion workspace gate', () => {
  let validateWorkspaceAccess: ReturnType<typeof vi.fn<ValidateWorkspaceAccess>>;
  let saveSettingsWith: ReturnType<typeof vi.fn<SaveSettingsWith>>;
  let showToast: ReturnType<typeof vi.fn<OrchestratorOptions['showToast']>>;
  let emitLog: ReturnType<typeof vi.fn<OrchestratorOptions['emitLog']>>;
  let savedSettings: AppSettings[];

  beforeEach(() => {
    localStorage.clear();
    savedSettings = [];
    validateWorkspaceAccess = vi.fn<ValidateWorkspaceAccess>();
    saveSettingsWith = vi.fn<SaveSettingsWith>(async (override) => {
      if (override) {
        savedSettings.push(override(makeSettings()));
      }
    });
    showToast = vi.fn<OrchestratorOptions['showToast']>();
    emitLog = vi.fn<OrchestratorOptions['emitLog']>();

    Object.defineProperty(window, 'systemHealthApi', {
      configurable: true,
      value: {
        validateWorkspaceAccess,
      },
    });
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      value: {
        ensureWorkspaceSymlinks: vi.fn().mockResolvedValue(undefined),
      },
    });
    Object.defineProperty(window, 'automationsApi', {
      configurable: true,
      value: {
        state: vi.fn().mockResolvedValue(makeAutomationState()),
        upsert: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  async function completeWith(response: Awaited<ReturnType<ValidateWorkspaceAccess>>) {
    validateWorkspaceAccess.mockResolvedValue(response);
    const rendered = renderHook(() =>
      usePermissionsOrchestrator({
        settings: makeSettings(),
        saveSettingsWith,
        emitLog,
        showToast,
      }),
    );

    let thrown: unknown;
    await act(async () => {
      try {
        await rendered.result.current.completeOnboardingFlow({ skipAudioIntro: true });
      } catch (error) {
        thrown = error;
      }
    });
    rendered.unmount();
    return thrown;
  }

  it('throws denied validation errors without marking onboarding complete', async () => {
    const thrown = await completeWith({
      accessible: false,
      code: 'EACCES',
      error: 'Access denied',
    });

    expect(validateWorkspaceAccess).toHaveBeenCalledWith({
      path: coreDirectory,
      createIfMissing: true,
    });
    expect(saveSettingsWith).not.toHaveBeenCalled();
    expect(savedSettings).not.toContainEqual(expect.objectContaining({ onboardingCompleted: true }));
    expect(thrown).toMatchObject({
      name: 'WorkspaceValidationError',
      code: 'EACCES',
      message: 'Access denied',
    });
    expect(showToast).toHaveBeenCalledWith({
      title: "Your organisation's security policy may be blocking folder access. Choose a different location.",
    });
    expect(emitLog).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      message: 'Onboarding: Workspace not accessible at completion',
      context: expect.objectContaining({
        coreDirectory,
        code: 'EACCES',
        error: 'Access denied',
      }),
    }));
  });

  it('throws invalid validation errors with the generic workspace toast', async () => {
    const thrown = await completeWith({
      accessible: false,
      code: 'HANDLER_ERROR',
      error: 'Handler failed',
    });

    expect(saveSettingsWith).not.toHaveBeenCalled();
    expect(savedSettings).not.toContainEqual(expect.objectContaining({ onboardingCompleted: true }));
    expect(thrown).toMatchObject({
      name: 'WorkspaceValidationError',
      code: 'HANDLER_ERROR',
      message: 'Handler failed',
    });
    expect(showToast).toHaveBeenCalledWith({
      title: "Can't access your Library folder. Choose a different location.",
    });
  });

  it('marks onboarding complete when workspace access is accessible', async () => {
    const thrown = await completeWith({ accessible: true });

    expect(thrown).toBeUndefined();
    expect(saveSettingsWith).toHaveBeenCalledTimes(1);
    expect(savedSettings).toHaveLength(1);
    expect(savedSettings[0]).toEqual(expect.objectContaining({ onboardingCompleted: true }));
    expect(showToast).not.toHaveBeenCalledWith({
      title: "Can't access your Library folder. Choose a different location.",
    });
    expect(showToast).not.toHaveBeenCalledWith({
      title: "Your organisation's security policy may be blocking folder access. Choose a different location.",
    });
  });

  it('leaves the coach activation pending after fresh wizard completion (Home card must show)', async () => {
    // Contract (plan-critique F4): wizard completion must NOT create any coach
    // completion signal — onboardingCompletedAt stays unset and no
    // completedSteps[0] is written — so the Home activation card shows and the
    // user has a path to the coach conversation.
    const thrown = await completeWith({ accessible: true });

    expect(thrown).toBeUndefined();
    expect(savedSettings).toHaveLength(1);
    const saved = savedSettings[0];
    expect(saved.onboardingCompleted).toBe(true);
    expect(saved.onboardingCompletedAt).toBeUndefined();
    expect(saved.onboardingChecklist?.completedSteps?.[0]).toBeUndefined();
    expect(hasCoachCompletionSignal(saved)).toBe(false);
  });
});
