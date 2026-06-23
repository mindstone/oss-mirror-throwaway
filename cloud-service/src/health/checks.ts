/**
 * Cloud Health Checks
 *
 * CheckResult-based health checks for the cloud service.
 * Uses the shared types from @core/services/health so results are
 * compatible with desktop's systemHealthService.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getErrorReporter } from '@core/errorReporter';
import { getMachineState } from '@core/services/flyApiClient';
import type { CheckResult } from '@core/services/health/types';
import { safeCheck } from '@core/services/health/utils';
import { getCriticalPromptWarmStatus } from '@core/services/promptFileService';
import { cloudBootstrapWarmup } from '../services/cloudBootstrapWarmup';

const DATA_DIR = process.env.REBEL_USER_DATA || '/data';
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const RSS_WARN_RATIO = 0.4;
const RSS_FAIL_RATIO = 0.55;
const RSS_BUDGET_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RSS_BUDGET_MB = 4096;
const BREADCRUMB_COOLDOWN_MS = 60_000;
const BOOT_WARN_MS = 60_000;
const BOOT_FAIL_MS = 180_000;
const WARMUP_NOT_SCHEDULED_WARN_UPTIME_SECONDS = 90;
const WARMUP_RUNNING_WARN_SECONDS = 180;

type BudgetState = 'pass' | 'warn' | 'fail';
type BreachState = 'warn' | 'fail';
type MemoryBudgetCache = {
  memoryMb: number;
  expiresAtMs: number;
};
type BreadcrumbEmission = {
  state: BreachState;
  emittedAtMs: number;
};

// Tier changes (`cloud:change-vm-tier`) become visible on the next refresh.
// Keeping this TTL short limits stale budgets while avoiding Fly API calls on
// every detailed health poll.
let memoryBudgetCache: MemoryBudgetCache | null = null;
let pendingMemoryBudgetFetch: Promise<number> | null = null;
let previousMemoryBudgetState: BudgetState | null = null;
let previousBootBudgetState: BudgetState | null = null;
let lastMemoryBudgetBreadcrumb: BreadcrumbEmission | null = null;
let lastBootBudgetBreadcrumb: BreadcrumbEmission | null = null;

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function resolveFallbackRssBudgetMb(): number {
  const envBudgetMb = parsePositiveInteger(process.env.REBEL_CLOUD_RSS_BUDGET_MB);
  return envBudgetMb ?? DEFAULT_RSS_BUDGET_MB;
}

function parseMachineGuest(machineConfig: Record<string, unknown>): {
  cpuKind: string | null;
  cpus: number | null;
  memoryMb: number | null;
} {
  const guest = machineConfig.guest;
  if (!guest || typeof guest !== 'object') {
    return { cpuKind: null, cpus: null, memoryMb: null };
  }

  const record = guest as Record<string, unknown>;
  const cpuKind = typeof record.cpu_kind === 'string'
    ? record.cpu_kind
    : typeof record.cpuKind === 'string'
      ? record.cpuKind
      : null;
  const cpus = typeof record.cpus === 'number' && Number.isFinite(record.cpus)
    ? record.cpus
    : null;
  const memoryMb = typeof record.memory_mb === 'number' && Number.isFinite(record.memory_mb)
    ? record.memory_mb
    : typeof record.memoryMb === 'number' && Number.isFinite(record.memoryMb)
      ? record.memoryMb
      : null;

  return { cpuKind, cpus, memoryMb };
}

async function readFlyMachineMemoryMb(): Promise<number | null> {
  const flyApiToken = process.env.FLY_API_TOKEN;
  const flyAppName = process.env.FLY_APP_NAME;
  const flyMachineId = process.env.FLY_MACHINE_ID;
  if (!flyApiToken || !flyAppName || !flyMachineId) {
    return null;
  }

  const machineState = await getMachineState(flyApiToken, flyAppName, flyMachineId);
  if (!machineState.success || !machineState.machine) {
    return null;
  }

  const machineConfig = machineState.machine.config;
  if (!machineConfig || typeof machineConfig !== 'object') {
    return null;
  }

  const guest = parseMachineGuest(machineConfig);
  if (guest.memoryMb === null) {
    return null;
  }

  return guest.memoryMb;
}

export async function resolveRssBudgetMb(): Promise<number> {
  const now = Date.now();
  if (memoryBudgetCache && now < memoryBudgetCache.expiresAtMs) {
    return memoryBudgetCache.memoryMb;
  }

  if (pendingMemoryBudgetFetch) {
    return pendingMemoryBudgetFetch;
  }

  pendingMemoryBudgetFetch = (async () => {
    try {
      const flyMemoryBudgetMb = await readFlyMachineMemoryMb();
      if (flyMemoryBudgetMb !== null) {
        memoryBudgetCache = {
          memoryMb: flyMemoryBudgetMb,
          expiresAtMs: Date.now() + RSS_BUDGET_CACHE_TTL_MS,
        };
        return flyMemoryBudgetMb;
      }

      return resolveFallbackRssBudgetMb();
    } finally {
      pendingMemoryBudgetFetch = null;
    }
  })();

  return pendingMemoryBudgetFetch;
}

export function getCachedRssBudgetMb(): number {
  const now = Date.now();
  if (memoryBudgetCache && now < memoryBudgetCache.expiresAtMs) {
    return memoryBudgetCache.memoryMb;
  }

  if (!pendingMemoryBudgetFetch) {
    void resolveRssBudgetMb().catch((error) => {
      getErrorReporter().captureException(error, {
        level: 'warning',
        tags: { surface: 'cloud', service: 'health.checks' },
        extra: { event: 'rss_budget_refresh_failed' },
      });
    });
  }

  return resolveFallbackRssBudgetMb();
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function shouldSuppressBreadcrumb(
  previousBreadcrumb: BreadcrumbEmission | null,
  state: BreachState,
  nowMs: number,
): boolean {
  return (
    previousBreadcrumb !== null
    && previousBreadcrumb.state === state
    && nowMs - previousBreadcrumb.emittedAtMs < BREADCRUMB_COOLDOWN_MS
  );
}

function emitMemoryBudgetBreadcrumb(state: BudgetState, rssMb: number, budgetMb: number, ratio: number): void {
  if (state === 'warn' || state === 'fail') {
    const nowMs = Date.now();
    if (
      previousMemoryBudgetState !== state
      && !shouldSuppressBreadcrumb(lastMemoryBudgetBreadcrumb, state, nowMs)
    ) {
      getErrorReporter().addBreadcrumb({
        category: 'cloud.health.memory',
        message: 'cloud.health.memory.budget_breached',
        level: state === 'fail' ? 'error' : 'warning',
        data: {
          state,
          rss_mb: rssMb,
          budget_mb: budgetMb,
          ratio: roundRatio(ratio),
        },
      });
      lastMemoryBudgetBreadcrumb = { state, emittedAtMs: nowMs };
    }
  }
  previousMemoryBudgetState = state;
}

function emitBootBudgetBreadcrumb(state: BudgetState, bootDurationMs: number): void {
  if (state === 'warn' || state === 'fail') {
    const nowMs = Date.now();
    if (
      previousBootBudgetState !== state
      && !shouldSuppressBreadcrumb(lastBootBudgetBreadcrumb, state, nowMs)
    ) {
      getErrorReporter().addBreadcrumb({
        category: 'cloud.health.boot',
        message: 'cloud.health.boot.budget_breached',
        level: state === 'fail' ? 'error' : 'warning',
        data: {
          state,
          boot_duration_ms: bootDurationMs,
          budget_ms: state === 'fail' ? BOOT_FAIL_MS : BOOT_WARN_MS,
        },
      });
      lastBootBudgetBreadcrumb = { state, emittedAtMs: nowMs };
    }
  }
  previousBootBudgetState = state;
}

function secondsSinceStateChange(stateChangedAtMs: number | null): number | null {
  if (stateChangedAtMs === null) {
    return null;
  }
  return Math.max(0, Math.round((Date.now() - stateChangedAtMs) / 1000));
}

export async function checkDiskSpace(): Promise<CheckResult> {
  return safeCheck(async () => {
    const stats = fs.statfsSync(DATA_DIR);
    const availableMB = Math.round((stats.bavail * stats.bsize) / (1024 * 1024));
    const totalMB = Math.round((stats.blocks * stats.bsize) / (1024 * 1024));
    const usedPercent = Math.round(((totalMB - availableMB) / totalMB) * 100);

    let status: CheckResult['status'] = 'pass';
    let message = `${availableMB}MB available (${usedPercent}% used)`;
    if (availableMB < 100) {
      status = 'fail';
      message = `Critical: only ${availableMB}MB available`;
    } else if (availableMB < 500) {
      status = 'warn';
      message = `Low disk: ${availableMB}MB available (${usedPercent}% used)`;
    }

    return {
      id: 'cloud-disk',
      name: 'Disk Space',
      status,
      message,
      details: { availableMB, totalMB, usedPercent },
      ...(status !== 'pass' && { remediation: 'Consider cleaning up old sessions or expanding the Fly volume.' }),
    };
  }, 'cloud-disk', 'Disk Space');
}

export async function checkMemoryUsage(): Promise<CheckResult> {
  return safeCheck(async () => {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / (1024 * 1024));
    const heapTotalMB = Math.round(mem.heapTotal / (1024 * 1024));
    const rssMB = Math.round(mem.rss / (1024 * 1024));
    const heapPercent = heapTotalMB > 0 ? Math.round((heapUsedMB / heapTotalMB) * 100) : 0;
    const rssBudgetMb = await resolveRssBudgetMb();
    const warnRssThresholdMb = rssBudgetMb * RSS_WARN_RATIO;
    const failRssThresholdMb = rssBudgetMb * RSS_FAIL_RATIO;
    const rssRatio = rssBudgetMb > 0 ? rssMB / rssBudgetMb : 0;

    let rssBudgetState: BudgetState = 'pass';
    if (rssMB > failRssThresholdMb) {
      rssBudgetState = 'fail';
    } else if (rssMB > warnRssThresholdMb) {
      rssBudgetState = 'warn';
    }
    emitMemoryBudgetBreadcrumb(rssBudgetState, rssMB, rssBudgetMb, rssRatio);

    let status: CheckResult['status'] = rssBudgetState;
    if (heapPercent > 90 && status === 'pass') {
      status = 'warn';
    }

    let message = `Heap ${heapUsedMB}/${heapTotalMB}MB (${heapPercent}%), RSS ${rssMB}MB`;
    if (rssBudgetState === 'fail') {
      message = `RSS ${rssMB}MB exceeded fail budget ${Math.round(failRssThresholdMb)}MB (${Math.round(rssRatio * 100)}% of ${rssBudgetMb}MB)`;
    } else if (rssBudgetState === 'warn') {
      message = `RSS ${rssMB}MB exceeded warn budget ${Math.round(warnRssThresholdMb)}MB (${Math.round(rssRatio * 100)}% of ${rssBudgetMb}MB)`;
    } else if (heapPercent > 90) {
      message = `High heap usage: ${heapUsedMB}/${heapTotalMB}MB (${heapPercent}%)`;
    }

    return {
      id: 'cloud-memory',
      name: 'Memory Usage',
      status,
      message,
      details: {
        heapUsedMB,
        heapTotalMB,
        heapPercent,
        rssMB,
        rss_budget_mb: rssBudgetMb,
        rssWarnThresholdMb: Math.round(warnRssThresholdMb),
        rssFailThresholdMb: Math.round(failRssThresholdMb),
        rssRatio: roundRatio(rssRatio),
      },
    };
  }, 'cloud-memory', 'Memory Usage');
}

export async function checkBootBudget(): Promise<CheckResult> {
  return safeCheck(async () => {
    const { cloudBootstrapCompletedAtMs } = await import('../bootstrap');
    if (typeof cloudBootstrapCompletedAtMs !== 'number') {
      return {
        id: 'cloud-boot-budget',
        name: 'Boot Budget',
        status: 'skip',
        message: 'Bootstrap completion timestamp unavailable',
      };
    }

    const now = Date.now();
    const uptimeMs = process.uptime() * 1000;
    const processStartAtMs = now - uptimeMs;
    const bootDurationMs = Math.max(0, Math.round(cloudBootstrapCompletedAtMs - processStartAtMs));

    let status: BudgetState = 'pass';
    if (bootDurationMs > BOOT_FAIL_MS) {
      status = 'fail';
    } else if (bootDurationMs > BOOT_WARN_MS) {
      status = 'warn';
    }
    emitBootBudgetBreadcrumb(status, bootDurationMs);

    const message = status === 'fail'
      ? `Boot duration ${bootDurationMs}ms exceeded fail budget ${BOOT_FAIL_MS}ms`
      : status === 'warn'
        ? `Boot duration ${bootDurationMs}ms exceeded warn budget ${BOOT_WARN_MS}ms`
        : `Boot duration ${bootDurationMs}ms`;

    return {
      id: 'cloud-boot-budget',
      name: 'Boot Budget',
      status,
      message,
      details: {
        boot_duration_ms: bootDurationMs,
        budget_warn_ms: BOOT_WARN_MS,
        budget_fail_ms: BOOT_FAIL_MS,
        boot_completed_at_ms: cloudBootstrapCompletedAtMs,
      },
    };
  }, 'cloud-boot-budget', 'Boot Budget');
}

export async function checkWarmupState(): Promise<CheckResult> {
  return safeCheck(async () => {
    const snapshot = cloudBootstrapWarmup.getHealthSnapshot();
    const uptimeSeconds = Math.max(0, Math.round(process.uptime()));
    const stateSeconds = secondsSinceStateChange(snapshot.stateChangedAtMs);

    let status: CheckResult['status'] = 'pass';
    if (snapshot.state === 'failed') {
      status = 'warn';
    } else if (snapshot.state === 'not_scheduled' && uptimeSeconds > WARMUP_NOT_SCHEDULED_WARN_UPTIME_SECONDS) {
      status = 'warn';
    } else if (
      snapshot.state === 'running'
      && stateSeconds !== null
      && stateSeconds > WARMUP_RUNNING_WARN_SECONDS
    ) {
      status = 'warn';
    }

    let message = `Warmup state: ${snapshot.state}`;
    if (snapshot.state === 'failed') {
      message = `Warmup state is failed (${snapshot.failedAttempts} failed attempt${snapshot.failedAttempts === 1 ? '' : 's'})`;
    } else if (snapshot.state === 'not_scheduled' && status === 'warn') {
      message = `Warmup still not scheduled after ${uptimeSeconds}s uptime`;
    } else if (snapshot.state === 'running' && status === 'warn') {
      message = `Warmup running for ${stateSeconds ?? 'unknown'}s`;
    }

    return {
      id: 'cloud-warmup-state',
      name: 'Warmup State',
      status,
      message,
      details: {
        state: snapshot.state,
        failedAttempts: snapshot.failedAttempts,
        ...(stateSeconds === null ? {} : { secondsSinceStateChange: stateSeconds }),
      },
    };
  }, 'cloud-warmup-state', 'Warmup State');
}

export async function checkLogVolume(): Promise<CheckResult> {
  return safeCheck(async () => {
    let totalSizeKB = 0;
    let fileCount = 0;
    let oldestFile = '';
    let newestFile = '';

    try {
      const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
      fileCount = files.length;
      for (const file of files) {
        const filePath = path.join(LOGS_DIR, file);
        const stats = fs.statSync(filePath);
        totalSizeKB += Math.round(stats.size / 1024);
        if (!oldestFile || file < oldestFile) oldestFile = file;
        if (!newestFile || file > newestFile) newestFile = file;
      }
    } catch {
      return { id: 'cloud-logs', name: 'Log Volume', status: 'skip', message: 'Logs directory not accessible' };
    }

    const totalSizeMB = (totalSizeKB / 1024).toFixed(1);
    let status: CheckResult['status'] = 'pass';
    let message = `${fileCount} log files, ${totalSizeMB}MB total`;
    if (totalSizeKB > 500 * 1024) {
      status = 'warn';
      message = `Large log volume: ${totalSizeMB}MB across ${fileCount} files`;
    }

    return {
      id: 'cloud-logs',
      name: 'Log Volume',
      status,
      message,
      details: { fileCount, totalSizeKB, oldestFile, newestFile },
    };
  }, 'cloud-logs', 'Log Volume');
}

export async function checkSessionCount(): Promise<CheckResult> {
  return safeCheck(async () => {
    const sessionsDir = path.join(DATA_DIR, 'sessions');
    let count = 0;
    try {
      const files = fs.readdirSync(sessionsDir);
      count = files.filter(f => f.endsWith('.json')).length;
    } catch {
      return { id: 'cloud-sessions', name: 'Session Count', status: 'skip', message: 'Sessions directory not accessible' };
    }

    return {
      id: 'cloud-sessions',
      name: 'Session Count',
      status: 'pass',
      message: `${count} sessions on disk`,
      details: { count },
    };
  }, 'cloud-sessions', 'Session Count');
}

export async function checkSuperMcp(): Promise<CheckResult> {
  return safeCheck(async () => {
    const { superMcpHttpManager } = await import('@core/services/superMcpHttpManager');
    if (!superMcpHttpManager.isConfigured()) {
      return { id: 'cloud-mcp', name: 'Super-MCP', status: 'skip', message: 'Super-MCP not configured' };
    }

    const healthy = await superMcpHttpManager.checkHealth();
    return {
      id: 'cloud-mcp',
      name: 'Super-MCP',
      status: healthy ? 'pass' : 'fail',
      message: healthy ? 'Super-MCP is responsive' : 'Super-MCP is not responding',
      ...(healthy ? {} : { remediation: 'Check Super-MCP logs. It may need to be restarted via the MCP config endpoint.' }),
    };
  }, 'cloud-mcp', 'Super-MCP');
}

/**
 * Surface a missing/broken `critical: true` safety prompt in the DETAILED
 * `/api/health` readiness check (Option B-lite — louder than a per-read warn,
 * no Fly crash-loop).
 *
 * IMPORTANT — this check is intentionally DETAILED-ONLY and NON-GATING:
 * - The detailed endpoint (`/api/health?detailed=true`) always returns HTTP 200;
 *   a `fail` here only flips the detailed top-level `status` to `'critical'`.
 * - The BASIC endpoint (`/api/health`, no `?detailed`) — which Fly's health
 *   check, the Docker HEALTHCHECK, the CI deploy smoke gate, and Fly
 *   provisioning all gate on — never reads this and stays HTTP 200 / `status:'ok'`.
 * - The detailed body is also read by desktop monitoring (`checks/cloud.ts`,
 *   surfaces the failing check + remediation to the operator) AND by
 *   `cloud:check-update` (`src/main/ipc/cloudHandlers.ts:1619-1625`), which only
 *   reads `version` when the response is HTTP `ok` — so a `critical` body stays
 *   non-gating for managed update checks too.
 *
 * Reads the module-level status `warmAllPrompts()` records (before its throw),
 * so this still names unavailable critical prompts even though the cloud
 * bootstrap guard swallows that throw (deliberately non-fatal).
 */
