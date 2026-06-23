import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { getProcessStartTimeMs } from './processStartTime';

/**
 * Default Vitest integration coverage for the real OS process-start-time path.
 * Keep this intentionally small: parser drift fails on the first read, while
 * five child-process readings catch basic scheduler variance without turning
 * the default Vitest job into a subprocess enthusiasm seminar.
 *
 * Runtime budget (2026-05-01 local): 1.05s wall clock via
 * `npm test -- src/core/utils/processStartTime.integration.test.ts`.
 */
describe('getProcessStartTimeMs integration', () => {
  let child: ChildProcess | null = null;

  afterAll(() => {
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // Best-effort cleanup for integration process.
      }
    }
  });

  it('returns stable identity-comparable start times for process.pid and a spawned child', async () => {
    const first = await getProcessStartTimeMs(process.pid);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await getProcessStartTimeMs(process.pid);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Math.abs((first ?? 0) - (second ?? 0))).toBeLessThan(500);

    const uptimeDerivedStartMs = Date.now() - (process.uptime() * 1000);
    expect(Math.abs((first ?? 0) - uptimeDerivedStartMs)).toBeLessThanOrEqual(60_000);

    child = spawn('node', ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const childPid = child.pid;
    expect(typeof childPid).toBe('number');

    if (!childPid) {
      throw new Error('Spawned child process has no pid');
    }

    const readings: number[] = [];
    try {
      for (let index = 0; index < 5; index += 1) {
        const reading = await getProcessStartTimeMs(childPid);
        expect(reading).not.toBeNull();
        if (reading !== null) {
          readings.push(reading);
        }
      }
    } finally {
      if (child && !child.killed) {
        try {
          child.kill();
        } catch {
          // Best-effort cleanup for integration process.
        }
      }
      child = null;
    }

    const driftMs = Math.max(...readings) - Math.min(...readings);
    expect(driftMs).toBeLessThan(500);

    const firstReading = readings[0];
    expect(firstReading).toBeDefined();
    if (firstReading === undefined) {
      throw new Error('Expected at least one child start-time reading');
    }
    expect(Math.abs(Date.now() - firstReading)).toBeLessThanOrEqual(60_000);
  });
});
