/**
 * Adapter contract tests for `updateSettingsAtomic` (Stage 2,
 * 260503_unify_learned_limits_into_profiles.md).
 *
 * Verifies that:
 * - Desktop adapter forwards settings to cloud on `sync: true` and skips
 *   cloud forwarding when sync is omitted.
 * - Cloud adapter no-ops on `sync` (cloud is its own surface authoritative
 *   store).
 * - Both adapters short-circuit when the updater returns `{}` (no
 *   `updateSettings` invocation, no cloud forward).
 * - Functional updaters that race in the same tick both see the most-recent
 *   committed state.
 *
 * The desktop adapter under test is a self-contained reproduction of
 * `src/main/index.ts`'s wiring (Stage 2). The cloud adapter is the
 * reproduction of `cloud-service/src/bootstrap.ts`'s wiring. We don't
 * import the real bootstrap/index because they pull in Electron / Sentry /
 * a giant blast radius of side-effecting modules.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { SettingsStoreAdapter } from '../settingsStore';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

interface Harness {
  current: AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  cloudForward: ReturnType<typeof vi.fn>;
  warnLog: ReturnType<typeof vi.fn>;
  adapter: SettingsStoreAdapter;
}

function createDesktopHarness(
  options: {
    forwardResult?: unknown;
    forwardThrows?: unknown;
  } = {},
): Harness {
  const settings = { foo: 'initial' } as unknown as AppSettings;
  const warnLog = vi.fn();
  const cloudForward = vi.fn(async (_channel: string, _args: unknown[]) => {
    if (options.forwardThrows !== undefined) throw options.forwardThrows;
    return options.forwardResult ?? undefined;
  });
  const updateSettings = vi.fn((partial: Partial<AppSettings>) => {
    Object.assign(settings, partial);
  });
  const harness: Harness = {
    get current() {
      return settings;
    },
    updateSettings,
    cloudForward,
    warnLog,
    adapter: {
      getSettings: () => settings,
      updateSettings,
      updateSettingsAtomic: (updater, opts) => {
        const partial = updater(settings);
        if (Object.keys(partial).length === 0) return;
        updateSettings(partial);
        if (opts?.sync) {
          void cloudForward('settings:update', [settings])
            .then((result: unknown) => {
              if (
                result &&
                typeof result === 'object' &&
                'error' in result &&
                (result as { error?: unknown }).error
              ) {
                warnLog(
                  { error: (result as { error: unknown }).error, channel: 'settings:update' },
                  'updateSettingsAtomic: cloud forward returned error result; local write succeeded',
                );
              }
            })
            .catch((err: unknown) => {
              warnLog(
                { err, channel: 'settings:update' },
                'updateSettingsAtomic: cloud sync threw; local write succeeded',
              );
            });
        }
      },
    },
  };
  return harness;
}

function createCloudHarness(): Harness {
  const settings = { foo: 'initial' } as unknown as AppSettings;
  const warnLog = vi.fn();
  const cloudForward = vi.fn(
    async (_channel: string, _args: unknown[]) => undefined,
  );
  const updateSettings = vi.fn((partial: Partial<AppSettings>) => {
    Object.assign(settings, partial);
  });
  const harness: Harness = {
    get current() {
      return settings;
    },
    updateSettings,
    cloudForward,
    warnLog,
    adapter: {
      getSettings: () => settings,
      updateSettings,
      updateSettingsAtomic: (updater) => {
        const partial = updater(settings);
        if (Object.keys(partial).length === 0) return;
        updateSettings(partial);
      },
    },
  };
  return harness;
}

describe('settingsStoreAdapter — desktop contract', () => {
  it('forwards to cloud exactly once on sync:true', () => {
    const h = createDesktopHarness();
    h.adapter.updateSettingsAtomic(
      () => ({ foo: 'bar' } as unknown as Partial<AppSettings>),
      { sync: true },
    );
    expect(h.updateSettings).toHaveBeenCalledTimes(1);
    expect(h.cloudForward).toHaveBeenCalledTimes(1);
  });

  it('does NOT forward to cloud when sync flag is omitted', () => {
    const h = createDesktopHarness();
    h.adapter.updateSettingsAtomic(
      () => ({ foo: 'bar' } as unknown as Partial<AppSettings>),
    );
    expect(h.updateSettings).toHaveBeenCalledTimes(1);
    expect(h.cloudForward).not.toHaveBeenCalled();
  });

  it('short-circuits when updater returns {} — neither updateSettings nor cloudForward fire', () => {
    const h = createDesktopHarness();
    h.adapter.updateSettingsAtomic(
      () => ({} as Partial<AppSettings>),
      { sync: true },
    );
    expect(h.updateSettings).not.toHaveBeenCalled();
    expect(h.cloudForward).not.toHaveBeenCalled();
  });
});

describe('settingsStoreAdapter — cloud contract', () => {
  it('no-ops cloud forwarding even when sync:true is passed', () => {
    const h = createCloudHarness();
    h.adapter.updateSettingsAtomic(
      () => ({ foo: 'bar' } as unknown as Partial<AppSettings>),
      { sync: true },
    );
    expect(h.updateSettings).toHaveBeenCalledTimes(1);
    expect(h.cloudForward).not.toHaveBeenCalled();
  });

  it('short-circuits when updater returns {}', () => {
    const h = createCloudHarness();
    h.adapter.updateSettingsAtomic(() => ({} as Partial<AppSettings>));
    expect(h.updateSettings).not.toHaveBeenCalled();
  });
});

describe('settingsStoreAdapter — desktop forward error inspection (DO-NOW 2, cycle 3)', () => {
  it('logs WARN when cloud forward resolves with an { error } shape', async () => {
    const h = createDesktopHarness({
      forwardResult: { error: { code: 'TIMEOUT', message: 'Cloud unreachable' } },
    });
    h.adapter.updateSettingsAtomic(
      () => ({ foo: 'bar' } as unknown as Partial<AppSettings>),
      { sync: true },
    );
    expect(h.cloudForward).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.warnLog).toHaveBeenCalledTimes(1));
    const [arg, message] = h.warnLog.mock.calls[0];
    expect(arg).toMatchObject({
      error: { code: 'TIMEOUT' },
      channel: 'settings:update',
    });
    expect(message).toMatch(/cloud forward returned error/i);
  });

  it('logs WARN when cloud forward throws', async () => {
    const h = createDesktopHarness({ forwardThrows: new Error('network down') });
    h.adapter.updateSettingsAtomic(
      () => ({ foo: 'bar' } as unknown as Partial<AppSettings>),
      { sync: true },
    );
    expect(h.cloudForward).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.warnLog).toHaveBeenCalledTimes(1));
    const [arg, message] = h.warnLog.mock.calls[0];
    expect(arg).toMatchObject({ channel: 'settings:update' });
    expect(message).toMatch(/cloud sync threw/i);
  });

  it('does NOT log WARN when cloud forward resolves with a successful result', async () => {
    const h = createDesktopHarness({ forwardResult: { ok: true } });
    h.adapter.updateSettingsAtomic(
      () => ({ foo: 'bar' } as unknown as Partial<AppSettings>),
      { sync: true },
    );
    expect(h.cloudForward).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.warnLog).not.toHaveBeenCalled();
  });
});

describe('settingsStoreAdapter — race regression', () => {
  it('two synchronous concurrent functional updaters both survive', () => {
    const h = createDesktopHarness();
    type Mutable = { a?: string; b?: string };
    h.adapter.updateSettingsAtomic(
      (current) => {
        const partial: Partial<AppSettings> = { ...((current as unknown) as Mutable), a: '1' } as Partial<AppSettings>;
        return partial;
      },
    );
    h.adapter.updateSettingsAtomic(
      (current) => {
        const partial: Partial<AppSettings> = { ...((current as unknown) as Mutable), b: '2' } as Partial<AppSettings>;
        return partial;
      },
    );
    expect((h.current as unknown as Mutable).a).toBe('1');
    expect((h.current as unknown as Mutable).b).toBe('2');
  });
});
