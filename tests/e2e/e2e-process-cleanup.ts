/**
 * E2E Process Cleanup
 *
 * Shared helper for finding and killing orphaned E2E test processes.
 * Works cross-platform (Unix: pgrep + kill, Windows: PowerShell + taskkill).
 *
 * Used by both global-setup.ts (pre-suite cleanup) and global-teardown.ts
 * (post-suite cleanup) to prevent orphaned processes from interfering
 * with subsequent test runs or holding file locks.
 *
 * See: docs/plans/partway/260220_e2e_test_isolation_hardening.md (Stage 7)
 */

import { spawnSync } from 'child_process';

/**
 * Find and kill orphaned E2E test processes.
 * Works cross-platform (Unix: pgrep + kill, Windows: PowerShell + taskkill).
 *
 * @param label - Identifying label for log messages (e.g., 'globalSetup', 'globalTeardown')
 */
export function cleanupOrphanedTestProcesses(label: string): void {
  if (process.platform === 'win32') {
    cleanupWindows(label);
  } else {
    cleanupUnix(label);
  }
}

function cleanupUnix(label: string): void {
  const result = spawnSync('pgrep', ['-f', 'rebel-e2e-'], { encoding: 'utf8' });
  if (result.error) {
    console.warn(`[E2E ${label}] pgrep failed: ${result.error.message}`);
    return;
  }
  if (!result.stdout?.trim()) {
    console.log(`[E2E ${label}] No orphaned test processes found`);
    return;
  }
  const pids = result.stdout.trim().split('\n').filter(Boolean);
  console.log(`[E2E ${label}] Found ${pids.length} orphaned test process(es): ${pids.join(', ')}`);

  // SIGTERM first
  for (const pidStr of pids) {
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
  }

  // Brief sync wait, then SIGKILL survivors
  spawnSync('sleep', ['0.5']);

  for (const pidStr of pids) {
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
  console.log(`[E2E ${label}] Cleaned up ${pids.length} orphaned test process(es)`);
}

function cleanupWindows(label: string): void {
  try {
    // Use PowerShell to find processes with rebel-e2e- in command line
    const findResult = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*rebel-e2e-*' } | Select-Object -ExpandProperty ProcessId`
    ], { encoding: 'utf8', timeout: 10000 });

    if (findResult.error) {
      console.warn(`[E2E ${label}] PowerShell process discovery failed: ${findResult.error.message}`);
      return;
    }

    const pids = (findResult.stdout || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
    if (pids.length === 0) {
      console.log(`[E2E ${label}] No orphaned test processes found (Windows)`);
      return;
    }

    console.log(`[E2E ${label}] Found ${pids.length} orphaned test process(es) on Windows: ${pids.join(', ')}`);

    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
      } catch {
        // Process may already be dead or access denied
      }
    }
    console.log(`[E2E ${label}] Cleaned up orphaned test processes (Windows)`);
  } catch (e) {
    console.warn(`[E2E ${label}] Windows cleanup failed: ${e}`);
  }
}