export async function checkCriticalPrompts(): Promise<CheckResult> {
  return safeCheck(async () => {
    const status = getCriticalPromptWarmStatus();

    if (!status.hasRun) {
      return {
        id: 'cloud-critical-prompts',
        name: 'Critical Safety Prompts',
        status: 'skip',
        message: 'Prompt warmup has not run yet',
      };
    }

    if (!status.ok) {
      const ids = status.failedCriticalIds.join(', ');
      return {
        id: 'cloud-critical-prompts',
        name: 'Critical Safety Prompts',
        status: 'fail',
        message: `${status.failedCriticalIds.length} critical safety prompt(s) unavailable: ${ids}`,
        details: { failedCriticalIds: status.failedCriticalIds },
        remediation:
          'A critical safety prompt file is missing or invalid in this build/deploy. '
          + 'Re-deploy with the rebel-system/prompts directory intact (restore rebel-system/prompts).',
      };
    }

    return {
      id: 'cloud-critical-prompts',
      name: 'Critical Safety Prompts',
      status: 'pass',
      message: 'All critical safety prompts loaded',
    };
  }, 'cloud-critical-prompts', 'Critical Safety Prompts');
}

export async function runAllCloudChecks(): Promise<CheckResult[]> {
  return Promise.all([
    checkDiskSpace(),
    checkMemoryUsage(),
    checkBootBudget(),
    checkWarmupState(),
    checkLogVolume(),
    checkSessionCount(),
    checkSuperMcp(),
    checkCriticalPrompts(),
  ]);
}

export function __resetCloudHealthCheckStateForTests(): void {
  memoryBudgetCache = null;
  pendingMemoryBudgetFetch = null;
  previousMemoryBudgetState = null;
  previousBootBudgetState = null;
  lastMemoryBudgetBreadcrumb = null;
  lastBootBudgetBreadcrumb = null;
}
