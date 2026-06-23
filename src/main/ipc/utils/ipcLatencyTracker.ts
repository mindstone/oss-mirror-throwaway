import { createScopedLogger } from '@core/logger';

const IS_PERF_MODE = process.env.REBEL_PERF_MODE === '1';
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const RESERVOIR_SIZE = 100;
const MAX_LOGGED_CHANNELS = 10;

interface ChannelStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  reservoir: number[];
}

export interface IpcLatencyStat {
  channel: string;
  count: number;
  p50: number;
  p95: number;
  max: number;
  avgMs: number;
}

const log = createScopedLogger({ service: 'ipcLatencyTracker' });

const channelStats = new Map<string, ChannelStats>();
let flushInterval: ReturnType<typeof setInterval> | null = null;

function getOrCreateStats(channel: string): ChannelStats {
  const existing = channelStats.get(channel);
  if (existing) {
    return existing;
  }

  const created: ChannelStats = {
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: 0,
    reservoir: [],
  };
  channelStats.set(channel, created);
  return created;
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedValues.length) - 1;
  const index = Math.max(0, Math.min(rank, sortedValues.length - 1));
  return sortedValues[index];
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

export function recordLatency(channel: string, durationMs: number): void {
  if (!IS_PERF_MODE) return;
  if (!Number.isFinite(durationMs)) return;

  const stats = getOrCreateStats(channel);
  stats.count += 1;
  stats.sum += durationMs;
  stats.min = Math.min(stats.min, durationMs);
  stats.max = Math.max(stats.max, durationMs);

  if (stats.reservoir.length < RESERVOIR_SIZE) {
    stats.reservoir.push(durationMs);
    return;
  }

  const replaceIndex = Math.floor(Math.random() * stats.count);
  if (replaceIndex < RESERVOIR_SIZE) {
    stats.reservoir[replaceIndex] = durationMs;
  }
}

export function getLatencyStats(): IpcLatencyStat[] {
  if (!IS_PERF_MODE) return [];

  const stats = [...channelStats.entries()].map(([channel, value]) => {
    const sortedReservoir = [...value.reservoir].sort((a, b) => a - b);
    return {
      channel,
      count: value.count,
      p50: roundMs(percentile(sortedReservoir, 50)),
      p95: roundMs(percentile(sortedReservoir, 95)),
      max: roundMs(value.max),
      avgMs: roundMs(value.count > 0 ? value.sum / value.count : 0),
    };
  });

  return stats.sort((a, b) => b.p95 - a.p95 || b.max - a.max || b.count - a.count);
}

export function flushAndLog(): void {
  if (!IS_PERF_MODE) return;

  const stats = getLatencyStats().slice(0, MAX_LOGGED_CHANNELS);
  channelStats.clear();

  if (stats.length === 0) return;

  log.info(
    {
      profilerChannel: 'ipc-latency',
      stats,
    },
    'IPC latency summary (top channels by p95)'
  );
}

export function startLatencyFlushInterval(): void {
  if (!IS_PERF_MODE) return;
  if (flushInterval) return;

  flushInterval = setInterval(() => {
    flushAndLog();
  }, FLUSH_INTERVAL_MS);
}

export function stopLatencyTracker(): void {
  if (!IS_PERF_MODE) return;
  if (!flushInterval) return;

  clearInterval(flushInterval);
  flushInterval = null;
}
