// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, flushAsync, renderHook } from '@renderer/test-utils';
import type { ModelProfile } from '@shared/types';
import { useProfileLearnedEvents } from '../useProfileLearnedEvents';

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'profile-1',
    name: 'OpenAI / GPT-5.5',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'fake-key',
    createdAt: 1_700_000_000_000,
    enabled: true,
    ...overrides,
  };
}

function createSettingsUpdateEmitter() {
  const listeners = new Set<() => void>();
  const subscribe = vi.fn((callback: () => void) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  });
  return {
    subscribe,
    emit: () => {
      for (const callback of listeners) callback();
    },
  };
}

async function emitAndFlush(emit: () => void): Promise<void> {
  act(() => {
    emit();
  });
  await flushAsync();
  await flushAsync();
}

describe('useProfileLearnedEvents', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it('emits an output-cap event when output auto-learning is added', async () => {
    const emitter = createSettingsUpdateEmitter();
    const baseProfile = makeProfile();
    const learnedProfile = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_010_000,
      lastLearnedOutputTokens: 8_192,
    });
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce({ localModel: { profiles: [baseProfile] } })
      .mockResolvedValueOnce({ localModel: { profiles: [learnedProfile] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents([baseProfile]));
    await flushAsync();

    await emitAndFlush(emitter.emit);

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toEqual({
      id: `${baseProfile.id}:output-cap:1700000010000`,
      kind: 'output-cap',
      profileId: baseProfile.id,
      profileName: baseProfile.name,
      model: baseProfile.model,
      observedCap: 8_192,
      observedAt: 1_700_000_010_000,
    });
    unmount();
  });

  it('does not emit on user-source writes', async () => {
    const emitter = createSettingsUpdateEmitter();
    const baseProfile = makeProfile();
    const userSourceProfile = makeProfile({
      outputTokensSource: 'user',
      outputTokensLearnedAt: 1_700_000_010_000,
      lastLearnedOutputTokens: 8_192,
    });
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce({ localModel: { profiles: [baseProfile] } })
      .mockResolvedValueOnce({ localModel: { profiles: [userSourceProfile] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents([baseProfile]));
    await flushAsync();

    await emitAndFlush(emitter.emit);

    expect(result.current.events).toHaveLength(0);
    unmount();
  });

  it('does not emit duplicate events for repeated refreshes with the same learnedAt', async () => {
    const emitter = createSettingsUpdateEmitter();
    const baseProfile = makeProfile();
    const learnedProfile = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_010_000,
      lastLearnedOutputTokens: 8_192,
    });
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce({ localModel: { profiles: [baseProfile] } })
      .mockResolvedValueOnce({ localModel: { profiles: [learnedProfile] } })
      .mockResolvedValueOnce({ localModel: { profiles: [learnedProfile] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents([baseProfile]));
    await flushAsync();

    await emitAndFlush(emitter.emit);
    await emitAndFlush(emitter.emit);

    expect(result.current.events).toHaveLength(1);
    unmount();
  });

  it('emits an output-cap event but NEVER a context-window event (banner retired, PLAN.md Stage 3)', async () => {
    const emitter = createSettingsUpdateEmitter();
    const baseProfile = makeProfile();
    const outputLearned = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_010_000,
      lastLearnedOutputTokens: 8_192,
    });
    // The __virtual-working poison shape: a learned context-window sidecar.
    // It must NOT produce any event now that the context-window kind is gone.
    const contextLearned = makeProfile({
      ...outputLearned,
      contextWindowSource: 'auto',
      contextWindowLearnedAt: 1_700_000_020_000,
      lastLearnedContextWindow: 84_876,
    });
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce({ localModel: { profiles: [baseProfile] } })
      .mockResolvedValueOnce({ localModel: { profiles: [outputLearned] } })
      .mockResolvedValueOnce({ localModel: { profiles: [contextLearned] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents([baseProfile]));
    await flushAsync();

    await emitAndFlush(emitter.emit);
    await emitAndFlush(emitter.emit);

    // Only the output-cap event survives; the context-window sidecar change is ignored.
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events.map((event) => event.kind)).toEqual(['output-cap']);
    expect(result.current.events.every((event) => event.kind === 'output-cap')).toBe(true);
    unmount();
  });

  it('dedups by profileId + kind + learnedAt even if observed value changes in a duplicate payload', async () => {
    const emitter = createSettingsUpdateEmitter();
    const baseProfile = makeProfile();
    const firstLearning = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_030_000,
      lastLearnedOutputTokens: 8_192,
    });
    const duplicateTuple = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_030_000,
      lastLearnedOutputTokens: 4_096,
    });
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce({ localModel: { profiles: [baseProfile] } })
      .mockResolvedValueOnce({ localModel: { profiles: [firstLearning] } })
      .mockResolvedValueOnce({ localModel: { profiles: [duplicateTuple] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents([baseProfile]));
    await flushAsync();

    await emitAndFlush(emitter.emit);
    await emitAndFlush(emitter.emit);

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toMatchObject({
      kind: 'output-cap',
      observedCap: 8_192,
    });
    unmount();
  });

  it('seeds the output-cap event retroactively but ignores a persisted context-window sidecar', async () => {
    const emitter = createSettingsUpdateEmitter();
    // Mirrors Greg's live __virtual-working poison: an auto context-window sidecar
    // alongside a sound output-cap. Only the output-cap should surface retroactively.
    const alreadyLearned = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_005_000,
      lastLearnedOutputTokens: 4_096,
      contextWindowSource: 'auto',
      contextWindowLearnedAt: 1_700_000_006_000,
      lastLearnedContextWindow: 84_876,
    });
    const getSettings = vi
      .fn()
      .mockResolvedValue({ localModel: { profiles: [alreadyLearned] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents([alreadyLearned]));
    await flushAsync();
    await flushAsync();

    expect(result.current.events).toHaveLength(1);
    expect(new Set(result.current.events.map((event) => event.kind))).toEqual(
      new Set(['output-cap']),
    );
    unmount();
  });

  it('produces NO event for a profile that has only a context-window sidecar', async () => {
    const emitter = createSettingsUpdateEmitter();
    const contextOnly = makeProfile({
      contextWindowSource: 'auto',
      contextWindowLearnedAt: 1_700_000_006_000,
      lastLearnedContextWindow: 84_876,
    });
    const getSettings = vi
      .fn()
      .mockResolvedValue({ localModel: { profiles: [contextOnly] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents([contextOnly]));
    await flushAsync();
    await flushAsync();
    await emitAndFlush(emitter.emit);

    expect(result.current.events).toHaveLength(0);
    unmount();
  });

  it('does not re-emit events that were dismissed in a previous session', async () => {
    const emitter = createSettingsUpdateEmitter();
    const alreadyLearned = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_005_000,
      lastLearnedOutputTokens: 4_096,
    });
    const dismissedId = `${alreadyLearned.id}:output-cap:${alreadyLearned.outputTokensLearnedAt}`;
    window.localStorage.setItem(
      'rebel:profile-learned-dismissed:v1',
      JSON.stringify([dismissedId]),
    );
    const getSettings = vi
      .fn()
      .mockResolvedValue({ localModel: { profiles: [alreadyLearned] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents([alreadyLearned]));
    await flushAsync();
    await flushAsync();

    expect(result.current.events).toHaveLength(0);
    unmount();
  });

  it('persists dismissal across hook unmounts (subsequent runs skip the dismissed event)', async () => {
    const emitter = createSettingsUpdateEmitter();
    const baseProfile = makeProfile();
    const learnedProfile = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_010_000,
      lastLearnedOutputTokens: 8_192,
    });
    const getSettings = vi
      .fn()
      .mockResolvedValueOnce({ localModel: { profiles: [baseProfile] } })
      .mockResolvedValueOnce({ localModel: { profiles: [learnedProfile] } })
      .mockResolvedValue({ localModel: { profiles: [learnedProfile] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const first = renderHook(() => useProfileLearnedEvents([baseProfile]));
    await flushAsync();
    await emitAndFlush(emitter.emit);

    expect(first.result.current.events).toHaveLength(1);
    const eventId = first.result.current.events[0].id;

    act(() => {
      first.result.current.dismissEvent(eventId);
    });

    expect(first.result.current.events).toHaveLength(0);
    first.unmount();

    const persisted = window.localStorage.getItem('rebel:profile-learned-dismissed:v1');
    expect(persisted).toContain(eventId);

    const second = renderHook(() => useProfileLearnedEvents([learnedProfile]));
    await flushAsync();
    await flushAsync();

    expect(second.result.current.events).toHaveLength(0);
    second.unmount();
  });

  it('drops stale async refresh responses (monotonic sequence guard)', async () => {
    const emitter = createSettingsUpdateEmitter();
    const baseProfile = makeProfile();
    const slowResponse = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_001_000,
      lastLearnedOutputTokens: 1_000,
    });
    const fastResponse = makeProfile({
      outputTokensSource: 'auto',
      outputTokensLearnedAt: 1_700_000_002_000,
      lastLearnedOutputTokens: 2_000,
    });

    let resolveSlow: (value: unknown) => void = () => undefined;
    const slowPromise = new Promise((resolve) => {
      resolveSlow = resolve;
    });

    const getSettings = vi
      .fn()
      .mockResolvedValueOnce({ localModel: { profiles: [baseProfile] } })
      .mockReturnValueOnce(slowPromise)
      .mockResolvedValueOnce({ localModel: { profiles: [fastResponse] } });

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: {
        get: getSettings,
      },
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents([baseProfile]));
    await flushAsync();

    act(() => {
      emitter.emit();
    });
    await flushAsync();

    await emitAndFlush(emitter.emit);

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toMatchObject({ observedCap: 2_000 });

    resolveSlow({ localModel: { profiles: [slowResponse] } });
    await flushAsync();
    await flushAsync();

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]).toMatchObject({ observedCap: 2_000 });

    unmount();
  });

  it('handles missing settingsApi gracefully (no crash, no events)', async () => {
    const emitter = createSettingsUpdateEmitter();

    Object.assign(window, {
      api: {
        onSettingsExternalUpdate: emitter.subscribe,
      },
      settingsApi: undefined,
    });

    const { result, unmount } = renderHook(() => useProfileLearnedEvents());
    await flushAsync();

    await emitAndFlush(emitter.emit);

    expect(result.current.events).toHaveLength(0);
    unmount();
  });
});
