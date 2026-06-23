#!/usr/bin/env npx tsx
/**
 * Time Saved Backfill Script
 *
 * Bounded, idempotent recovery of time-saved entries that were missed while
 * the live BTS estimator was silently failing for current-week turns. See
 * `docs-private/investigations/260520_time_saved_zero_or_missing.md` for the full
 * investigation.
 *
 * Usage:
 *   # Dry-run (default): scan only, no LLM calls, no writes.
 *   npm run backfill:time-saved
 *
 *   # Apply: run the bounded estimator, write entries with original timestamps.
 *   npm run backfill:time-saved -- --apply
 *
 *   # Equivalent invocation if invoking tsx manually (paths need
 *   # tsconfig-paths/register to resolve `@core/*` and the electron-store shim):
 *   npx tsx --tsconfig tsconfig.node.json --require tsconfig-paths/register \
 *     scripts/backfill-time-saved.ts [--apply]
 *
 *   # Flags
 *   --apply             Actually call the estimator and write entries. Default is dry-run.
 *   --max=N             Cap turns per run (default 10). Re-runs are safe + idempotent.
 *   --since=YYYY-MM-DD  Override the lower-bound cutoff (default: latest existing entry timestamp).
 *   --user-data=PATH    Override userData directory (defaults to Rebel's standard location).
 *
 * Privacy: never logs message content. Only metadata (counts, sessionId,
 * turnId, timestamps, weekly buckets) appears in console output.
 *
 * Auth: reuses the user's existing `app-settings.json`. If the script can't
 * find OpenRouter / API-key credentials in settings, it falls back to the
 * `REBEL_OPENROUTER_API_KEY` / `REBEL_ANTHROPIC_API_KEY` env vars (same
 * conventions as `scripts/rebel-cli/main.ts`).
 */

import './backfill-time-saved/platformInit';

import fs from 'node:fs';
import path from 'node:path';
import { setStoreFactory } from '@core/storeFactory';
import CloudStore from '../cloud-service/src/electronStoreShim';
import type { AppSettings } from '@shared/types';
import { userDataPath } from './backfill-time-saved/platformInit';

