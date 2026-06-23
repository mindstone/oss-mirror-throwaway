#!/usr/bin/env tsx
/**
 * Sentry Autopilot — pending-actions requeue.
 *
 * Resets `attempts=0` and clears `last_error` for matching pending actions
 * so the next drainer tick retries them. Useful after the operator has
 * fixed an upstream issue (rotated a credential, restored Slack, etc.).
 *
 * Usage:
 *   npx tsx scripts/sentry-autopilot/admin/pending-requeue.ts --sentry-id REBEL-1234
 *   npx tsx scripts/sentry-autopilot/admin/pending-requeue.ts --sentry-id REBEL-1234 --kind slack_outcome
 *
 * Plan: docs/plans/260515_autopilot_deferred_items.md — Stage F admin recovery
 *       tooling.
 */

import path from 'node:path';

import { loadConfig } from '../config.ts';
import { type PendingAction, type PendingActionKind, PendingActions } from '../pending-actions.ts';
import { StateDB } from '../state.ts';

interface CliArgs {
  sentryId: string;
  kind?: PendingActionKind;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let sentryId: string | undefined;
  let kind: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sentry-id') {
      sentryId = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--sentry-id=')) {
      sentryId = arg.slice('--sentry-id='.length);
    } else if (arg === '--kind') {
      kind = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--kind=')) {
      kind = arg.slice('--kind='.length);
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write(
        'Usage: pending-requeue.ts --sentry-id <id> [--kind <kind>]\n'
          + '  Resets attempts=0 and last_error=null on matching pending actions.\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`pending-requeue: unknown argument "${arg}"\n`);
      process.exit(2);
    }
  }
  if (!sentryId) {
    process.stderr.write('pending-requeue: --sentry-id is required\n');
    process.exit(2);
  }
  return { sentryId, kind: kind as PendingActionKind | undefined };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = new StateDB(path.join(config.stateDir, 'state.db'));
  try {
    const queue = db.getPendingActions(args.sentryId);
    if (queue.length === 0) {
      process.stderr.write(`pending-requeue: no pending actions found for ${args.sentryId}\n`);
      return;
    }

    let resetCount = 0;
    const next: PendingAction[] = queue.map((action) => {
      if (args.kind && action.kind !== args.kind) return action;
      if (action.attempts === 0 && action.last_error === null) return action;
      resetCount += 1;
      return { ...action, attempts: 0, last_error: null };
    });

    if (resetCount === 0) {
      process.stderr.write(
        `pending-requeue: no actions matched the filter (kind=${args.kind ?? '<any>'})\n`,
      );
      return;
    }

    // Validate via Zod before writing — defense against drift.
    PendingActions.parse(next);

    db.replacePendingActions(args.sentryId, next);
    process.stdout.write(
      `${JSON.stringify({ sentry_id: args.sentryId, reset_count: resetCount, kind: args.kind ?? null }, null, 2)}\n`,
    );
  } finally {
    db.close();
  }
}

main();
