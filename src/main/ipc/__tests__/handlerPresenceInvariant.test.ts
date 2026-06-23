import { describe, expect, it, vi } from 'vitest';
import { MapHandlerRegistry } from '@core/handlerRegistry/mapHandlerRegistry';
import { getChannelMetadata } from '@shared/ipc/channelMetadata';
import { allChannels } from '@shared/ipc/contracts';
import { defineSyncChannel } from '@shared/ipc/schemas/common';
import { InvariantViolationError } from '@shared/utils/invariant';
import { z } from 'zod';
import {
  assertHandlerPresence,
  createIpcDisabledError,
  getHandlerPresenceMode,
  isCiEnvironment,
  isInvariantDisabled,
  isInvokeChannel,
} from '../handlerPresenceInvariant';

function createRegistry(channels: readonly string[]): MapHandlerRegistry {
  const registry = new MapHandlerRegistry();
  for (const channel of channels) {
    registry.register(channel, async () => ({ ok: true }));
  }
  return registry;
}

function createReporterSpy() {
  return {
    addBreadcrumb: vi.fn(),
    captureMessage: vi.fn(),
  };
}

function invokeDef(): { type: 'invoke' } {
  return { type: 'invoke' };
}

describe('handlerPresenceInvariant', () => {
  it('does not fire when all channels are registered', () => {
    const testChannels = {
      'alpha:ready': invokeDef(),
      'beta:ready': invokeDef(),
    } as const;
    const registry = createRegistry(Object.keys(testChannels));

    expect(() =>
      assertHandlerPresence({
        allChannels: testChannels,
        registry,
        mode: 'fail-hard',
      }),
    ).not.toThrow();
  });

  it('fires in fail-hard mode when a required-at-boot channel is missing', () => {
    const testChannels = {
      'required:channel': invokeDef(),
    } as const;
    const registry = createRegistry([]);

    expect(() =>
      assertHandlerPresence({
        allChannels: testChannels,
        registry,
        mode: 'fail-hard',
      }),
    ).toThrow(InvariantViolationError);
  });

  it('does not fire when a missing channel is marked lazyRegistered', () => {
    const testChannels = { 'lazy:channel': invokeDef() } as const;
    const registry = createRegistry([]);

    expect(() =>
      assertHandlerPresence({
        allChannels: testChannels,
        registry,
        mode: 'fail-hard',
        getMetadata: () => ({
          requiredAtBoot: true,
          lazyRegistered: true,
          bypass: false,
          productionFailurePolicy: 'sentry-only',
        }),
      }),
    ).not.toThrow();
  });

  it('does not fire when a missing channel is marked bypass', () => {
    const testChannels = { 'bypass:channel': invokeDef() } as const;
    const registry = createRegistry([]);

    expect(() =>
      assertHandlerPresence({
        allChannels: testChannels,
        registry,
        mode: 'fail-hard',
        getMetadata: () => ({
          requiredAtBoot: true,
          lazyRegistered: false,
          bypass: true,
          productionFailurePolicy: 'sentry-only',
        }),
      }),
    ).not.toThrow();
  });

  it('degrades a missing channel in production mode when policy is degrade-channel', async () => {
    const testChannels = { 'degrade:channel': invokeDef() } as const;
    const registry = createRegistry([]);
    const reporter = createReporterSpy();
    const mode = getHandlerPresenceMode({ isPackaged: true, ci: false });

    assertHandlerPresence({
      allChannels: testChannels,
      registry,
      mode,
      errorReporter: reporter,
      getMetadata: () => ({
        requiredAtBoot: true,
        lazyRegistered: false,
        bypass: false,
        productionFailurePolicy: 'degrade-channel',
      }),
    });

    const degradedHandler = registry.get('degrade:channel');
    expect(degradedHandler).toBeTypeOf('function');
    if (!degradedHandler) {
      throw new Error('Expected degrade:channel handler to be installed');
    }

    await expect(degradedHandler(undefined)).resolves.toEqual(
      createIpcDisabledError('degrade:channel'),
    );
    expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(reporter.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('returns the expected handler-presence mode for all packaged/ci combinations', () => {
    expect(getHandlerPresenceMode({ isPackaged: false, ci: false })).toBe('fail-hard');
    expect(getHandlerPresenceMode({ isPackaged: false, ci: true })).toBe('fail-hard');
    expect(getHandlerPresenceMode({ isPackaged: true, ci: false })).toBe('production-degrade');
    expect(getHandlerPresenceMode({ isPackaged: true, ci: true })).toBe('fail-hard');
  });

  it('passes a full-coverage fixture when every non-bypass contract channel is registered', () => {
    const registry = new MapHandlerRegistry();
    for (const [channel, def] of Object.entries(allChannels)) {
      if (!isInvokeChannel(def)) continue;
      if (getChannelMetadata(channel).bypass) continue;
      registry.register(channel, async () => ({ ok: true }));
    }

    expect(() =>
      assertHandlerPresence({
        allChannels,
        registry,
        mode: 'fail-hard',
      }),
    ).not.toThrow();
  });

  describe('Stage 4 fix-up: sync-channel exclusion', () => {
    it('does not flag sync channels as missing (they register via ipcMain.on outside HandlerRegistry)', () => {
      const syncDef = defineSyncChannel({
        channel: 'demo:save-sync',
        request: z.void(),
        response: z.boolean(),
      });
      const testChannels = {
        'demo:save-sync': syncDef,
      } as const;
      const registry = createRegistry([]);

      expect(() =>
        assertHandlerPresence({
          allChannels: testChannels,
          registry,
          mode: 'fail-hard',
        }),
      ).not.toThrow();
    });

    it('does not flag the real sessions:save-sync / folders:save-sync sync channels (regression)', () => {
      const registry = new MapHandlerRegistry();
      for (const [channel, def] of Object.entries(allChannels)) {
        if (!isInvokeChannel(def)) continue;
        if (getChannelMetadata(channel).bypass) continue;
        registry.register(channel, async () => ({ ok: true }));
      }

      // Intentionally NOT registering the two sync channels — they live
      // outside HandlerRegistry. The invariant must still pass.
      expect(() =>
        assertHandlerPresence({
          allChannels,
          registry,
          mode: 'fail-hard',
        }),
      ).not.toThrow();
    });

    it('isInvokeChannel filters correctly', () => {
      expect(isInvokeChannel({ type: 'invoke' })).toBe(true);
      expect(isInvokeChannel({ type: 'sync' })).toBe(false);
      expect(isInvokeChannel({})).toBe(false);
      expect(isInvokeChannel(null)).toBe(false);
      expect(isInvokeChannel(undefined)).toBe(false);
      expect(isInvokeChannel('invoke')).toBe(false);
    });
  });

  describe('Stage 4 fix-up: broadened CI detection', () => {
    it('detects CI="1"', () => {
      expect(isCiEnvironment({ CI: '1' } as NodeJS.ProcessEnv)).toBe(true);
    });
    it('detects CI="true" (GitHub Actions, CircleCI, Vercel, Netlify, GitLab CI)', () => {
      expect(isCiEnvironment({ CI: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    });
    it('detects CI="TRUE" (case-insensitive)', () => {
      expect(isCiEnvironment({ CI: 'TRUE' } as NodeJS.ProcessEnv)).toBe(true);
    });
    it('detects GITHUB_ACTIONS="true" as fallback (CI accidentally unset in matrix step)', () => {
      expect(isCiEnvironment({ GITHUB_ACTIONS: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    });
    it('returns false for empty env', () => {
      expect(isCiEnvironment({} as NodeJS.ProcessEnv)).toBe(false);
    });
    it('returns false for CI="false" (explicit disable)', () => {
      expect(isCiEnvironment({ CI: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    });
    it('returns false for CI="" (some CIs unset this for opt-out steps)', () => {
      expect(isCiEnvironment({ CI: '' } as NodeJS.ProcessEnv)).toBe(false);
    });
  });

  describe('Stage 4 fix-up: emergency env override', () => {
    it('isInvariantDisabled returns true only for value "1"', () => {
      expect(isInvariantDisabled({} as NodeJS.ProcessEnv)).toBe(false);
      expect(isInvariantDisabled({ REBEL_HANDLER_PRESENCE_INVARIANT_DISABLED: '1' } as NodeJS.ProcessEnv)).toBe(true);
      expect(isInvariantDisabled({ REBEL_HANDLER_PRESENCE_INVARIANT_DISABLED: 'true' } as NodeJS.ProcessEnv)).toBe(false);
      expect(isInvariantDisabled({ REBEL_HANDLER_PRESENCE_INVARIANT_DISABLED: '0' } as NodeJS.ProcessEnv)).toBe(false);
    });

    it('disabledByEnv=true short-circuits the invariant even when channels are missing', () => {
      const testChannels = { 'required:channel': invokeDef() } as const;
      const registry = createRegistry([]);
      const reporter = createReporterSpy();

      expect(() =>
        assertHandlerPresence({
          allChannels: testChannels,
          registry,
          mode: 'fail-hard',
          errorReporter: reporter,
          disabledByEnv: true,
        }),
      ).not.toThrow();
      expect(reporter.captureMessage).not.toHaveBeenCalled();
    });
  });

  describe('Stage 4 fix-up: batched Sentry capture', () => {
    it('emits a single captureMessage with missingChannels[] in production-degrade mode', () => {
      const testChannels = {
        'missing:a': invokeDef(),
        'missing:b': invokeDef(),
        'missing:c': invokeDef(),
      } as const;
      const registry = createRegistry([]);
      const reporter = createReporterSpy();

      assertHandlerPresence({
        allChannels: testChannels,
        registry,
        mode: 'production-degrade',
        errorReporter: reporter,
        getMetadata: () => ({
          requiredAtBoot: true,
          lazyRegistered: false,
          bypass: false,
          productionFailurePolicy: 'sentry-only',
        }),
      });

      expect(reporter.captureMessage).toHaveBeenCalledTimes(1);
      expect(reporter.addBreadcrumb).toHaveBeenCalledTimes(1);
      const [, options] = reporter.captureMessage.mock.calls[0]!;
      expect(options.extra.missingChannelCount).toBe(3);
      expect(options.extra.missingChannels).toEqual(['missing:a', 'missing:b', 'missing:c']);
      expect(options.extra.perPolicyBreakdown).toEqual({ 'sentry-only': 3 });
      expect(options.fingerprint).toEqual(['ipc-handler-presence', 'production-degrade', '3']);
    });
  });

  describe('Stage 4 fix-up: sentry-only does NOT install synthetic handler', () => {
    it('does not register a substitute handler for sentry-only policy', () => {
      const testChannels = { 'sentry-only:channel': invokeDef() } as const;
      const registry = createRegistry([]);
      const reporter = createReporterSpy();

      assertHandlerPresence({
        allChannels: testChannels,
        registry,
        mode: 'production-degrade',
        errorReporter: reporter,
        getMetadata: () => ({
          requiredAtBoot: true,
          lazyRegistered: false,
          bypass: false,
          productionFailurePolicy: 'sentry-only',
        }),
      });

      expect(registry.get('sentry-only:channel')).toBeUndefined();
      expect(reporter.captureMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('Stage 4 fix-up: production-degrade aggregates fail-hard policy', () => {
    it('throws once after batched observability when any missing channel is fail-hard', () => {
      const testChannels = {
        'observe:a': invokeDef(),
        'fail-hard:b': invokeDef(),
      } as const;
      const registry = createRegistry([]);
      const reporter = createReporterSpy();

      expect(() =>
        assertHandlerPresence({
          allChannels: testChannels,
          registry,
          mode: 'production-degrade',
          errorReporter: reporter,
          getMetadata: (channel) => ({
            requiredAtBoot: true,
            lazyRegistered: false,
            bypass: false,
            productionFailurePolicy: channel.startsWith('fail-hard') ? 'fail-hard' : 'sentry-only',
          }),
        }),
      ).toThrow(InvariantViolationError);

      // Observability still fired before the throw.
      expect(reporter.captureMessage).toHaveBeenCalledTimes(1);
    });
  });
});
