#!/usr/bin/env node
/**
 * Stop the dev server for this worktree.
 *
 * Reads ELECTRON_RENDERER_PORT from .env.local (defaults to 5173) and kills
 * any process listening on that port. This allows each worktree to stop only
 * its own dev server when running multiple worktrees simultaneously.
 *
 * Usage: npm run dev:stop
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();

// Read port from .env.local (same logic as vite.renderer.config.mjs)
function getRendererPort() {
  const envLocalPath = join(projectRoot, '.env.local');
  if (existsSync(envLocalPath)) {
    const content = readFileSync(envLocalPath, 'utf-8');
    const match = content.match(/^ELECTRON_RENDERER_PORT\s*=\s*(\d+)/m);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return 5173; // Default port
}

function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      // Windows: find PID and kill
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
      const lines = result.trim().split('\n');
      const pids = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) {
          pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          console.log(`Killed process ${pid}`);
        } catch {
          // Process may have already exited
        }
      }
      return pids.size > 0;
    } else {
      // macOS/Linux: use lsof
      const result = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' });
      const pids = result.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        try {
          execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
          console.log(`Killed process ${pid}`);
        } catch {
          // Process may have already exited
        }
      }
      return pids.length > 0;
    }
  } catch {
    // No process found on port
    return false;
  }
}

const port = getRendererPort();
console.log(`Stopping dev server on port ${port}...`);

if (killProcessOnPort(port)) {
  console.log(`Dev server stopped (port ${port})`);
} else {
  console.log(`No dev server running on port ${port}`);
}
