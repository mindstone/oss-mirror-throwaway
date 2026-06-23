#!/usr/bin/env tsx
/**
 * Sentry Autopilot — observability backfill.
 *
 * Stage B added nullable columns (verification_status,
 * verification_details, branch_name, pr_url, pushed_at, pending_actions).
 * Older `completed` / `failed` rows have NULL in all of them, which is
 * semantically correct but noisy for analytics queries. This script
 * normalises pre-Stage-B rows so dashboards have a clean `WHERE
 * verification_status IS NOT NULL` predicate:
 *   - For terminal rows (`status IN ('completed','failed','escalated')`)
 *     whose `verification_status IS NULL` we set it to `'skipped'`. The
 *     other nullable columns are left as-is — verification details aren't
 *     recoverable post-hoc, and branch/PR info wasn't captured pre-Stage E.
 *
 * Safe to re-run: only updates rows whose `verification_status` is
 * currently NULL.
 *
 * Usage:
 *   npx tsx scripts/sentry-autopilot/admin/backfill-observability.ts            # apply changes
 *   npx tsx scripts/sentry-autopilot/admin/backfill-observability.ts --dry-run  # print only
 *
 * Plan: docs/plans/260515_autopilot_deferred_items.md — Stage F backfill.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

import { loadConfig } from '../config.ts';

const require = createRequire(import.meta.url);

function openDb(dbPath: string): import('better-sqlite3').Database {
  const Better = require('better-sqlite3') as typeof import('better-sqlite3');
  return new Better(dbPath);
}

interface CliArgs {
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      process.stderr.write(
        'Usage: backfill-observability.ts [--dry-run]\n'
          + "  Sets verification_status='skipped' on terminal rows whose value is NULL.\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`backfill-observability: unknown argument "${arg}"\n`);
      process.exit(2);
    }
  }
  return { dryRun };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const dbPath = path.join(config.stateDir, 'state.db');
  const db: import('better-sqlite3').Database = openDb(dbPath);

  try {
    const eligible = db
      .prepare(
        `SELECT sentry_id, status, outcome, completed_at
         FROM issues
         WHERE status IN ('completed','failed','escalated')
           AND verification_status IS NULL`,
      )
      .all() as Array<{ sentry_id: string; status: string; outcome: string | null; completed_at: string | null }>;

    process.stderr.write(
      `Found ${eligible.length} terminal row(s) with NULL verification_status\n`,
    );

    if (args.dryRun) {
      process.stdout.write(`${JSON.stringify(eligible, null, 2)}\n`);
      return;
    }

    const update = db.prepare(
      `UPDATE issues
       SET verification_status = 'skipped', updated_at = CURRENT_TIMESTAMP
       WHERE sentry_id = ? AND verification_status IS NULL`,
    );
    const tx = db.transaction((rows: Array<{ sentry_id: string }>) => {
      let updated = 0;
      for (const row of rows) {
        const result = update.run(row.sentry_id);
        updated += Number(result.changes);
      }
      return updated;
    });
    const updated = tx(eligible);
    process.stdout.write(`${JSON.stringify({ updated }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

main();
