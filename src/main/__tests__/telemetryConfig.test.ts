/**
 * Tests for the preload telemetry bridge source (`getTelemetryConfigForRenderer`).
 *
 * The bridge exposes the USER's own telemetry creds to the OSS renderer and must
 * NEVER echo runtimeConfig/env. F3 hardening: the returned object is parsed
 * through `TelemetrySettingsSchema.nullable()` so it can only ever be a valid
 * telemetry shape (or null) — contract-validated at the boundary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const platformState = vi.hoisted(() => ({ isOss: false as boolean }));
const settingsState = vi.hoisted(() => ({
  telemetry: undefined as undefined | Record<string, unknown>,
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn(() => ({ ...platformState })),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({ ...settingsState })),
}));

import { getTelemetryConfigForRenderer } from '../telemetryConfig';

beforeEach(() => {
  platformState.isOss = false;
  settingsState.telemetry = undefined;
});

describe('getTelemetryConfigForRenderer', () => {
  it('enterprise (isOss=false): returns null regardless of telemetry settings', () => {
    platformState.isOss = false;
    settingsState.telemetry = { enabled: true, sentryDsn: 'https://user.invalid/1' };

    expect(getTelemetryConfigForRenderer()).toBeNull();
  });

  it('OSS with no telemetry settings: returns null', () => {
    platformState.isOss = true;
    settingsState.telemetry = undefined;

    expect(getTelemetryConfigForRenderer()).toBeNull();
  });

  it('OSS + opt-in OFF: returns the disabled config (enabled:false)', () => {
    platformState.isOss = true;
    settingsState.telemetry = { enabled: false };

    expect(getTelemetryConfigForRenderer()).toEqual({ enabled: false });
  });

  it('OSS + opt-in ON + user creds: re-shapes only the known telemetry fields', () => {
    platformState.isOss = true;
    settingsState.telemetry = {
      enabled: true,
      sentryDsn: 'https://user.invalid/1',
      rudderWriteKey: 'user-key',
      rudderDataPlaneUrl: 'https://user.dataplane.example',
      // A stray non-telemetry field must NOT cross the bridge.
      someEnvSecret: 'should-not-leak',
    };

    expect(getTelemetryConfigForRenderer()).toEqual({
      enabled: true,
      sentryDsn: 'https://user.invalid/1',
      rudderWriteKey: 'user-key',
      rudderDataPlaneUrl: 'https://user.dataplane.example',
    });
  });

  it('F3: output is always a valid telemetry shape (Zod-validated) — non-telemetry values cannot echo through', () => {
    platformState.isOss = true;
    settingsState.telemetry = {
      enabled: true,
      sentryDsn: 'https://user.invalid/1',
      extra: { runtimeConfig: 'leaky' },
    } as Record<string, unknown>;

    const result = getTelemetryConfigForRenderer();
    expect(result).not.toBeNull();
    // Only the schema-known keys survive.
    expect(Object.keys(result ?? {}).sort()).toEqual(['enabled', 'sentryDsn']);
  });
});
