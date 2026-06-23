import { getErrorReporter } from '@core/errorReporter';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import { fnvHashBase36 as hashForBreadcrumb } from '@rebel/shared';

const CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const STALL_THRESHOLD_MS = 10 * 60 * 1_000;
const ESCALATION_THROTTLE_MS = 60 * 60 * 1_000;
const STATE_TTL_MS = 2 * 60 * 60 * 1_000;

type DeviceOutboxState = {
  depth: number;
  lastDrainAt: number;
  lastSeenAt: number;
  lastEscalatedAt: number;
};

export interface DeviceOutboxSnapshot {
  depth: number;
  lastDrainAt: number;
  lastSeenAt: number;
  lastEscalatedAt: number;
  ageMs: number;
  isStalled: boolean;
}

class OutboxStallMonitor {
  private readonly stateByDevice = new Map<string, DeviceOutboxState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private nowProvider: () => number = () => Date.now();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkForStalls(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  recordDrainStarted(deviceId: string): void {
    const now = this.nowProvider();
    const state = this.stateByDevice.get(deviceId);
    if (!state) {
      this.stateByDevice.set(deviceId, {
        depth: 1,
        lastDrainAt: now,
        lastSeenAt: now,
        lastEscalatedAt: 0,
      });
      return;
    }

    state.depth += 1;
    state.lastSeenAt = now;
  }

  recordDrainCompleted(deviceId: string, itemsProcessed: number): void {
    const now = this.nowProvider();
    const state = this.stateByDevice.get(deviceId) ?? {
      depth: 0,
      lastDrainAt: now,
      lastSeenAt: now,
      lastEscalatedAt: 0,
    };

    const processed = Number.isFinite(itemsProcessed) && itemsProcessed > 0
      ? Math.floor(itemsProcessed)
      : 0;
    if (processed > 0) {
      state.depth = Math.max(0, state.depth - processed);
      state.lastDrainAt = now;
    }
    state.lastSeenAt = now;
    this.stateByDevice.set(deviceId, state);
  }

  getSnapshot(deviceId: string): DeviceOutboxSnapshot | null {
    const state = this.stateByDevice.get(deviceId);
    if (!state) return null;

    const now = this.nowProvider();
    if (now - state.lastSeenAt > STATE_TTL_MS && state.depth === 0) {
      this.stateByDevice.delete(deviceId);
      return null;
    }

    const ageMs = Math.max(0, now - state.lastDrainAt);
    return {
      depth: state.depth,
      lastDrainAt: state.lastDrainAt,
      lastSeenAt: state.lastSeenAt,
      lastEscalatedAt: state.lastEscalatedAt,
      ageMs,
      isStalled: state.depth > 0 && ageMs >= STALL_THRESHOLD_MS,
    };
  }

  checkForStalls(): void {
    const now = this.nowProvider();
    for (const [deviceId, state] of this.stateByDevice) {
      if (now - state.lastSeenAt > STATE_TTL_MS && state.depth === 0) {
        this.stateByDevice.delete(deviceId);
        continue;
      }
      if (state.depth <= 0) continue;

      const ageMs = now - state.lastDrainAt;
      if (ageMs < STALL_THRESHOLD_MS) continue;
      if (state.lastEscalatedAt > 0 && now - state.lastEscalatedAt < ESCALATION_THROTTLE_MS) continue;

      state.lastEscalatedAt = now;

      const data = {
        reason: 'stuck-outbox',
        deviceIdHash: hashForBreadcrumb(deviceId),
        depth: state.depth,
        lastDrainAt: state.lastDrainAt,
        ageMs,
      };

      getErrorReporter().addBreadcrumb({
        category: 'continuity.continuity-state',
        level: 'warning',
        message: 'stuck-outbox',
        data,
      });
      appendDiagnosticEvent(toDiagnosticContinuityTransition({
        family: 'outbox_stall',
        category: 'continuity.continuity-state',
        level: 'warning',
        message: 'stuck-outbox',
        data,
      }));
      // TODO(continuity-core): make `surface` tag configurable when desktop
      // adopts this primitive. Preserved literal during the cloud-service →
      // core relocation (audit Item #2). All current consumers are cloud.
      captureKnownCondition(
        'cloud_outbox_stuck',
        {
          tags: {
            condition: 'cloud_outbox_stuck',
            continuity_event: 'continuity-state:stuck-outbox',
            surface: 'cloud',
          },
          extra: data,
        },
        new Error('Continuity outbox appears stuck'),
      );
    }
  }

  setNowProviderForTests(provider: () => number): void {
    this.nowProvider = provider;
  }

  resetForTests(): void {
    this.stateByDevice.clear();
    this.stop();
    this.nowProvider = () => Date.now();
  }
}

const outboxStallMonitor = new OutboxStallMonitor();

export function getOutboxStallMonitor(): OutboxStallMonitor {
  return outboxStallMonitor;
}

export function resetOutboxStallMonitorForTests(): void {
  outboxStallMonitor.resetForTests();
}
