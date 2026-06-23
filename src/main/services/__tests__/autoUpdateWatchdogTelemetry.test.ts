/**
 * Unit tests for the watchdog telemetry payload validator.
 *
 * Stage 1 of the install completion contract — see
 * `docs/plans/260428_install_completion_contract.md` (Stage 1 + I5).
 *
 * Covers:
 * - `isWatchdogTelemetryPayload()` accepts an OLD payload (no Stage 2 fields)
 *   so a user upgrading across the Stage 2 ship can still consume telemetry
 *   left on disk by the previous version.
 * - `isWatchdogTelemetryPayload()` accepts a NEW payload with the Stage 2
 *   optional fields populated.
 * - The validator rejects malformed shapes.
 *
 * Note: `tryConsumeWatchdogTelemetry()` itself is private to autoUpdateService.
 * The validator is the testable seam that gates the write-through to the
 * persistent state store, so verifying its back-compat behaviour is the
 * Stage 1 contract test.
 */

import { describe, expect, it } from 'vitest';
import { isWatchdogTelemetryPayload } from '../autoUpdateService';

describe('isWatchdogTelemetryPayload — back-compat (I5)', () => {
  const OLD_PAYLOAD_REQUIRED_FIELDS = {
    ranAt: 1_700_000_000,
    oldPid: 12345,
    oldPidWaitSec: 12,
    shipItWaitSec: 7,
    appAlreadyRunning: false,
    openFired: true,
  };

  it('accepts an OLD payload with only the required fields (pre-Stage-2 shape)', () => {
    expect(isWatchdogTelemetryPayload(OLD_PAYLOAD_REQUIRED_FIELDS)).toBe(true);
  });

  it('accepts a NEW payload with the Stage 2 optional fields populated', () => {
    const newPayload = {
      ...OLD_PAYLOAD_REQUIRED_FIELDS,
      installFailedBundleVersionUnchanged: true,
      onDiskVersion: '0.4.33',
    };
    expect(isWatchdogTelemetryPayload(newPayload)).toBe(true);
  });

  it('accepts a NEW payload where installFailedBundleVersionUnchanged=false', () => {
    const newPayload = {
      ...OLD_PAYLOAD_REQUIRED_FIELDS,
      installFailedBundleVersionUnchanged: false,
      onDiskVersion: '0.4.34',
    };
    expect(isWatchdogTelemetryPayload(newPayload)).toBe(true);
  });

  it('accepts a NEW payload with onDiskVersion = "unknown" (plutil failure case)', () => {
    const newPayload = {
      ...OLD_PAYLOAD_REQUIRED_FIELDS,
      installFailedBundleVersionUnchanged: false,
      onDiskVersion: 'unknown',
    };
    expect(isWatchdogTelemetryPayload(newPayload)).toBe(true);
  });

  it('accepts a payload with only one of the two new fields present', () => {
    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        installFailedBundleVersionUnchanged: true,
      }),
    ).toBe(true);
    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        onDiskVersion: '0.4.34',
      }),
    ).toBe(true);
  });

  it('rejects null and non-object values', () => {
    expect(isWatchdogTelemetryPayload(null)).toBe(false);
    expect(isWatchdogTelemetryPayload(undefined)).toBe(false);
    expect(isWatchdogTelemetryPayload('not-an-object')).toBe(false);
    expect(isWatchdogTelemetryPayload(42)).toBe(false);
  });

  it('rejects payloads missing required fields', () => {
    expect(isWatchdogTelemetryPayload({})).toBe(false);

    // Missing oldPidWaitSec
    const { oldPidWaitSec: _omit, ...withoutOldPidWaitSec } = OLD_PAYLOAD_REQUIRED_FIELDS;
    void _omit;
    expect(isWatchdogTelemetryPayload(withoutOldPidWaitSec)).toBe(false);
  });

  it('rejects payloads with the wrong type for the new optional fields', () => {
    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        installFailedBundleVersionUnchanged: 'yes', // should be boolean
      }),
    ).toBe(false);

    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        onDiskVersion: 12345, // should be string
      }),
    ).toBe(false);
  });

  it('rejects payloads where required fields have wrong types', () => {
    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        appAlreadyRunning: 'true', // should be boolean
      }),
    ).toBe(false);

    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        ranAt: '1700000000', // should be number
      }),
    ).toBe(false);
  });

  it('accepts every valid externalForceKillSignal / externalForceKillGuardOutcome enum value (260622)', () => {
    for (const signal of ['none', 'TERM', 'KILL'] as const) {
      expect(
        isWatchdogTelemetryPayload({
          ...OLD_PAYLOAD_REQUIRED_FIELDS,
          externalForceKillSignal: signal,
        }),
      ).toBe(true);
    }
    for (const outcome of ['na', 'identityMatched', 'identityMismatch'] as const) {
      expect(
        isWatchdogTelemetryPayload({
          ...OLD_PAYLOAD_REQUIRED_FIELDS,
          externalForceKillGuardOutcome: outcome,
        }),
      ).toBe(true);
    }
    // Both populated together (the real on-fire shape).
    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        externalForceKillSignal: 'KILL',
        externalForceKillGuardOutcome: 'identityMatched',
      }),
    ).toBe(true);
  });

  it('rejects invalid externalForceKillSignal / externalForceKillGuardOutcome enum values (260622)', () => {
    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        externalForceKillSignal: 'BOGUS', // not in {none,TERM,KILL}
      }),
    ).toBe(false);

    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        externalForceKillGuardOutcome: 'somethingElse', // not in {na,identityMatched,identityMismatch}
      }),
    ).toBe(false);

    // Wrong type (number instead of the enum string) is also rejected.
    expect(
      isWatchdogTelemetryPayload({
        ...OLD_PAYLOAD_REQUIRED_FIELDS,
        externalForceKillSignal: 9,
      }),
    ).toBe(false);
  });
});
