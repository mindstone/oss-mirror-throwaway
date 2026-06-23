/**
 * Performance tracing service using Electron's contentTracing API.
 * 
 * Captures detailed performance data from all processes (main + renderers).
 * View traces in Chrome at chrome://tracing
 * 
 * Usage:
 * - Call startTracing() before the action you want to profile
 * - Perform the action
 * - Call stopTracing() to save the trace file
 * - Open chrome://tracing and load the .json file
 */

import { contentTracing, app, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'perf-tracing' });

let isTracing = false;
let autoStopTimeout: NodeJS.Timeout | null = null;
let bufferCheckInterval: NodeJS.Timeout | null = null;
let currentPresetName: string | null = null;

export interface TracingOptions {
  /** Categories to trace. Default is lightweight (app-level). Use 'full' for everything. */
  categories?: string[];
  /** Preset: 'lightweight' (default, ~10x smaller) or 'full' (everything) */
  preset?: 'lightweight' | 'full';
  /** Duration in ms to auto-stop. If not set, must call stopTracing manually. */
  durationMs?: number;
}

// Full categories - captures everything (very large traces)
const FULL_CATEGORIES = [
  'electron',
  'v8',
  'v8.execute',
  'blink',
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'ipc',
  'gpu',
  'cc',
  'renderer',
  'browser',
];

// Lightweight categories - focused on app-level performance (much smaller traces)
const LIGHTWEIGHT_CATEGORIES = [
  'electron',
  'v8',
  'ipc',
  'toplevel',
  'blink.user_timing',
];

export const TRACE_PRESETS = {
  startup: ['electron', 'v8', 'toplevel', 'blink.user_timing', 'ipc'],
  ipc: ['ipc', 'toplevel', 'electron'],
  memory: ['v8', 'disabled-by-default-v8.gc', 'disabled-by-default-memory-infra'],
  gpu: ['gpu', 'cc', 'viz', 'toplevel'],
  interaction: ['blink', 'blink.user_timing', 'devtools.timeline', 'toplevel', 'ipc'],
} as const;

export type TracePresetName = keyof typeof TRACE_PRESETS;

const PRESET_DEFAULT_DURATION: Record<TracePresetName, number> = {
  startup: 30_000,
  ipc: 15_000,
  memory: 60_000,
  gpu: 15_000,
  interaction: 15_000,
};

const DEFAULT_CATEGORIES = LIGHTWEIGHT_CATEGORIES;

export async function startTracing(options: TracingOptions = {}, presetName?: TracePresetName): Promise<boolean> {
  if (isTracing) {
    log.warn('Tracing already in progress');
    return false;
  }

  if (presetName) {
    currentPresetName = presetName;
  } else {
    currentPresetName = null;
  }

  let categories = options.categories;
  if (!categories) {
    categories = options.preset === 'full' ? FULL_CATEGORIES : DEFAULT_CATEGORIES;
  }
  
  try {
    await contentTracing.startRecording({
      included_categories: categories,
      excluded_categories: ['*'],
    });
    isTracing = true;
    log.info({ categories: categories.length }, 'Performance tracing started');

    if (options.durationMs) {
      autoStopTimeout = setTimeout(() => {
        if (isTracing) {
          void stopTracing().catch(err => log.error({ error: err }, 'Auto-stop tracing failed'));
        }
      }, options.durationMs);

      bufferCheckInterval = setInterval(() => {
        fireAndForget((async () => {
        const usage = await getTraceBufferUsage();
        if (usage && usage.percentage > 0.8) {
          log.warn({ bufferPercentage: usage.percentage }, 'Trace buffer near capacity, auto-stopping');
          if (isTracing) {
            void stopTracing().catch(err => log.error({ error: err }, 'Buffer-triggered stop failed'));
          }
        }
        })(), 'performanceTracing.bufferCheck');
      }, 5000);
    }

    return true;
  } catch (err) {
    log.error({ error: err }, 'Failed to start tracing');
    currentPresetName = null;
    return false;
  }
}

export async function startPresetTrace(preset: TracePresetName, durationMs?: number): Promise<boolean> {
  const categories = TRACE_PRESETS[preset];
  if (!categories) {
    log.warn({ preset }, 'Unknown trace preset');
    return false;
  }

  const duration = durationMs ?? PRESET_DEFAULT_DURATION[preset];

  currentPresetName = preset;
  const result = await startTracing({ categories: [...categories], durationMs: duration }, preset);
  return result;
}

export async function stopTracing(): Promise<string | null> {
  if (!isTracing) {
    log.warn('No tracing in progress');
    return null;
  }

  // Clear auto-stop timeout if manual stop called first
  if (autoStopTimeout) {
    clearTimeout(autoStopTimeout);
    autoStopTimeout = null;
  }
  if (bufferCheckInterval) {
    clearInterval(bufferCheckInterval);
    bufferCheckInterval = null;
  }

  try {
    const tracesDir = path.join(app.getPath('userData'), 'traces');
    await fs.mkdir(tracesDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const presetSuffix = currentPresetName ? `-${currentPresetName}` : '';
    const tracePath = path.join(tracesDir, `trace${presetSuffix}-${timestamp}.json`);

    const resultPath = await contentTracing.stopRecording(tracePath);
    isTracing = false;
    currentPresetName = null;
    
    log.info({ path: resultPath }, 'Performance trace saved');
    return resultPath;
  } catch (err) {
    log.error({ error: err }, 'Failed to stop tracing');
    isTracing = false;
    currentPresetName = null;
    return null;
  }
}

export function isTracingActive(): boolean {
  return isTracing;
}

export async function openTraceInChrome(tracePath: string): Promise<void> {
  // Can't directly open chrome://tracing, but we can open the folder
  shell.showItemInFolder(tracePath);
  log.info('Opened trace location. Load this file in chrome://tracing');
}

export async function getTraceBufferUsage(): Promise<{ value: number; percentage: number } | null> {
  try {
    return await contentTracing.getTraceBufferUsage();
  } catch {
    return null;
  }
}

export function getAvailablePresets(): string[] {
  return Object.keys(TRACE_PRESETS);
}
