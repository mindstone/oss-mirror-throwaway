#!/usr/bin/env tsx
/**
 * Sentry Autopilot — pending-actions cancel.
 *
 * Removes a single permanently-stuck pending action from an issue's queue.
 * Identifies the action by `idempotency_key` (printed by
 * `pending-inspect.ts`).
 *
 * Usage:
 *   npx tsx scripts/sentry-autopilot/admin/pending-cancel.ts \
 *     --sentry-id REBEL-1234 \
 *     --idempotency-key 'sentry_status:REBEL-1234:resolved'
 *
 * Plan: docs/plans/260515_autopilot_deferred_items.md — Stage F admin recovery
 *       tooling.
 */

import path from 'node:path';

import { loadConfig } from '../config.ts';
import { StateDB } from '../state.ts';

interface CliArgs {
  sentryId: string;
  idempotencyKey: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let sentryId: string | undefined;
  let idempotencyKey: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sentry-id') {
      sentryId = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--sentry-id=')) {
      sentryId = arg.slice('--sentry-id='.length);
    } else if (arg === '--idempotency-key') {
      idempotencyKey = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--idempotency-key=')) {
      idempotencyKey = arg.slice('--idempotency-key='.length);
    } else if (arg === '--help' || arg === '-h') {
      process.stderr.write(
        'Usage: pending-cancel.ts --sentry-id <id> --idempotency-key <key>\n'
          + '  Removes the named pending action from the queue.\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`pending-cancel: unknown argument "${arg}"\n`);
      process.exit(2);
    }
  }
  if (!sentryId || !idempotencyKey) {
    process.stderr.write('pending-cancel: --sentry-id and --idempotency-key are required\n');
    process.exit(2);
  }
  return { sentryId, idempotencyKey };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = new StateDB(path.join(config.stateDir, 'state.db'));
  try {
    const queueBefore = db.getPendingActions(args.sentryId);
    const matched = queueBefore.find((a) => a.idempotency_key === args.idempotencyKey);
    if (!matched) {
      process.stderr.write(
        `pending-cancel: no action with idempotency_key="${args.idempotencyKey}" on ${args.sentryId}\n`,
      );
      process.exit(1);
    }
    db.removePendingAction(args.sentryId, args.idempotencyKey);
    process.stdout.write(
      `${JSON.stringify(
        {
          sentry_id: args.sentryId,
          cancelled: {
            kind: matched.kind,
            idempotency_key: matched.idempotency_key,
            attempts: matched.attempts,
            last_error: matched.last_error,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    db.close();
  }
}

main();
