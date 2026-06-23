#!/usr/bin/env npx tsx

/**
 * Git Worktree Login Unblocker
 *
 * Fixes the "Sign in failed. Please try again." symptom that occurs when
 * switching between worktrees with different DATA_SCHEMA_EPOCH values.
 *
 * Background
 * ----------
 * All worktrees share the same Electron userData directory. At startup the app
 * compares its DATA_SCHEMA_EPOCH (sum of store versions in
 * src/core/constants.ts) against `dataSchemaEpoch` in userData's
 * `version-marker.json`. If the marker's epoch is GREATER than the current
 * code's epoch, the app enters global read-only mode — every store write
 * (including `saveSessionToken()`) is silently blocked. OAuth "succeeds" but
 * the token is never persisted, so the next call reads a stale token and the
 * server rejects it with "Sign in failed. Please try again."
 *
 * This script:
 *   1. Reads the current worktree's DATA_SCHEMA_EPOCH.
 *   2. Reads `dataSchemaEpoch` from userData's version-marker.json.
 *   3. If the marker's epoch is strictly greater, renames the marker to
 *      `version-marker.json.bak-<unix-timestamp>` (backup preserved).
 *   4. Prints next-step instructions (Cmd-Q the app, then `npm run dev`).
 *
 * Caveats & when NOT to use this
 * ------------------------------
 * This is option 3 ("last resort") in docs/project/GIT_WORKTREES.md. It's safe
 * when the store-version differences between the two branches are additive /
 * no-op migrations (e.g. a new optional field). It is NOT safe if the newer
 * branch wrote data in a shape the older code would destructively overwrite.
 * If you hit this repeatedly, the durable fix is to align epochs by merging
 * the store-version bump(s) from the newer branch into this one (option 2 in
 * the doc).
 *
 * Usage
 * -----
 *   npx tsx scripts/git-worktree-unblock-login.ts            # rename marker
 *   npx tsx scripts/git-worktree-unblock-login.ts --dry-run  # diagnose only
 *
 * See also
 * --------
 * - docs/project/GIT_WORKTREES.md (Troubleshooting section)
 * - docs/plans/partway/260219_global_store_version_gate.md (gate design rationale)
 * - src/core/services/versionMarker.ts (marker implementation)
 */

import { existsSync, readFileSync, renameSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { DATA_SCHEMA_EPOCH } from '../src/core/constants';

const APP_NAME = 'mindstone-rebel';

function getUserDataDir(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(homedir(), 'Library', 'Application Support', APP_NAME);
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');
      return path.join(appData, APP_NAME);
    }
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), APP_NAME);
  }
}

interface MarkerFile {
  appVersion?: string;
  indexVersion?: number;
  dataSchemaEpoch?: number;
  lastWrittenAt?: number;
}

function readMarker(markerPath: string): MarkerFile | null {
  if (!existsSync(markerPath)) return null;
  try {
    return JSON.parse(readFileSync(markerPath, 'utf-8')) as MarkerFile;
  } catch (err) {
    console.error(`Failed to parse ${markerPath}:`, err);
    return null;
  }
}

function listExistingBackups(userDataDir: string): string[] {
  if (!existsSync(userDataDir)) return [];
  return readdirSync(userDataDir)
    .filter((name) => name.startsWith('version-marker.json.bak-'))
    .sort();
}

function main(): number {
  const dryRun = process.argv.includes('--dry-run');

  const userDataDir = getUserDataDir();
  const markerPath = path.join(userDataDir, 'version-marker.json');

  console.log(`Worktree:        ${process.cwd()}`);
  console.log(`Current epoch:   ${DATA_SCHEMA_EPOCH}`);
  console.log(`userData dir:    ${userDataDir}`);
  console.log(`Marker path:     ${markerPath}`);

  const marker = readMarker(markerPath);

  if (!marker) {
    console.log('');
    console.log('No version-marker.json found — nothing to unblock.');
    console.log('If you are still seeing "Sign in failed", the issue is not the epoch lockout.');
    return 0;
  }

  const markerEpoch = marker.dataSchemaEpoch ?? 0;
  console.log(`Marker epoch:    ${markerEpoch} (appVersion=${marker.appVersion ?? 'unknown'})`);
  console.log('');

  if (markerEpoch <= DATA_SCHEMA_EPOCH) {
    console.log(
      `No lockout: marker epoch (${markerEpoch}) <= current epoch (${DATA_SCHEMA_EPOCH}).`,
    );
    console.log('This worktree is not being gated. If login still fails, the cause is elsewhere.');
    return 0;
  }

  const gap = markerEpoch - DATA_SCHEMA_EPOCH;
  console.log(
    `LOCKOUT DETECTED: marker epoch ${markerEpoch} > current epoch ${DATA_SCHEMA_EPOCH} (gap ${gap}).`,
  );

  const existingBackups = listExistingBackups(userDataDir);
  if (existingBackups.length > 0) {
    console.log('');
    console.log(
      `Note: ${existingBackups.length} existing marker backup(s) found — you've hit this before.`,
    );
    console.log(
      'Durable fix: merge the store-version bump(s) from the newer branch into this one.',
    );
    console.log('See docs/project/GIT_WORKTREES.md option 2.');
  }

  if (dryRun) {
    console.log('');
    console.log('[dry-run] Would rename marker to version-marker.json.bak-<timestamp>.');
    console.log('[dry-run] Rerun without --dry-run to apply the fix.');
    return 0;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const backupPath = path.join(userDataDir, `version-marker.json.bak-${timestamp}`);
  renameSync(markerPath, backupPath);

  console.log('');
  console.log(`Renamed marker -> ${path.basename(backupPath)}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Fully quit the Electron app (Cmd-Q, not just close the window).');
  console.log('  2. Run `npm run dev` again in this worktree.');
  console.log('  3. Login should now succeed; a fresh marker will be written at the current epoch.');
  console.log('');
  console.log(
    'Reminder: switching back to the newer worktree will bump the marker again and re-trigger',
  );
  console.log('the lockout on return. Align epochs (option 2) to avoid repeating this.');
  return 0;
}

process.exit(main());
