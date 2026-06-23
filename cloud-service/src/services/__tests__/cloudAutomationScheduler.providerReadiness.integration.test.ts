import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDefinition } from '@shared/types';
import { AutomationSchedule } from '@shared/utils/automationSchedule';
import type { ProviderCredentialState } from '@core/utils/validateProviderCredentials';
import { apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';

vi.mock('../../electronStoreShim', () => {
  class MemoryStore<T extends Record<string, unknown>> {
    store: T;

    constructor(options: { name: string; defaults: T }) {
      this.store = structuredClone(options.defaults);
    }

    reload(): void {}
  }

  return {
    default: MemoryStore,
    reloadAllStores: () => undefined,
  };
});

vi.mock('../cloudAutomationPrompt', () => ({
  readAutomationPrompt: vi.fn().mockResolvedValue('Test automation prompt'),
}));

import { CloudAutomationStoreAdapter } from '../../cloudAutomationStore';
import { CloudAutomationScheduler } from '../cloudAutomationScheduler';

function createOnceDefinition(id: string): Omit<AutomationDefinition, 'createdAt' | 'updatedAt'> {
  return {
    id,
    name: `Automation ${id}`,
    filePath: `/tmp/${id}.md`,
    schedule: AutomationSchedule.once({ dateTime: new Date(Date.now() - 60_000).toISOString() }),
    enabled: true,
    executeIn: 'cloud',
    timezone: 'UTC',
  };
}

describe('CloudAutomationScheduler provider-readiness once replay integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T08:00:00.000Z'));
    vi.clearAllMocks();
    vi.spyOn(apiRateLimitCooldown, 'isAvailable').mockReturnValue(true);
    vi.spyOn(apiRateLimitCooldown, 'remainingMs').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps blocked once runs retryable and replays on the next scheduler tick after credential repair', async () => {
    let providerCredentialState: ProviderCredentialState | null = { kind: 'codex', status: 'disconnected' };
    const store = new CloudAutomationStoreAdapter();
    const definition = store.upsertDefinition(createOnceDefinition('cloud-once-provider-readiness'));
    const executeAgentTurn = vi.fn(async (_turnId, _prompt, options) => {
      options.onEvent({
        type: 'result',
        text: 'once replayed after readiness repair',
        timestamp: Date.now(),
      });
    });

    const scheduler = new CloudAutomationScheduler({
      getDefinitions: () => store.getState().definitions,
      getProviderCredentialState: () => providerCredentialState,
      executeAgentTurn,
      store,
    });

    scheduler.start();
    await vi.advanceTimersToNextTimerAsync();

    const blockedState = store.getState();
    const blockedDefinition = blockedState.definitions.find((item) => item.id === definition.id);
    expect(blockedState.runs[0]?.status).toBe('provider_not_ready');
    expect(blockedDefinition?.lastRunStatus).toBe('provider_not_ready');
    expect(blockedDefinition?.lastRunAt).toBeNull();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(executeAgentTurn).not.toHaveBeenCalled();

    providerCredentialState = { kind: 'codex', status: 'connected', profile: null };
    await vi.advanceTimersToNextTimerAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(executeAgentTurn).toHaveBeenCalledTimes(1);
    const replayedRuns = store.getState().runs.filter((run) => run.automationId === definition.id);
    expect(replayedRuns.some((run) => run.status === 'success')).toBe(true);
  });
});
