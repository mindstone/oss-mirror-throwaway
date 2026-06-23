/**
 * Plugin Watcher Subscriber
 *
 * Listens to workspace watcher events for changes within Space `plugins/`
 * directories and broadcasts updates to the renderer so the plugin catalog
 * stays in sync.
 *
 * @see docs/plans/260324_wave4_plugin_sharing_maturity.md — Stage W4-3
 */

import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { workspaceWatcherService } from './workspaceWatcherService';
import type { BrowserWindow } from 'electron';

const log = createScopedLogger({ service: 'pluginWatcherSubscriber' });

const PLUGINS_DIR_SEGMENT = `${path.sep}plugins${path.sep}`;

function isPluginPath(filePath: string): boolean {
  return filePath.includes(PLUGINS_DIR_SEGMENT);
}

function isPluginRelevantFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return basename === 'manifest.json' || basename === 'index.tsx' || basename === 'README.md';
}

/**
 * Start listening for plugin-related file changes in the workspace.
 * When a relevant change is detected, sends `plugins:space-changed` to renderer.
 */
export function startPluginWatcherSubscriber(getMainWindow: () => BrowserWindow | null): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNotify = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('plugins:space-changed');
        log.debug('Broadcast plugins:space-changed to renderer');
      }
    }, 500);
  };

  const onFileAdded = (filePath: string) => {
    if (isPluginPath(filePath) && isPluginRelevantFile(filePath)) {
      log.debug({ filePath }, 'Plugin file added');
      scheduleNotify();
    }
  };

  const onFileChanged = (filePath: string) => {
    if (isPluginPath(filePath) && isPluginRelevantFile(filePath)) {
      log.debug({ filePath }, 'Plugin file changed');
      scheduleNotify();
    }
  };

  const onFileRemoved = (filePath: string) => {
    if (isPluginPath(filePath) && isPluginRelevantFile(filePath)) {
      log.debug({ filePath }, 'Plugin file removed');
      scheduleNotify();
    }
  };

  workspaceWatcherService.on('file:added', onFileAdded);
  workspaceWatcherService.on('file:changed', onFileChanged);
  workspaceWatcherService.on('file:removed', onFileRemoved);

  log.info('Plugin watcher subscriber started');

  return () => {
    workspaceWatcherService.off('file:added', onFileAdded);
    workspaceWatcherService.off('file:changed', onFileChanged);
    workspaceWatcherService.off('file:removed', onFileRemoved);
    if (debounceTimer) clearTimeout(debounceTimer);
    log.debug('Plugin watcher subscriber stopped');
  };
}
