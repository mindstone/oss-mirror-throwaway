#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { ensureDepsFresh } from './ensure-deps-fresh.mjs';

// Auto-reinstall if this checkout's node_modules has drifted from its lockfile before
// launching dev — every `dev*` / `start` variant routes through this launcher, so one
// call here covers them all (package builds use the `prepackage` hook). Self-heals
// stale worktrees too. See scripts/ensure-deps-fresh.mjs.
ensureDepsFresh();

const DEFAULT_CDP_PORT = '9222';
const HEAP_FLAG = '--max-old-space-size=8192';

if (!process.env.REMOTE_DEBUGGING_PORT) {
  process.env.REMOTE_DEBUGGING_PORT = DEFAULT_CDP_PORT;
}

// Augment NODE_OPTIONS with a larger heap so the electron-vite child spawned
// by forge during dev start-up doesn't OOM during Rollup module-graph
// analysis. The packaged build path has its own heap-bump wrapper
// (scripts/run-electron-vite-build-with-heap-bump.ts); this mirrors that for
// the dev/forge-start path. Preserves any upstream NODE_OPTIONS the user has
// set (--inspect, --no-warnings, etc.) rather than clobbering.
{
  const upstream = (process.env.NODE_OPTIONS ?? '').trim();
  if (!upstream.includes('--max-old-space-size')) {
    process.env.NODE_OPTIONS = upstream.length > 0 ? `${upstream} ${HEAP_FLAG}` : HEAP_FLAG;
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/run-dev-with-cdp-default.mjs <command> [...args]');
  process.exit(1);
}

console.log(
  `[dev-cdp] Chrome DevTools Protocol listening on 127.0.0.1:${process.env.REMOTE_DEBUGGING_PORT} ` +
    `(override with REMOTE_DEBUGGING_PORT=<port>).`,
);

const child = spawn(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(`[dev-cdp] Failed to start ${command}: ${error.message}`);
  process.exit(1);
});
