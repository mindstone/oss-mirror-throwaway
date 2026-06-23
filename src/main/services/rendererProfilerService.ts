import type { BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { parseProfile, type CpuProfile } from './profileParser';

const log = createScopedLogger({ service: 'rendererProfiler' });

const DEFAULT_PROFILE_DURATION_MS = 10_000;
const SAMPLING_INTERVAL_US = 1000; // 1ms
const MAX_PROFILE_FILES = 20;

let getMainWindowFn: (() => BrowserWindow | null) | null = null;

export interface RendererProfileResult {
  status: 'captured' | 'skipped_debugger_attached' | 'skipped_no_window' | 'failed';
  path?: string;
  error?: string;
}

function getProfileDir(): string {
  return path.join(getDataPath(), 'renderer-profiles');
}

async function rotateOldProfiles(): Promise<void> {
  const dir = getProfileDir();
  try {
    const files = await fs.readdir(dir);
    const cpuFiles = files.filter(f => f.endsWith('.cpuprofile')).sort();
    if (cpuFiles.length > MAX_PROFILE_FILES) {
      const toDelete = cpuFiles.slice(0, cpuFiles.length - MAX_PROFILE_FILES);
      for (const file of toDelete) {
        await fs.unlink(path.join(dir, file));
        const summaryFile = file.replace('.cpuprofile', '.summary.json');
        await fs.unlink(path.join(dir, summaryFile)).catch(() => {});
      }
      log.debug({ deleted: toDelete.length }, 'Rotated old renderer CPU profiles');
    }
  } catch {
    // Directory may not exist yet
  }
}

export function initRendererProfiler(getMainWindow: () => BrowserWindow | null): void {
  getMainWindowFn = getMainWindow;
  log.info(
    {
      defaultDurationMs: DEFAULT_PROFILE_DURATION_MS,
      samplingIntervalUs: SAMPLING_INTERVAL_US,
      maxFiles: MAX_PROFILE_FILES,
      profileDir: getProfileDir(),
    },
    'Renderer profiler initialized (dev:perf mode)'
  );
}

export async function captureRendererProfile(durationMs?: number): Promise<RendererProfileResult> {
  const mainWindow = getMainWindowFn?.();
  if (!mainWindow) {
    return { status: 'skipped_no_window' };
  }

  const webContentsDebugger = mainWindow.webContents.debugger;
  if (webContentsDebugger.isAttached()) {
    return { status: 'skipped_debugger_attached' };
  }

  try {
    await fs.mkdir(getProfileDir(), { recursive: true });

    webContentsDebugger.attach('1.3');
    await webContentsDebugger.sendCommand('Profiler.enable');
    await webContentsDebugger.sendCommand('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
    await webContentsDebugger.sendCommand('Profiler.start');

    const captureDurationMs = durationMs ?? DEFAULT_PROFILE_DURATION_MS;
    await new Promise<void>((resolve) => setTimeout(resolve, captureDurationMs));

    const { profile } = await webContentsDebugger.sendCommand('Profiler.stop') as { profile: CpuProfile };
    await webContentsDebugger.sendCommand('Profiler.disable');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const profilePath = path.join(getProfileDir(), `renderer-cpu-${timestamp}.cpuprofile`);
    await fs.writeFile(profilePath, JSON.stringify(profile));

    const summary = parseProfile(profile);
    summary.profileFile = path.basename(profilePath);
    const summaryPath = profilePath.replace('.cpuprofile', '.summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

    log.info(
      {
        profilerChannel: 'renderer-cpu',
        durationMs: summary.durationMs,
        totalSamples: summary.totalSamples,
        idlePercent: summary.idlePercent,
        gcPercent: summary.gcPercent,
        appCpuPercent: summary.appCpuPercent,
        topFunctions: summary.topFunctions.slice(0, 5).map(f => ({
          name: f.functionName,
          url: f.url ? `${path.basename(f.url)}:${f.lineNumber}` : '',
          selfPercent: f.selfTimePercent,
        })),
        profileFile: summary.profileFile,
      },
      'Renderer CPU profile captured'
    );

    await rotateOldProfiles();
    return { status: 'captured', path: profilePath };
  } catch (err) {
    log.error({ err }, 'Renderer CPU profile capture failed');
    return { status: 'failed', error: String(err) };
  } finally {
    try {
      webContentsDebugger.detach();
    } catch {
      // Ignore detach errors
    }
  }
}

export function stopRendererProfiler(): void {
  getMainWindowFn = null;
  log.info('Renderer profiler stopped');
}
