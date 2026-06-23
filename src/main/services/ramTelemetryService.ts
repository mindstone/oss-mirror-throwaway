import { app, BrowserWindow } from 'electron';
import type { ProcessMetric } from 'electron';
import { createScopedLogger } from '@core/logger';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { getBlockerStatus } from './powerSaveBlockerService';

const log = createScopedLogger({ service: 'ramTelemetry' });

export interface ProcessSnapshot {
  pid: number;
  type: string;
  label: string;
  workingSetMB: number;
  cpuPercent: number;
}

export interface RamSnapshot {
  timestamp: number;
  mainProcess: {
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    rssMB: number;
    arrayBuffersMB: number;
  };
  processes: ProcessSnapshot[];
  totals: {
    workingSetMB: number;
    processCount: number;
  };
  registry: {
    activeTurns: number;
    contextAccumulators: number;
    contextTotalEvents: number;
  };
  powerSaveBlocker: {
    active: boolean;
    refCount: number;
    reasons: Record<string, number>;
  };
  rendererSnapshot: RendererMemorySnapshot | null;
}

export interface RendererMemorySnapshot {
  timestamp: number;
  heapUsedMB: number | null;
  heapTotalMB: number | null;
  loadedSessions: number;
  loadedMessages: number;
}

let lastRendererSnapshot: RendererMemorySnapshot | null = null;

/**
 * Cache a renderer memory snapshot pushed from the renderer process via IPC.
 * Called from the renderer's periodic memory diagnostic.
 */
export function cacheRendererSnapshot(snapshot: RendererMemorySnapshot): void {
  lastRendererSnapshot = snapshot;
}

/**
 * Module-local registry of non-Electron PIDs that should be labelled in the
 * diagnostic (super-mcp and future bundled-Node subprocesses).
 *
 * Populated via `registerNamedPid` / `unregisterNamedPid`, typically from a
 * thin main-side adapter that subscribes to subprocess lifecycle events (see
 * `superMcpTelemetryAdapter`).
 *
 * Registry entries are NOT merged into `buildProcessLabelMap` — that map is
 * reserved for Electron-managed processes. Callers that need a non-Electron
 * label consult `getNamedPidLabel(pid)` directly (used in `getProcessLabel`'s
 * unknown-type fallback and the synth-row path in `perfDiagnosticService`).
 * See M3 in `docs/plans/260423_secondary_process_cpu_observability.md`
 * for the collision-avoidance rationale.
 *
 * Stage 4a of `docs/plans/260423_secondary_process_cpu_observability.md`.
 */
const namedPidRegistry = new Map<number, { label: string; registeredAt: number }>();

/**
 * Defence-in-depth ceiling on registry entry age. If a subprocess's `exited`
 * event is missed (crash, unclean exit, adapter disposed before exit fires),
 * entries would otherwise live forever. `maybePruneStaleNamedPidEntries`
 * (invoked on every registry read) drops entries older than this.
 *
 * 24h is generous — much longer than a normal session, but short enough that
 * a missed-exit bug can't silently amplify into misattributed labels across
 * days. Stage 4a M5 refinement.
 */
export const NAMED_PID_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Drop registry entries older than `NAMED_PID_MAX_AGE_MS`. Called by
 * `getNamedPidLabel()` on every lookup so pruning happens lazily along the
 * hot path without a separate timer. Logs each pruned entry once at debug
 * level so missed-exit bugs are observable.
 */
function maybePruneStaleNamedPidEntries(): void {
  const now = Date.now();
  for (const [pid, entry] of namedPidRegistry) {
    const ageMs = now - entry.registeredAt;
    if (ageMs > NAMED_PID_MAX_AGE_MS) {
      namedPidRegistry.delete(pid);
      log.debug(
        { pid, label: entry.label, ageMs },
        'namedPidRegistry: pruned stale entry older than NAMED_PID_MAX_AGE_MS',
      );
    }
  }
}

