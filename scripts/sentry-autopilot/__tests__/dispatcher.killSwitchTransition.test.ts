/**
 * Kill-switch transition notification tests.
 *
 * `maybeReportKillSwitchTransition` is the dispatcher-side gate that turns the
 * per-tick `reportKillSwitch` spam (one Slack per cron run while STOP/PAUSE is
 * present) into one Slack PER TRANSITION (clear → paused, paused → resumed,
 * etc.).
 *
 * Marker file: `<stateDir>/.kill_switch_notification_state` (`'pause'`,
 * `'stop'`, or absent). The marker is updated AFTER the Slack attempt so a
 * Slack failure caught by `executeOperation` does NOT re-Slack next tick —
 * pending-action retry handles delivery.
 *
 * Transition matrix verified below:
 *
 *   prev   →   curr     expected call
 *   ─────────────────────────────────────────────────────────
 *   null   →   null     no-op                            (case 1)
 *   null   →   pause    reportKillSwitch('pause')        (case 2)
 *   null   →   stop     reportKillSwitch('stop')         (case 3)
 *   pause  →   pause    no-op                            (case 4)
 *   stop   →   stop     no-op                            (case 5)
 *   pause  →   null     reportKillSwitchResumed('pause') (case 6)
 *   stop   →   null     reportKillSwitchResumed('stop')  (case 7)
 *   pause  →   stop     reportKillSwitch('stop')         (case 8 — escalation)
 *   stop   →   pause    reportKillSwitch('pause')        (case 9 — de-escalation)
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import {
  maybeReportKillSwitchTransition,
  readLastNotifiedKillSwitchState,
} from '../dispatcher.ts';
import type { Reporter } from '../reporter.ts';

let stateDir: string;

function makeConfig(): AutopilotConfig {
  return {
    sentryAuthToken: 'test-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: 'test-linear-key',
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    stateDir,
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/repo',
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

function makeReporterMock(): {
  reporter: Reporter;
  reportKillSwitch: ReturnType<typeof vi.fn>;
  reportKillSwitchResumed: ReturnType<typeof vi.fn>;
} {
  const reportKillSwitch = vi.fn(async () => undefined);
  const reportKillSwitchResumed = vi.fn(async () => undefined);
  const reporter = { reportKillSwitch, reportKillSwitchResumed } as unknown as Reporter;
  return { reporter, reportKillSwitch, reportKillSwitchResumed };
}

function writeSentinel(name: 'STOP' | 'PAUSE'): void {
  writeFileSync(path.join(stateDir, name), '');
}

function writeMarker(state: 'pause' | 'stop'): void {
  writeFileSync(path.join(stateDir, '.kill_switch_notification_state'), `${state}\n`);
}

function markerExists(): boolean {
  return existsSync(path.join(stateDir, '.kill_switch_notification_state'));
}

function readMarker(): string {
  return readFileSync(path.join(stateDir, '.kill_switch_notification_state'), 'utf8').trim();
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'killswitch-transition-test-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('maybeReportKillSwitchTransition', () => {
  it('case 1: null → null is a no-op (no Slack, no marker write)', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();

    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).not.toHaveBeenCalled();
    expect(reportKillSwitchResumed).not.toHaveBeenCalled();
    expect(markerExists()).toBe(false);
  });

  it('case 2: null → pause sends paused Slack once and writes marker', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();
    writeSentinel('PAUSE');

    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).toHaveBeenCalledTimes(1);
    expect(reportKillSwitch).toHaveBeenCalledWith('pause');
    expect(reportKillSwitchResumed).not.toHaveBeenCalled();
    expect(readMarker()).toBe('pause');
  });

  it('case 3: null → stop sends stopped Slack once and writes marker', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();
    writeSentinel('STOP');

    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).toHaveBeenCalledTimes(1);
    expect(reportKillSwitch).toHaveBeenCalledWith('stop');
    expect(reportKillSwitchResumed).not.toHaveBeenCalled();
    expect(readMarker()).toBe('stop');
  });

  it('case 4: pause → pause is silent (the canonical anti-spam case)', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();
    writeSentinel('PAUSE');
    writeMarker('pause');

    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).not.toHaveBeenCalled();
    expect(reportKillSwitchResumed).not.toHaveBeenCalled();
    expect(readMarker()).toBe('pause');
  });

  it('case 5: stop → stop is silent (the canonical anti-spam case)', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();
    writeSentinel('STOP');
    writeMarker('stop');

    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).not.toHaveBeenCalled();
    expect(reportKillSwitchResumed).not.toHaveBeenCalled();
    expect(readMarker()).toBe('stop');
  });

  it('case 6: pause → null sends resumed Slack and removes marker', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();
    writeMarker('pause');

    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).not.toHaveBeenCalled();
    expect(reportKillSwitchResumed).toHaveBeenCalledTimes(1);
    expect(reportKillSwitchResumed).toHaveBeenCalledWith('pause');
    expect(markerExists()).toBe(false);
  });

  it('case 7: stop → null sends resumed Slack with stop context and removes marker', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();
    writeMarker('stop');

    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).not.toHaveBeenCalled();
    expect(reportKillSwitchResumed).toHaveBeenCalledTimes(1);
    expect(reportKillSwitchResumed).toHaveBeenCalledWith('stop');
    expect(markerExists()).toBe(false);
  });

  it('case 8: pause → stop (escalation) sends stopped Slack and updates marker', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();
    writeSentinel('STOP');
    writeMarker('pause');

    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).toHaveBeenCalledTimes(1);
    expect(reportKillSwitch).toHaveBeenCalledWith('stop');
    expect(reportKillSwitchResumed).not.toHaveBeenCalled();
    expect(readMarker()).toBe('stop');
  });

  it('case 9: stop → pause (de-escalation) sends paused Slack and updates marker', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();
    // PAUSE present, STOP absent; previously notified as 'stop'
    writeSentinel('PAUSE');
    writeMarker('stop');

    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).toHaveBeenCalledTimes(1);
    expect(reportKillSwitch).toHaveBeenCalledWith('pause');
    expect(reportKillSwitchResumed).not.toHaveBeenCalled();
    expect(readMarker()).toBe('pause');
  });

  it('idempotency: two ticks with PAUSE present and marker already pause never re-Slack', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();
    writeSentinel('PAUSE');
    writeMarker('pause');

    await maybeReportKillSwitchTransition(makeConfig(), reporter);
    await maybeReportKillSwitchTransition(makeConfig(), reporter);
    await maybeReportKillSwitchTransition(makeConfig(), reporter);

    expect(reportKillSwitch).not.toHaveBeenCalled();
    expect(reportKillSwitchResumed).not.toHaveBeenCalled();
  });

  it('end-to-end transition cycle: clear → pause → pause → clear emits exactly 2 Slacks', async () => {
    const { reporter, reportKillSwitch, reportKillSwitchResumed } = makeReporterMock();

    // Tick 1: clear → clear (operator hasn't paused yet)
    await maybeReportKillSwitchTransition(makeConfig(), reporter);
    expect(reportKillSwitch).toHaveBeenCalledTimes(0);

    // Tick 2: operator drops PAUSE between ticks → fires paused Slack
    writeSentinel('PAUSE');
    await maybeReportKillSwitchTransition(makeConfig(), reporter);
    expect(reportKillSwitch).toHaveBeenCalledTimes(1);
    expect(reportKillSwitch).toHaveBeenLastCalledWith('pause');

    // Tick 3: still paused → silent
    await maybeReportKillSwitchTransition(makeConfig(), reporter);
    expect(reportKillSwitch).toHaveBeenCalledTimes(1);
    expect(reportKillSwitchResumed).toHaveBeenCalledTimes(0);

    // Tick 4: operator removes PAUSE → fires resumed Slack
    rmSync(path.join(stateDir, 'PAUSE'));
    await maybeReportKillSwitchTransition(makeConfig(), reporter);
    expect(reportKillSwitchResumed).toHaveBeenCalledTimes(1);
    expect(reportKillSwitchResumed).toHaveBeenLastCalledWith('pause');

    // Tick 5: still clear → silent
    await maybeReportKillSwitchTransition(makeConfig(), reporter);
    expect(reportKillSwitch).toHaveBeenCalledTimes(1);
    expect(reportKillSwitchResumed).toHaveBeenCalledTimes(1);
  });
});

describe('readLastNotifiedKillSwitchState', () => {
  it('returns null when marker file is absent', () => {
    expect(readLastNotifiedKillSwitchState(makeConfig())).toBeNull();
  });

  it('returns pause when marker file contains pause', () => {
    writeMarker('pause');
    expect(readLastNotifiedKillSwitchState(makeConfig())).toBe('pause');
  });

  it('returns stop when marker file contains stop', () => {
    writeMarker('stop');
    expect(readLastNotifiedKillSwitchState(makeConfig())).toBe('stop');
  });

  it('returns null when marker file contains an unrecognized value (defensive)', () => {
    writeFileSync(path.join(stateDir, '.kill_switch_notification_state'), 'garbage\n');
    expect(readLastNotifiedKillSwitchState(makeConfig())).toBeNull();
  });
});
