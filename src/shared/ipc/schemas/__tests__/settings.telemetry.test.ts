/**
 * Zod contract round-trip for the OSS telemetry settings field (B6.a / Stage
 * 3a, 260607_oss-b6-launch-polish). The IPC `settings:update` contract must
 * accept the new top-level `telemetry` field so the renderer can persist the
 * user's opt-in + creds (validate:fast enforces these contracts).
 */
import { describe, expect, it } from 'vitest';
import { TelemetrySettingsSchema } from '../settings';

describe('TelemetrySettingsSchema (OSS telemetry creds)', () => {
  it('round-trips a fully populated telemetry object', () => {
    const input = {
      enabled: true,
      sentryDsn: 'https://[external-email]/1',
      rudderWriteKey: 'user-write-key',
      rudderDataPlaneUrl: 'https://user.dataplane.example',
    };
    const parsed = TelemetrySettingsSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  it('accepts the minimal disabled shape (enabled only)', () => {
    expect(TelemetrySettingsSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('requires the `enabled` master toggle', () => {
    expect(() => TelemetrySettingsSchema.parse({ sentryDsn: 'x' })).toThrow();
  });

  it('rejects a non-boolean `enabled`', () => {
    expect(() => TelemetrySettingsSchema.parse({ enabled: 'yes' })).toThrow();
  });
});
