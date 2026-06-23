// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanupFakeTimers,
  flushAsync,
  renderHook,
  setupFakeTimers,
} from '@renderer/test-utils';
import type { ModelProfile } from '@shared/types';
import { useProfileTester } from '../useProfileTester';

type TestProfileResponse = {
  success: boolean;
  latencyMs?: number;
  modelResponse?: string;
  error?: string;
  chatIncompatible?: boolean;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'p-1',
    name: 'Test profile',
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    apiKey: 'fake-test',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

type WindowWithSettings = Window & {
  settingsApi: {
    testModelProfile: ReturnType<typeof vi.fn>;
  };
};

let testModelProfileMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setupFakeTimers();
  testModelProfileMock = vi.fn();
  (globalThis as unknown as { window: WindowWithSettings }).window = {
    ...(globalThis as unknown as { window?: Window }).window,
    settingsApi: { testModelProfile: testModelProfileMock },
  } as WindowWithSettings;
});

afterEach(() => {
  cleanupFakeTimers();
  vi.restoreAllMocks();
});

describe('useProfileTester', () => {
  it('resolves with the IPC result and writes state on success', async () => {
    const deferred = createDeferred<TestProfileResponse>();
    testModelProfileMock.mockReturnValueOnce(deferred.promise);

    const profile = makeProfile();
    const onProfilesChange = vi.fn();
    const { result } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles: [profile], onProfilesChange } },
    );

    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = result.current.runTest(profile.id, {
        serverUrl: profile.serverUrl,
      });
    });
    expect(result.current.isTesting(profile.id)).toBe(true);

    deferred.resolve({ success: true, latencyMs: 123, modelResponse: 'hi' });
    await act(async () => {
      await runPromise;
    });
    await flushAsync();

    expect(result.current.testState[profile.id]).toEqual({
      testing: false,
      result: {
        success: true,
        latencyMs: 123,
        modelResponse: 'hi',
        error: undefined,
        chatIncompatible: undefined,
      },
    });
    expect(onProfilesChange).toHaveBeenCalledTimes(1);
    expect(onProfilesChange.mock.calls[0]?.[0]?.[0]).toMatchObject({
      id: profile.id,
      chatCompatibility: 'compatible',
    });
  });

  it('persists chatCompatibility = incompatible when chatIncompatible flag returns', async () => {
    const deferred = createDeferred<TestProfileResponse>();
    testModelProfileMock.mockReturnValueOnce(deferred.promise);

    const profile = makeProfile();
    const onProfilesChange = vi.fn();
    const { result } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles: [profile], onProfilesChange } },
    );

    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = result.current.runTest(profile.id, {
        serverUrl: profile.serverUrl,
      });
    });

    deferred.resolve({ success: false, chatIncompatible: true, error: 'not a chat model' });
    await act(async () => {
      await runPromise;
    });
    await flushAsync();

    expect(onProfilesChange).toHaveBeenCalledTimes(1);
    expect(onProfilesChange.mock.calls[0]?.[0]?.[0]).toMatchObject({
      id: profile.id,
      chatCompatibility: 'incompatible',
    });
  });

  it('returns a structured failure when the IPC throws', async () => {
    testModelProfileMock.mockRejectedValueOnce(new Error('boom'));
    const profile = makeProfile();
    const onProfilesChange = vi.fn();
    const { result } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles: [profile], onProfilesChange } },
    );

    let testResult: Awaited<ReturnType<typeof result.current.runTest>> | undefined;
    await act(async () => {
      testResult = await result.current.runTest(profile.id, {
        serverUrl: profile.serverUrl,
      });
    });
    await flushAsync();

    expect(testResult).toEqual({ success: false, error: 'boom' });
    expect(result.current.testState[profile.id]?.result).toEqual({
      success: false,
      error: 'boom',
    });
    // A throw before we know the verdict should NOT persist any verdict.
    expect(onProfilesChange).not.toHaveBeenCalled();
  });

  it('does not persist verdict for keys that do not match a persisted profile id', async () => {
    const deferred = createDeferred<TestProfileResponse>();
    testModelProfileMock.mockReturnValueOnce(deferred.promise);

    const profile = makeProfile();
    const onProfilesChange = vi.fn();
    const { result } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles: [profile], onProfilesChange } },
    );

    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = result.current.runTest('wizard-draft:add', {
        serverUrl: 'https://example.com',
      });
    });

    deferred.resolve({ success: true, latencyMs: 42 });
    await act(async () => {
      await runPromise;
    });
    await flushAsync();

    expect(onProfilesChange).not.toHaveBeenCalled();
    expect(result.current.testState['wizard-draft:add']?.result?.success).toBe(true);
  });

  it('cancels stale results per-key when the same key is tested twice rapidly', async () => {
    const first = createDeferred<TestProfileResponse>();
    const second = createDeferred<TestProfileResponse>();
    testModelProfileMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const profile = makeProfile();
    const onProfilesChange = vi.fn();
    const { result } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles: [profile], onProfilesChange } },
    );

    let firstRun!: Promise<unknown>;
    let secondRun!: Promise<unknown>;
    act(() => {
      firstRun = result.current.runTest(profile.id, {
        serverUrl: profile.serverUrl,
        apiKey: 'fake-old',
      });
    });
    act(() => {
      secondRun = result.current.runTest(profile.id, {
        serverUrl: profile.serverUrl,
        apiKey: 'fake-new',
      });
    });

    // Resolve the FIRST call first (stale). It should NOT update state.
    first.resolve({ success: true, latencyMs: 1, modelResponse: 'stale' });
    await act(async () => {
      await firstRun;
    });
    await flushAsync();

    expect(result.current.isTesting(profile.id)).toBe(true);
    expect(result.current.testState[profile.id]?.result).toBeUndefined();
    expect(onProfilesChange).not.toHaveBeenCalled();

    // Then resolve the SECOND call. It is current and should win.
    second.resolve({ success: true, latencyMs: 99, modelResponse: 'fresh' });
    await act(async () => {
      await secondRun;
    });
    await flushAsync();

    expect(result.current.isTesting(profile.id)).toBe(false);
    expect(result.current.testState[profile.id]?.result?.latencyMs).toBe(99);
    expect(onProfilesChange).toHaveBeenCalledTimes(1);
  });

  it('runs multiple keys in parallel via Promise.allSettled and persists per key', async () => {
    const deferredA = createDeferred<TestProfileResponse>();
    const deferredB = createDeferred<TestProfileResponse>();
    const deferredC = createDeferred<TestProfileResponse>();
    testModelProfileMock
      .mockReturnValueOnce(deferredA.promise)
      .mockReturnValueOnce(deferredB.promise)
      .mockReturnValueOnce(deferredC.promise);

    const profileA = makeProfile({ id: 'a' });
    const profileB = makeProfile({ id: 'b', model: 'gpt-5.4-mini' });
    const profileC = makeProfile({ id: 'c', model: 'gpt-5' });
    const profiles = [profileA, profileB, profileC];
    const onProfilesChange = vi.fn();
    const { result } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles, onProfilesChange } },
    );

    const keys = ['a', 'b', 'c'];
    const paramsByKey = {
      a: { serverUrl: profileA.serverUrl, model: profileA.model },
      b: { serverUrl: profileB.serverUrl, model: profileB.model },
      c: { serverUrl: profileC.serverUrl, model: profileC.model },
    };

    let batchPromise!: Promise<unknown>;
    act(() => {
      batchPromise = result.current.runTests(keys, paramsByKey);
    });

    expect(result.current.isBatchRunning).toBe(true);
    expect(testModelProfileMock).toHaveBeenCalledTimes(3);

    // Resolve out of order (B, A, C) to confirm independent settling.
    deferredB.resolve({ success: true, latencyMs: 50 });
    deferredA.resolve({ success: false, chatIncompatible: true, error: 'bad' });
    deferredC.resolve({ success: true, latencyMs: 75 });

    const results = (await act(async () => batchPromise)) as Awaited<
      ReturnType<typeof result.current.runTests>
    >;
    await flushAsync();

    expect(results).toHaveLength(3);
    expect(results[0]?.chatIncompatible).toBe(true);
    expect(results[1]?.success).toBe(true);
    expect(results[2]?.success).toBe(true);

    expect(result.current.isBatchRunning).toBe(false);

    // Persistence: three onProfilesChange calls, one per settled test.
    expect(onProfilesChange).toHaveBeenCalledTimes(3);
  });

  it('last-writer-wins when A is initiated first but B completes last', async () => {
    const first = createDeferred<TestProfileResponse>();
    const second = createDeferred<TestProfileResponse>();
    testModelProfileMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const profile = makeProfile();
    const onProfilesChange = vi.fn();
    const { result } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles: [profile], onProfilesChange } },
    );

    let firstRun!: Promise<unknown>;
    let secondRun!: Promise<unknown>;
    act(() => {
      firstRun = result.current.runTest(profile.id, {
        serverUrl: profile.serverUrl,
        apiKey: 'fake-a',
      });
    });
    act(() => {
      secondRun = result.current.runTest(profile.id, {
        serverUrl: profile.serverUrl,
        apiKey: 'fake-b',
      });
    });

    // A resolves first (stale).
    first.resolve({ success: false, error: 'A failed' });
    await act(async () => {
      await firstRun;
    });
    await flushAsync();

    // B resolves second — this is the write that should survive.
    second.resolve({ success: true, latencyMs: 200, modelResponse: 'B works' });
    await act(async () => {
      await secondRun;
    });
    await flushAsync();

    expect(result.current.testState[profile.id]?.result?.modelResponse).toBe('B works');
    expect(onProfilesChange).toHaveBeenCalledTimes(1);
    expect(onProfilesChange.mock.calls[0]?.[0]?.[0]).toMatchObject({
      chatCompatibility: 'compatible',
    });
  });

  it('concurrent persistVerdict calls all survive in the final profile list', async () => {
    // Race scenario: three tests complete close together. Each persistVerdict
    // must merge against the latest list, not clobber earlier merges.
    const deferredA = createDeferred<TestProfileResponse>();
    const deferredB = createDeferred<TestProfileResponse>();
    const deferredC = createDeferred<TestProfileResponse>();
    testModelProfileMock
      .mockReturnValueOnce(deferredA.promise)
      .mockReturnValueOnce(deferredB.promise)
      .mockReturnValueOnce(deferredC.promise);

    const profileA = makeProfile({ id: 'a' });
    const profileB = makeProfile({ id: 'b', model: 'gpt-5.4-mini' });
    const profileC = makeProfile({ id: 'c', model: 'gpt-5' });
    const profiles = [profileA, profileB, profileC];
    const onProfilesChange = vi.fn<(next: ModelProfile[]) => void>();
    const { result } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles, onProfilesChange } },
    );

    let batchPromise!: Promise<unknown>;
    act(() => {
      batchPromise = result.current.runTests(['a', 'b', 'c'], {
        a: { serverUrl: 'u' },
        b: { serverUrl: 'u' },
        c: { serverUrl: 'u' },
      });
    });

    // Resolve rapidly in sequence; no re-render between them, so profilesRef
    // is not refreshed via the effect. Eager ref advancement must keep merges
    // coherent.
    deferredA.resolve({ success: true, latencyMs: 10 });
    deferredB.resolve({ success: false, chatIncompatible: true, error: 'no' });
    deferredC.resolve({ success: true, latencyMs: 12 });

    await act(async () => {
      await batchPromise;
    });
    await flushAsync();

    // The final onProfilesChange call must contain verdicts for ALL THREE.
    const lastCall = onProfilesChange.mock.calls[onProfilesChange.mock.calls.length - 1]?.[0];
    expect(lastCall).toBeDefined();
    const finalList = lastCall as ModelProfile[];
    const finalA = finalList.find((p) => p.id === 'a');
    const finalB = finalList.find((p) => p.id === 'b');
    const finalC = finalList.find((p) => p.id === 'c');
    expect(finalA?.chatCompatibility).toBe('compatible');
    expect(finalB?.chatCompatibility).toBe('incompatible');
    expect(finalC?.chatCompatibility).toBe('compatible');
  });

  it('does not resurrect a profile deleted between runTest call and resolution', async () => {
    const deferred = createDeferred<TestProfileResponse>();
    testModelProfileMock.mockReturnValueOnce(deferred.promise);

    const profile = makeProfile({ id: 'to-delete' });
    const onProfilesChange = vi.fn();
    const { result, rerender } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles: [profile], onProfilesChange } },
    );

    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = result.current.runTest(profile.id, {
        serverUrl: profile.serverUrl,
      });
    });

    // User deletes the profile while test is in flight. Parent re-renders
    // with the empty list.
    rerender({ profiles: [], onProfilesChange });

    deferred.resolve({ success: true, latencyMs: 5 });
    await act(async () => {
      await runPromise;
    });
    await flushAsync();

    // persistVerdict should see the profile is gone and skip writing.
    // No onProfilesChange call since the profile is gone.
    expect(onProfilesChange).not.toHaveBeenCalled();
  });

  it('auto-clears a settled result after 8 seconds', async () => {
    const deferred = createDeferred<TestProfileResponse>();
    testModelProfileMock.mockReturnValueOnce(deferred.promise);

    const profile = makeProfile();
    const onProfilesChange = vi.fn();
    const { result } = renderHook(
      (props: { profiles: ModelProfile[]; onProfilesChange: typeof onProfilesChange }) =>
        useProfileTester(props),
      { initialProps: { profiles: [profile], onProfilesChange } },
    );

    let runPromise!: Promise<unknown>;
    act(() => {
      runPromise = result.current.runTest(profile.id, {
        serverUrl: profile.serverUrl,
      });
    });

    deferred.resolve({ success: true, latencyMs: 10 });
    await act(async () => {
      await runPromise;
    });
    await flushAsync();

    expect(result.current.testState[profile.id]?.result?.success).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(8000);
      await Promise.resolve();
    });

    expect(result.current.testState[profile.id]).toBeUndefined();
  });
});
