// CORE-MOVE-EXEMPT: Desktop-only adapter that requires Electron powerSaveBlocker APIs.
import { powerSaveBlocker } from 'electron';
import { createScopedLogger } from '@core/logger';
import type { PowerSaveBlocker, PowerSaveBlockerStatus } from '@core/powerSaveBlocker';

const log = createScopedLogger({ service: 'powerSaveBlocker' });

const MAX_BLOCK_DURATION_MS = 30 * 60 * 1000; // 30 min watchdog

interface BlockState {
  blockerId: number | null;
  reasons: Map<string, number>;
  startedAt: number | null;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
}

export class ElectronPowerSaveBlocker implements PowerSaveBlocker {
  private readonly state: BlockState = {
    blockerId: null,
    reasons: new Map(),
    startedAt: null,
    watchdogTimer: null,
  };

  acquireBlock(reason: string): void {
    const current = this.state.reasons.get(reason) ?? 0;
    this.state.reasons.set(reason, current + 1);
    if (this.state.blockerId === null) {
      this.startBlocker();
    }
    const refCount = this.getRefCount();
    if (refCount === 1) {
      log.info({ reason }, 'Power save block acquired (system sleep prevented)');
    } else {
      log.info({ reason, refCount }, 'Power save block acquired (additional hold)');
    }
  }

  releaseBlock(reason: string): void {
    const current = this.state.reasons.get(reason) ?? 0;
    if (current <= 1) {
      this.state.reasons.delete(reason);
    } else {
      this.state.reasons.set(reason, current - 1);
    }
    const refCount = this.getRefCount();
    if (refCount === 0) {
      this.stopBlocker();
      log.info({ reason }, 'Power save block released (system sleep allowed)');
    } else {
      log.info({ reason, refCount }, 'Power save block released (still held by other turns)');
    }
  }

  getBlockerStatus(): PowerSaveBlockerStatus {
    return {
      active: this.state.blockerId !== null,
      refCount: this.getRefCount(),
      reasons: Object.fromEntries(this.state.reasons),
      startedAt: this.state.startedAt,
      durationMs: this.state.startedAt ? Date.now() - this.state.startedAt : null,
    };
  }

  dispose(): void {
    this.forceRelease();
  }

  resetForTesting(): void {
    this.forceRelease();
  }

  private getRefCount(): number {
    let total = 0;
    for (const count of this.state.reasons.values()) total += count;
    return total;
  }

  private startBlocker(): void {
    if (this.state.blockerId !== null) return;
    try {
      this.state.blockerId = powerSaveBlocker.start('prevent-app-suspension');
      this.state.startedAt = Date.now();
      log.info({ blockerId: this.state.blockerId }, 'Power save blocker started');

      this.state.watchdogTimer = setTimeout(() => {
        log.warn(
          { durationMs: MAX_BLOCK_DURATION_MS, reasons: Object.fromEntries(this.state.reasons) },
          'Power save blocker watchdog triggered — force releasing',
        );
        this.forceRelease();
      }, MAX_BLOCK_DURATION_MS);
    } catch (err) {
      log.warn({ err }, 'Failed to start power save blocker');
    }
  }

  private stopBlocker(): void {
    if (this.state.blockerId === null) return;
    try {
      if (powerSaveBlocker.isStarted(this.state.blockerId)) {
        powerSaveBlocker.stop(this.state.blockerId);
      }
    } catch (err) {
      log.warn({ err }, 'Failed to stop power save blocker');
    }
    const durationMs = this.state.startedAt ? Date.now() - this.state.startedAt : 0;
    log.info({ blockerId: this.state.blockerId, durationMs }, 'Power save blocker stopped');
    if (this.state.watchdogTimer) {
      clearTimeout(this.state.watchdogTimer);
      this.state.watchdogTimer = null;
    }
    this.state.blockerId = null;
    this.state.startedAt = null;
  }

  private forceRelease(): void {
    this.state.reasons.clear();
    this.stopBlocker();
  }
}