/**
 * Register a non-Electron subprocess PID with a human-readable label so it
 * appears in `processes[]` of the perf diagnostic alongside Electron-managed
 * processes.
 *
 * - Label is sanitized via `sanitizeProcessName` for consistency with the
 *   utility-process labelling path (e.g., "Super MCP" → "super-mcp").
 * - Last-registration-wins: re-registering the same PID overwrites the prior
 *   entry (useful on process restarts that reuse PIDs within a session).
 * - No-ops silently on empty / whitespace-only labels — the plan's contract
 *   is that absent labels fall back to the default lookup path rather than
 *   polluting the registry with blanks.
 */
export function registerNamedPid(pid: number, label: string): void {
  const sanitized = sanitizeProcessName(label);
  if (!sanitized) {
    log.debug({ pid, label }, 'registerNamedPid: empty label after sanitize — ignoring');
    return;
  }
  namedPidRegistry.set(pid, { label: sanitized, registeredAt: Date.now() });
  log.debug({ pid, label: sanitized }, 'registerNamedPid');
}

/**
 * Unregister a previously-named PID. No-op when the PID is absent.
 */
export function unregisterNamedPid(pid: number): void {
  if (namedPidRegistry.delete(pid)) {
    log.debug({ pid }, 'unregisterNamedPid');
  }
}

/** @internal Test-only: read-only snapshot of the named-PID registry. */
export function getNamedPidRegistryForTesting(): Map<number, { label: string; registeredAt: number }> {
  return new Map(namedPidRegistry);
}

/** @internal Test-only: clear all registry entries between tests. */
export function clearNamedPidRegistryForTesting(): void {
  namedPidRegistry.clear();
}

/**
 * Sanitize a process name to lowercase-kebab-case for consistent log parsing.
 * e.g., "Embedding Worker" → "embedding-worker", "Pre-Turn Context Worker" → "pre-turn-context-worker"
 */
export function sanitizeProcessName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build a PID→label map for identifying **Electron-managed** processes only.
 *
 * Labels here come exclusively from `BrowserWindow` iteration. The
 * `namedPidRegistry` is NOT merged into this map — a stale registry entry
 * (PID reused by the OS for an Electron renderer, e.g. after a missed
 * `exited` event) would otherwise silently relabel legitimate renderer /
 * Tab rows produced by `app.getAppMetrics()` (M3 PID-collision hazard).
 *
 * Consumers that want to label a non-Electron subprocess PID must call
 * `getProcessLabel()` (which consults `namedPidRegistry` only in its
 * unknown-type fallback branch) or read the registry directly via the
 * synthetic-row path in `perfDiagnosticService`. See the M3 rationale in
 * `docs/plans/260423_secondary_process_cpu_observability.md`.
 */
export function buildProcessLabelMap(): Map<number, string> {
  const labels = new Map<number, string>();
  try {
    // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: telemetry enumeration only, no webContents.send target; no migration needed unless Electron exposes a better process map.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      const winPid = win.webContents.getOSProcessId();
      if (labels.has(winPid)) continue;

      const url = win.webContents.getURL();
      if (!win.isVisible()) {
        if (url.includes('gpu-worker') || url.includes('embedding')) {
          labels.set(winPid, 'gpuWorker');
        } else if (url.includes('export') || url.includes('data:text/html')) {
          labels.set(winPid, 'exportRenderer');
        } else {
          labels.set(winPid, `hiddenRenderer:${winPid}`);
        }
      } else {
        labels.set(winPid, 'mainUI');
      }
    }
  } catch {
    // Window iteration can fail during shutdown
  }
  return labels;
}

/**
 * Resolve a non-Electron subprocess label from `namedPidRegistry`, if any.
 * Returns `null` when the PID is not registered. Kept separate from
 * `buildProcessLabelMap` so the two label sources (Electron-managed /
 * named-PID) stay independent — see the M3 collision rationale on
 * `buildProcessLabelMap`.
 *
 * Also prunes entries older than `NAMED_PID_MAX_AGE_MS` (24h) as a
 * defence-in-depth against missed `exited` events.
 */
export function getNamedPidLabel(pid: number): string | null {
  maybePruneStaleNamedPidEntries();
  const entry = namedPidRegistry.get(pid);
  return entry ? entry.label : null;
}

