#!/usr/bin/env node

/**
 * Wrapper script to run osgrep from the bundled location.
 * This script is invoked by semanticSearchManager.ts
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const osgrepBin = join(__dirname, 'node_modules', '.bin', 'osgrep');
const args = process.argv.slice(2);

const child = spawn(osgrepBin, args, {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd()
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('Failed to start osgrep:', err);
  process.exit(1);
});
