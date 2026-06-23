#!/usr/bin/env tsx
/**
 * Runs `electron-vite build` with an 8 GB Node heap.
 *
 * Why a script and not an inline `cross-env NODE_OPTIONS=...` in the npm
 * script? Two reasons:
 *
 *   1. Preserve upstream NODE_OPTIONS. A CI step or a developer shell may
 *      already set NODE_OPTIONS (e.g. `--inspect`, `--experimental-vm-modules`,
 *      `--no-warnings`). `cross-env NODE_OPTIONS=...` clobbers it; this script
 *      augments by reading process.env.NODE_OPTIONS, appending
 *      `--max-old-space-size=8192`, and passing the merged string down.
 *
 *   2. Cross-platform portability. Shell-level `${NODE_OPTIONS:-}` expansion
 *      in an npm script works on sh/bash but not on Windows cmd/powershell
 *      (even through cross-env-shell, escaping gets brittle). A tsx helper
 *      sidesteps the shell entirely.
 *
 * Referenced by the `verify:agent:full` npm script — added in the 260424
 * observability follow-up batch (Stage 4) because the default Node heap
 * (~4 GB on Apple Silicon) OOMs on the current tree during
 * `electron-vite build`.
 *
 * If the 8 GB limit stops being enough, bump the literal below rather than
 * introducing a new flag.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:process';

const HEAP_FLAG = '--max-old-space-size=8192';

const upstream = (process.env.NODE_OPTIONS ?? '').trim();
const merged = upstream.length > 0 ? `${upstream} ${HEAP_FLAG}` : HEAP_FLAG;

// Resolve the electron-vite bin via node to avoid PATH quirks on Windows.
// Prefer .cmd on win32 per npm binary-launcher convention.
const binName = platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite';

const child = spawn(binName, ['build'], {
  stdio: 'inherit',
  shell: platform === 'win32', // .cmd requires shell=true on Windows
  env: { ...process.env, NODE_OPTIONS: merged },
});

child.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise the signal to the parent shell by exiting non-zero with a
    // conventional encoded code (128 + signal number).
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[verify:agent:full] Failed to spawn electron-vite build:', err);
  process.exit(1);
});