interface CliFlags {
  apply: boolean;
  maxTurns: number;
  concurrency: number;
  cutoffMs?: number;
  help: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { apply: false, maxTurns: 10, concurrency: 1, help: false };
  for (const arg of argv) {
    if (arg === '--apply' || arg === '--write') {
      flags.apply = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--max=')) {
      const v = Number.parseInt(arg.slice('--max='.length), 10);
      if (Number.isFinite(v) && v > 0) flags.maxTurns = v;
    } else if (arg.startsWith('--concurrency=')) {
      const v = Number.parseInt(arg.slice('--concurrency='.length), 10);
      if (Number.isFinite(v) && v > 0) flags.concurrency = Math.min(v, 5);
    } else if (arg.startsWith('--since=')) {
      const v = Date.parse(arg.slice('--since='.length));
      if (Number.isFinite(v)) flags.cutoffMs = v;
    } else if (arg.startsWith('--user-data=')) {
      // Already handled in platformInit via REBEL_USER_DATA env, but accept it for help.
    }
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(`Usage: npm run backfill:time-saved -- [flags]

Flags:
  --apply              Actually call the estimator and write entries.
                       Default is dry-run (scan only, no LLM calls, no writes).
  --max=N              Cap turns per run (default 10). Idempotent re-runs OK.
  --concurrency=N      Estimator calls in flight during apply (default 1, max 5).
  --since=YYYY-MM-DD   Override lower-bound cutoff. Defaults to the timestamp
                       of the latest existing entry (so re-runs naturally
                       narrow scope).
  --user-data=PATH     Override userData directory (also: REBEL_USER_DATA env).
  -h, --help           Print this help.

Examples:
  # See what would be recovered (no writes, no LLM):
  npm run backfill:time-saved

  # Apply, conservative cap of 5 turns:
  npm run backfill:time-saved -- --apply --max=5

  # Apply going back to a specific Monday:
  npm run backfill:time-saved -- --apply --since=2026-04-14

Auth: reuses the user's existing app-settings.json (OpenRouter / Anthropic
keys must already be there, or pass them through REBEL_OPENROUTER_API_KEY /
REBEL_ANTHROPIC_API_KEY env vars to override).
`);
}

function withEnvAuth(settings: AppSettings): AppSettings {
  const anthropicKey = process.env.REBEL_ANTHROPIC_API_KEY;
  const openRouterKey = process.env.REBEL_OPENROUTER_API_KEY;
  const next: AppSettings = { ...settings };
  if (anthropicKey) {
    next.models = { ...(settings.models ?? {}), apiKey: anthropicKey } as AppSettings['models'];
    next.claude = { ...(settings.claude ?? {}), apiKey: anthropicKey } as AppSettings['claude'];
  }
  if (openRouterKey) {
    next.openRouter = {
      ...(settings.openRouter ?? {}),
      enabled: true,
      oauthToken: openRouterKey,
    } as AppSettings['openRouter'];
  }
  return next;
}

function backupTimeSavedStore(): string | null {
  const src = path.join(userDataPath, 'time-saved.json');
  if (!fs.existsSync(src)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupsDir = path.join(userDataPath, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const dest = path.join(backupsDir, `time-saved.backfill-${stamp}.json`);
  fs.copyFileSync(src, dest);
  return dest;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString();
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return 0;
  }

  // Step 1: wire the store factory before any module touches a store.
  setStoreFactory((opts) => new CloudStore(opts as any) as any);

  // Step 2: import settings store + codex auth lazily so they pick up the
  // store factory we just registered.
  const settingsStoreModule = await import('@core/services/settingsStore/index');
  const { setSettingsStoreAdapter } = await import('@core/services/settingsStore');
  const { setCodexAuthProvider } = await import('@core/codexAuth');
  const { registerBtsProxyProviders } = await import('@core/services/behindTheScenesClient');

  const { getSettings, updateSettings } = settingsStoreModule;

  setSettingsStoreAdapter({
    getSettings: () => withEnvAuth(getSettings()),
    updateSettings,
    updateSettingsAtomic: (updater) => {
      const partial = updater(withEnvAuth(getSettings()));
      if (Object.keys(partial).length > 0) updateSettings(partial);
    },
  });

  // Backfill never needs Codex; use an "always disconnected" provider so any
  // codex-conditional codepath (e.g. BTS Codex routing) shorts out cleanly.
  // The user's settings select `activeProvider: 'openrouter'` for time-saved
  // estimation, so this is fine for the common case. If a user is using Codex
  // for BTS, they can re-run with an OpenRouter API key in
  // REBEL_OPENROUTER_API_KEY to use that path instead.
  setCodexAuthProvider({
    isConnected: () => false,
    getAccessToken: async () => null,
    getAccountId: () => null,
    forceRefreshToken: async () => null,
    getStatus: () => ({ connected: false }),
  });

  // Wire the same OpenRouter proxy bridge the desktop main process uses. This
  // lets the standalone repair script reuse the user's stored OpenRouter OAuth
  // token instead of requiring them to paste a separate API key.
  const { proxyManager: btsProxyManager } = await import('../src/main/services/localModelProxyServer');
  let proxyStarted = false;
  registerBtsProxyProviders({
    url: async () => {
      if (!btsProxyManager.isRunning()) {
        await btsProxyManager.ensureRunningForBts();
        proxyStarted = true;
      }
      return btsProxyManager.getUrl();
    },
    auth: () => btsProxyManager.getAuthToken(),
  });

  // Step 3: initialize the time-saved service with no-op broadcasts. The
  // recovery path intentionally does not broadcast cross-session status
  // (see timeSavedService.recoverTimeSavedEntryForTurn), but the service
  // requires `deps` to be set at all so we provide stubs.
  const { initializeTimeSavedService } = await import('@core/services/timeSavedService');
  const {
    scanTimeSavedBackfillCandidates,
    runTimeSavedBackfill,
    defaultBackfillCutoffMs,
  } = await import('@core/services/timeSavedBackfillService');

  initializeTimeSavedService({
    getSettings: () => withEnvAuth(getSettings()),
    broadcastTimeSavedStatus: () => {},
    broadcastCommunityShareEligible: () => {},
  });

  const cutoffMs = flags.cutoffMs ?? defaultBackfillCutoffMs();

  process.stdout.write(`\n[backfill] userData      : ${userDataPath}\n`);
  process.stdout.write(`[backfill] mode          : ${flags.apply ? 'APPLY (writes enabled)' : 'dry-run (no writes)'}\n`);
  process.stdout.write(`[backfill] cutoff        : ${formatDate(cutoffMs)} (turns newer than this are eligible)\n`);
  process.stdout.write(`[backfill] maxTurns/run  : ${flags.maxTurns}\n\n`);
  process.stdout.write(`[backfill] concurrency   : ${flags.concurrency}\n\n`);

  // Step 4 (always): print a dry-run scan summary first.
  process.stdout.write('[backfill] scanning sessions...\n');
  const scan = await scanTimeSavedBackfillCandidates({ cutoffMs });
  process.stdout.write(`[backfill] sessions scanned          : ${scan.counts.sessionsScanned}\n`);
  process.stdout.write(`[backfill]   skipped (deleted)       : ${scan.counts.sessionsSkippedDeleted}\n`);
  process.stdout.write(`[backfill]   skipped (kind)          : ${scan.counts.sessionsSkippedKind}\n`);
  process.stdout.write(`[backfill]   skipped (missing/error) : ${scan.counts.sessionsSkippedMissing}\n`);
  process.stdout.write(`[backfill] turns skipped (duplicate) : ${scan.counts.turnsSkippedDuplicate}\n`);
  process.stdout.write(`[backfill] turns skipped (short)     : ${scan.counts.turnsSkippedShort}\n`);
  process.stdout.write(`[backfill] turns skipped (no ctx)    : ${scan.counts.turnsSkippedNoContext}\n`);
  process.stdout.write(`[backfill] turns skipped (cutoff)    : ${scan.counts.turnsSkippedBeforeCutoff}\n`);
  process.stdout.write(`[backfill] candidate turns           : ${scan.candidates.length}\n`);
  if (Object.keys(scan.candidatesByWeek).length > 0) {
    process.stdout.write('[backfill] candidates by week        :\n');
    for (const [week, count] of Object.entries(scan.candidatesByWeek).sort(([a], [b]) => (a < b ? -1 : 1))) {
      process.stdout.write(`[backfill]   ${week} : ${count}\n`);
    }
  }
  if (scan.candidates.length > 0) {
    const first = scan.candidates[0];
    const last = scan.candidates[scan.candidates.length - 1];
    process.stdout.write(`[backfill] oldest candidate          : ${formatDate(first.timestamp)} (turn ${first.turnId})\n`);
    process.stdout.write(`[backfill] newest candidate          : ${formatDate(last.timestamp)} (turn ${last.turnId})\n`);
  }
  process.stdout.write('\n');

  if (!flags.apply) {
    process.stdout.write('[backfill] dry-run complete. Re-run with --apply to write entries.\n');
    return 0;
  }

  if (scan.candidates.length === 0) {
    process.stdout.write('[backfill] nothing to recover; exiting cleanly.\n');
    return 0;
  }

  // Step 5 (apply only): back up time-saved.json before any write.
  const backupPath = backupTimeSavedStore();
  if (backupPath) {
    process.stdout.write(`[backfill] backup created at         : ${backupPath}\n`);
  } else {
    process.stdout.write('[backfill] no existing time-saved.json found; skipping backup.\n');
  }

  const startedAt = Date.now();
  const summary = await runTimeSavedBackfill({
    cutoffMs,
    maxTurns: flags.maxTurns,
    concurrency: flags.concurrency,
    onProgress: ({ index, total, sessionId, turnId, outcome }) => {
      // Only metadata; no content.
      process.stdout.write(`[backfill] [${index}/${total}] session ${sessionId.slice(0, 8)} turn ${turnId.slice(0, 8)} -> ${outcome}\n`);
    },
  });
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  process.stdout.write('\n[backfill] run summary:\n');
  process.stdout.write(`[backfill]   candidatesFound       : ${summary.candidatesFound}\n`);
  process.stdout.write(`[backfill]   attempted             : ${summary.attempted}\n`);
  process.stdout.write(`[backfill]   persisted             : ${summary.persistedCount}\n`);
  process.stdout.write(`[backfill]   persistedMinutesTotal : ${formatMinutes(summary.persistedMinutesTotal)} (${summary.persistedMinutesTotal.toFixed(1)} min raw midpoint)\n`);
  if (Object.keys(summary.persistedMinutesByWeek).length > 0) {
    process.stdout.write('[backfill]   persistedMinutesByWeek:\n');
    for (const [week, mins] of Object.entries(summary.persistedMinutesByWeek).sort(([a], [b]) => (a < b ? -1 : 1))) {
      process.stdout.write(`[backfill]     ${week} : ${formatMinutes(mins)}\n`);
    }
  }
  process.stdout.write('[backfill]   outcomeCounts         :\n');
  for (const [status, count] of Object.entries(summary.outcomeCounts)) {
    if (count > 0) process.stdout.write(`[backfill]     ${status} : ${count}\n`);
  }
  const detailCounts = new Map<string, number>();
  for (const { outcome } of summary.outcomes) {
    if ('detail' in outcome && outcome.detail) {
      detailCounts.set(outcome.detail, (detailCounts.get(outcome.detail) ?? 0) + 1);
    }
  }
  if (detailCounts.size > 0) {
    process.stdout.write('[backfill]   detailCounts          :\n');
    for (const [detail, count] of [...detailCounts.entries()].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`[backfill]     ${detail} : ${count}\n`);
    }
  }
  process.stdout.write(`[backfill]   elapsed               : ${elapsedSec}s\n`);

  if (summary.candidatesFound > summary.attempted) {
    process.stdout.write('\n[backfill] candidatesFound > attempted (maxTurns cap reached). Re-run safely with the same flags to continue.\n');
  }
  if (backupPath) {
    process.stdout.write(`\n[backfill] if anything looks wrong, restore: cp '${backupPath}' '${path.join(userDataPath, 'time-saved.json')}'\n`);
  }

  if (proxyStarted || btsProxyManager.isRunning()) {
    await btsProxyManager.stop();
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[backfill] FATAL: ${msg}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exitCode = 1;
  });
