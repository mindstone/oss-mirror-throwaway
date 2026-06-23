#!/usr/bin/env node

/**
 * Ensures node_modules matches package-lock.json before dev server starts.
 *
 * Compares a SHA-256 hash of the lockfile against a stored hash inside
 * node_modules/.package-lock-hash. When they differ (after git pull, branch
 * switch, lockfile edit, or fresh clone) runs `npm ci` automatically.
 *
 * This closes the dev/prod parity gap: the cloud Dockerfile always runs
 * `npm ci` from scratch, but `npm run dev` previously reused whatever
 * stale node_modules happened to exist locally.
 *
 * Modes:
 *   (default)   Check hash, run npm ci if stale, store hash after success.
 *   --stamp     Just write the current hash (called from postinstall so
 *               `npm install <pkg>` doesn't trigger a redundant npm ci
 *               on the next `npm run dev`).
 *
 * Runs as part of `predev` and alternative dev entrypoints (dev:local,
 * dev:s101, dev:perf). Zero overhead when deps are current.
 */

const { createHash } = require('crypto');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { execSync } = require('child_process');
const { join } = require('path');

const projectRoot = join(__dirname, '..');
const lockfilePath = join(projectRoot, 'package-lock.json');
const nodeModulesDir = join(projectRoot, 'node_modules');
const hashFilePath = join(nodeModulesDir, '.package-lock-hash');

function hashFile(filePath) {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function stampHash() {
  if (!existsSync(lockfilePath)) return;
  const currentHash = hashFile(lockfilePath);
  if (!existsSync(nodeModulesDir)) {
    mkdirSync(nodeModulesDir, { recursive: true });
  }
  writeFileSync(hashFilePath, currentHash, 'utf8');
}

function main() {
  // --stamp mode: just write the hash, no check. Used by postinstall
  // so that `npm install <pkg>` updates the stamp and the next
  // `npm run dev` doesn't trigger a redundant npm ci.
  if (process.argv.includes('--stamp')) {
    stampHash();
    return;
  }

  if (!existsSync(lockfilePath)) {
    console.error('❌ package-lock.json not found — cannot verify deps freshness');
    process.exit(1);
  }

  const currentHash = hashFile(lockfilePath);

  // Fast path: node_modules exists and hash matches
  if (existsSync(hashFilePath)) {
    try {
      const storedHash = readFileSync(hashFilePath, 'utf8').trim();
      if (storedHash === currentHash) {
        console.log('✅ node_modules is up to date with package-lock.json');
        return;
      }
      console.log('📦 package-lock.json changed — running npm ci to sync node_modules...');
    } catch {
      console.log('📦 Hash file unreadable — running npm ci...');
    }
  } else if (!existsSync(nodeModulesDir)) {
    console.log('📦 node_modules missing — running npm ci...');
  } else {
    console.log('📦 No deps hash found (first run after update) — running npm ci...');
  }

  try {
    execSync('npm ci', {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env }
    });
  } catch (err) {
    console.error('❌ npm ci failed — your node_modules may be out of sync');
    console.error('   Try deleting node_modules and running npm ci manually');
    process.exit(1);
  }

  // npm ci deletes and recreates node_modules, so the hash file from
  // postinstall (--stamp) already exists at this point. We write it
  // again here as a safety net in case postinstall was skipped.
  stampHash();
  console.log('✅ node_modules synced and hash stored');
}

main();