/**
 * Get a human-readable label for an Electron process metric.
 *
 * For Utility processes, uses the serviceName (via `metricName`) when available,
 * sanitized to lowercase-kebab-case (e.g., "Embedding Worker" → "embedding-worker:48467").
 * Falls back to "utility:PID" when no name is provided.
 */
export function getProcessLabel(
  type: string,
  pid: number,
  labelMap: Map<number, string>,
  metricName?: string,
): string {
  if (type === 'Browser') return 'main';
  if (type === 'GPU') return 'gpu';
  if (type === 'Utility') {
    if (metricName) {
      const sanitized = sanitizeProcessName(metricName);
      if (sanitized) return `${sanitized}:${pid}`;
    }
    return `utility:${pid}`;
  }
  if (type === 'Tab' || type === 'Renderer') {
    // IMPORTANT: do NOT consult `namedPidRegistry` here. Tab/Renderer rows
    // come from Electron's own metrics; a stale registry entry (missed
    // `exited` event + OS PID reuse) would otherwise relabel a legitimate
    // renderer as `super-mcp`. See M3 in the Stage 4a refinement.
    return labelMap.get(pid) ?? `renderer:${pid}`;
  }
  // Unknown Electron type (e.g., 'Unknown' reported during a restart race).
  // Fall back to the named-PID registry before synthesising a `type:pid` label
  // so non-Electron subprocesses (super-mcp et al.) stay identifiable even
  // when they briefly surface via `app.getAppMetrics()`.
  const namedLabel = getNamedPidLabel(pid);
  if (namedLabel) return namedLabel;
  return `${type.toLowerCase()}:${pid}`;
}

/**
 * Capture a full RAM snapshot of the app. Lightweight and safe for on-demand use.
 *
 * Fail-observable: if `app.getAppMetrics()` throws (rare but possible during
 * shutdown / app-quit races), we log a warn and return a snapshot with
 * `processes: []` and zeroed totals rather than aborting the caller's tick.
 * This matches the contract documented in `perfDiagnosticService.ts`: the
 * diagnostic emission should always succeed, even when a provider degrades.
 */
export function captureRamSnapshot(): RamSnapshot {
  const mem = process.memoryUsage();
  const registryDiag = agentTurnRegistry.getDiagnostics();

  const labelMap = buildProcessLabelMap();
  let appMetrics: ProcessMetric[] = [];
  try {
    appMetrics = app.getAppMetrics();
  } catch (err) {
    // Non-fatal: fall back to empty metrics so the caller can still emit a
    // (degraded) snapshot. Absent metrics surface as `processes: []` and
    // zeroed totals — a visible degraded state, not silent success.
    log.warn({ err }, 'captureRamSnapshot: app.getAppMetrics() threw; returning empty processes');
  }

  const processes: ProcessSnapshot[] = appMetrics.map(m => ({
    pid: m.pid,
    type: m.type,
    label: getProcessLabel(m.type, m.pid, labelMap, m.name ?? undefined),
    workingSetMB: Math.round(m.memory.workingSetSize / 1024),
    cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
  }));

  const totalWorkingSet = processes.reduce((sum, p) => sum + p.workingSetMB, 0);

  // Discard stale renderer snapshots (>10 minutes old)
  const rendererSnapshot = lastRendererSnapshot &&
    (Date.now() - lastRendererSnapshot.timestamp < 10 * 60 * 1000)
    ? lastRendererSnapshot
    : null;

  const blockerStatus = getBlockerStatus();

  return {
    timestamp: Date.now(),
    mainProcess: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      arrayBuffersMB: Math.round(mem.arrayBuffers / 1024 / 1024),
    },
    processes,
    totals: {
      workingSetMB: totalWorkingSet,
      processCount: processes.length,
    },
    registry: {
      activeTurns: registryDiag.turnCount,
      contextAccumulators: registryDiag.contextAccumulatorCount,
      contextTotalEvents: registryDiag.contextAccumulatorTotalEvents,
    },
    powerSaveBlocker: {
      active: blockerStatus.active,
      refCount: blockerStatus.refCount,
      reasons: blockerStatus.reasons,
    },
    rendererSnapshot,
  };
}
