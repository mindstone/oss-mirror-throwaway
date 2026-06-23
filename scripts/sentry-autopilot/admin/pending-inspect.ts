#!/usr/bin/env tsx
/**
 * Sentry Autopilot — pending-actions inspector.
 *
 * Prints rows with non-empty `pending_actions` queues as structured JSON.
 * Output is pipeable to `jq` for slice-and-dice.
 *
 * Usage:
 *   npx tsx scripts/sentry-autopilot/admin/pending-inspect.ts
 *   npx tsx scripts/sentry-autopilot/admin/pending-inspect.ts --sentry-id REBEL-1234
 *
 * Plan: docs/plans/260515_autopilot_deferred_items.md — Stage F admin recovery
 *       tooling.
 */

import { loadConfig } from '../config.ts';
import { StateDB } from '../state.ts';
import path from 'node:path';

interface CliArgs {
  sentryId?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sentry-id') {
      args.sentryId = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--sentry-id=')) {
      args.sentryId = arg.slice('--sentry-id='.length);
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write(
        'Usage: pending-inspect.ts [--sentry-id <id>]\n'
          + '  --sentry-id  Restrict output to a single sentry issue\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`pending-inspect: unknown argument "${arg}"\n`);
      process.exit(2);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = new StateDB(path.join(config.stateDir, 'state.db'));
  try {
    const rows = db.listIssuesWithPendingActions();
    const filtered = args.sentryId
      ? rows.filter((row) => row.sentry_id === args.sentryId)
      : rows;

    const output = filtered.map((issue) => {
      const queue = db.getPendingActions(issue.sentry_id);
      const perKind = queue.reduce<Record<string, number>>((acc, action) => {
        acc[action.kind] = (acc[action.kind] ?? 0) + 1;
        return acc;
      }, {});
      return {
        sentry_id: issue.sentry_id,
        status: issue.status,
        outcome: issue.outcome,
        updated_at: issue.updated_at,
        completed_at: issue.completed_at,
        pending_count: queue.length,
        per_kind: perKind,
        actions: queue.map((action) => ({
          kind: action.kind,
          idempotency_key: action.idempotency_key,
          attempts: action.attempts,
          last_error: action.last_error,
          created_at: action.created_at,
        })),
      };
    });

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    db.close();
  }
}

main();
