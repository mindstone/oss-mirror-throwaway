/**
 * Startup Scheduler Service
 * 
 * Coordinates deferred startup tasks to avoid "thundering herd" at app launch.
 * Tasks are executed in phases with configurable delays, and automation catch-ups
 * are staggered sequentially rather than running simultaneously.
 * 
 * Usage:
 *   startupScheduler.schedule('calendar-sync', 30_000, () => startDirectCalendarSync());
 *   startupScheduler.scheduleAutomationCatchUp(scheduler);
 */

import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'startupScheduler' });

interface ScheduledTask {
  name: string;
  delay: number;
  fn: () => Promise<void> | void;
  timer?: ReturnType<typeof setTimeout>;
  started?: number;
  completed?: number;
  error?: string;
}

// Staggered catch-up configuration
const CATCHUP_INITIAL_DELAY_MS = 60_000; // 60s before first catch-up
const CATCHUP_INTERVAL_MS = 30_000; // 30s between catch-ups
const CATCHUP_PAUSE_ON_ACTIVITY_MS = 120_000; // Pause catch-up if user active within 2min

class StartupScheduler {
  private tasks = new Map<string, ScheduledTask>();
  private isShuttingDown = false;
  private userLastActiveAt = 0;
  private catchUpQueue: Array<{ automationId: string; execute: () => Promise<void> }> = [];
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private isCatchUpRunning = false;

  /**
   * Schedule a task to run after a delay.
   * If the same task name is scheduled again, the previous one is cancelled.
   */
  schedule(name: string, delayMs: number, fn: () => Promise<void> | void): void {
    if (this.isShuttingDown) {
      log.debug({ name }, 'Ignoring schedule - shutdown in progress');
      return;
    }

    // Cancel existing task with same name
    this.cancel(name);

    const task: ScheduledTask = {
      name,
      delay: delayMs,
      fn,
    };

    task.timer = setTimeout(() => {
      fireAndForget((async () => {
        task.started = Date.now();
        log.info({ name, delayMs }, 'Starting scheduled startup task');

        try {
          await fn();
          task.completed = Date.now();
          log.info({ name, durationMs: task.completed - task.started }, 'Startup task completed');
        } catch (error) {
          task.error = String(error);
          task.completed = Date.now();
          log.warn({ name, error: task.error }, 'Startup task failed');
        }
      })(), `startupScheduler.${name}`);
    }, delayMs);

    this.tasks.set(name, task);
    log.debug({ name, delayMs }, 'Scheduled startup task');
  }

  /**
   * Cancel a scheduled task.
   */
  cancel(name: string): boolean {
    const task = this.tasks.get(name);
    if (task?.timer) {
      clearTimeout(task.timer);
      this.tasks.delete(name);
      log.debug({ name }, 'Cancelled startup task');
      return true;
    }
    return false;
  }

  /**
   * Record user activity to potentially pause catch-up execution.
   */
  recordUserActivity(): void {
    this.userLastActiveAt = Date.now();
  }

  /**
   * Check if user has been active recently.
   */
  private isUserActive(): boolean {
    return (Date.now() - this.userLastActiveAt) < CATCHUP_PAUSE_ON_ACTIVITY_MS;
  }

  /**
   * Queue an automation catch-up for staggered execution.
   * All queued catch-ups will execute sequentially with delays between them.
   */
  queueAutomationCatchUp(automationId: string, execute: () => Promise<void>): void {
    if (this.isShuttingDown) return;

    this.catchUpQueue.push({ automationId, execute });
    log.debug({ automationId, queueLength: this.catchUpQueue.length }, 'Queued automation catch-up');

    // Start processing if not already running
    if (!this.catchUpTimer && !this.isCatchUpRunning) {
      this.scheduleCatchUpProcessing(CATCHUP_INITIAL_DELAY_MS);
    }
  }

  /**
   * Schedule the next catch-up processing cycle.
   */
  private scheduleCatchUpProcessing(delayMs: number): void {
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
    }

    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      fireAndForget(this.processCatchUpQueue(), 'startupScheduler.processCatchUpQueue');
    }, delayMs);

    log.debug({ delayMs, queueLength: this.catchUpQueue.length }, 'Scheduled catch-up processing');
  }

  /**
   * Process the catch-up queue, executing one automation at a time.
   */
  private async processCatchUpQueue(): Promise<void> {
    if (this.isShuttingDown || this.isCatchUpRunning) return;

    // Check if user is active - defer if so
    if (this.isUserActive()) {
      log.info('Deferring automation catch-up - user is active');
      this.scheduleCatchUpProcessing(CATCHUP_PAUSE_ON_ACTIVITY_MS);
      return;
    }

    const next = this.catchUpQueue.shift();
    if (!next) {
      log.debug('Catch-up queue empty');
      return;
    }

    this.isCatchUpRunning = true;
    log.info({ automationId: next.automationId, remaining: this.catchUpQueue.length }, 'Executing staggered catch-up');

    try {
      await next.execute();
    } catch (error) {
      log.warn({ automationId: next.automationId, error: String(error) }, 'Catch-up execution failed');
    } finally {
      this.isCatchUpRunning = false;
    }

    // Schedule next catch-up if queue not empty
    if (this.catchUpQueue.length > 0) {
      this.scheduleCatchUpProcessing(CATCHUP_INTERVAL_MS);
    }
  }

  /**
   * Get the current catch-up queue length.
   */
  getCatchUpQueueLength(): number {
    return this.catchUpQueue.length;
  }

  /**
   * Cancel all pending tasks and catch-ups.
   */
  shutdown(): void {
    this.isShuttingDown = true;

    // Cancel all scheduled tasks
    for (const task of this.tasks.values()) {
      if (task.timer) {
        clearTimeout(task.timer);
      }
    }
    this.tasks.clear();

    // Cancel catch-up processing
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    this.catchUpQueue = [];

    log.info('Startup scheduler shutdown');
  }

  /**
   * Get diagnostics about scheduled tasks.
   */
  getDiagnostics(): {
    pendingTasks: string[];
    catchUpQueueLength: number;
    isCatchUpRunning: boolean;
  } {
    const pendingTasks = Array.from(this.tasks.entries())
      .filter(([_, task]) => !task.completed)
      .map(([name]) => name);

    return {
      pendingTasks,
      catchUpQueueLength: this.catchUpQueue.length,
      isCatchUpRunning: this.isCatchUpRunning,
    };
  }
}

export const startupScheduler = new StartupScheduler();
