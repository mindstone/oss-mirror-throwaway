/**
 * Turn Concurrency Limiter
 *
 * Limits the number of concurrent agent turns to prevent resource exhaustion.
 * Used by both local (agentTurnService) and cloud (cloudRouter) paths.
 *
 * When the limit is reached, new turns wait in a FIFO queue. This is preferable
 * to rejection because approval continuations (from "Allow all") legitimately
 * fire multiple turns across different sessions simultaneously.
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'turnConcurrencyLimiter' });

export type TurnLane = 'foreground' | 'background';

type Waiter = { resolve: () => void; sessionId: string };

type LanedWaiter = Waiter & { lane: TurnLane };

/**
 * Dual-lane concurrency limiter with separate caps for foreground and background turns.
 * Foreground (user-initiated) turns get priority slots so background automations
 * can't starve interactive conversations.
 */
class DualLaneTurnConcurrencyLimiter {
  private activeForeground = 0;
  private activeBackground = 0;
  private readonly waiters: LanedWaiter[] = [];

  constructor(
    private readonly maxForeground: number,
    private readonly maxBackground: number,
  ) {}

  async acquire(sessionId: string, lane: TurnLane = 'foreground'): Promise<() => void> {
    if (this.hasSlot(lane)) {
      this.increment(lane);
      log.debug(
        { fg: this.activeForeground, bg: this.activeBackground, queued: this.waiters.length, lane, sessionId },
        'Turn slot acquired immediately',
      );
      return this.createRelease(sessionId, lane);
    }

    const limit = lane === 'foreground' ? this.maxForeground : this.maxBackground;
    log.info(
      { fg: this.activeForeground, bg: this.activeBackground, queued: this.waiters.length, lane, limit, sessionId },
      'Turn queued — waiting for slot',
    );

    return new Promise<() => void>((resolve) => {
      this.waiters.push({
        sessionId,
        lane,
        resolve: () => {
          this.increment(lane);
          log.debug(
            { fg: this.activeForeground, bg: this.activeBackground, queued: this.waiters.length, lane, sessionId },
            'Turn slot acquired from queue',
          );
          resolve(this.createRelease(sessionId, lane));
        },
      });
    });
  }

  private hasSlot(lane: TurnLane): boolean {
    return lane === 'foreground'
      ? this.activeForeground < this.maxForeground
      : this.activeBackground < this.maxBackground;
  }

  private increment(lane: TurnLane): void {
    if (lane === 'foreground') this.activeForeground++;
    else this.activeBackground++;
  }

  private decrement(lane: TurnLane): void {
    if (lane === 'foreground') this.activeForeground--;
    else this.activeBackground--;
  }

  private createRelease(sessionId: string, lane: TurnLane): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.decrement(lane);
      log.debug(
        { fg: this.activeForeground, bg: this.activeBackground, queued: this.waiters.length, lane, sessionId },
        'Turn slot released',
      );
      this.drainQueue();
    };
  }

  private drainQueue(): void {
    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      if (this.hasSlot(waiter.lane)) {
        this.waiters.splice(i, 1);
        waiter.resolve();
        return;
      }
    }
  }

  getActive(): number {
    return this.activeForeground + this.activeBackground;
  }

  getActiveForeground(): number {
    return this.activeForeground;
  }

  getActiveBackground(): number {
    return this.activeBackground;
  }

  getQueued(): number {
    return this.waiters.length;
  }
}

/**
 * Singleton limiter for local agent turns.
 * Foreground (4): user conversations, manual agent sessions.
 * Background (2): automations, meeting prep, memory updates.
 */
export const localTurnLimiter = new DualLaneTurnConcurrencyLimiter(4, 2);
