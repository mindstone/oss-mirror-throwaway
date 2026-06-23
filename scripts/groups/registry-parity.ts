#!/usr/bin/env npx tsx
/**
 * validate:fast group: registry / cross-surface parity guards (batched).
 *
 * Import-safe (Bucket A) IPC + boundary + cloud parity guards: each scans the
 * tree for a contract/registry invariant and signals its verdict by returning
 * or via `process.exit`. Batching them into ONE process (this file is a single
 * `STEPS` entry) collapses 6 `node --import tsx` boots into 1 — same checks,
 * same coverage. Each guard's UNCHANGED `main()` runs fail-closed via
 * `guardFromMain` (process.exit intercepted; see scripts/lib/guard-group-runner.ts).
 *
 * Every member was verified import-safe: a `main()` gated behind an
 * `invokedDirectly`/`import.meta.url===` check, with `process.argv` used ONLY
 * in that guard (no behaviour-affecting flag parsing — so calling `main()` with
 * the batch's argv is identical to the standalone no-arg run).
 *
 * Members are registered in `loadGroupExpansions()` (scripts/run-validate-fast.ts)
 * so the step-identity baseline flattens per-guard — a dropped guard fails the
 * registry test. Regenerate the baseline in the same commit:
 * `npx tsx scripts/run-validate-fast.ts --write-step-baseline`.
 */
import { guardFromMain, runGroupAsCli, type GuardGroupMember } from '../lib/guard-group-runner';

import { main as ipcSchemaStrictness } from '../check-ipc-schema-strictness';
import { main as startupIpcOrdering } from '../check-startup-ipc-ordering';
import { main as ipcHandlerParity } from '../check-ipc-handler-parity';
import { main as ipcBridgeExposureParity } from '../check-ipc-bridge-exposure-parity';
import { main as cloudChannelParity } from '../check-cloud-channel-parity';
// NOTE: check-boundary-registry-paths stays standalone — it imports
// scripts/boundary-hints.ts, which would cascade additional tsconfig.node.json
// includes; not worth pulling that graph in to batch one guard.

export const GROUP_NAME = 'validate:registry-parity';

/** `name` MUST equal the guard's original validate:fast STEPS name. */
export const GUARDS: readonly GuardGroupMember[] = [
  guardFromMain('validate:ipc-schema-strictness', ipcSchemaStrictness, 'npm run validate:ipc-schema-strictness'),
  guardFromMain('validate:startup-ipc-ordering', startupIpcOrdering, 'npm run validate:startup-ipc-ordering'),
  guardFromMain('validate:ipc-handler-parity', ipcHandlerParity, 'npm run validate:ipc-handler-parity'),
  guardFromMain('validate:ipc-bridge-exposure-parity', ipcBridgeExposureParity, 'npm run validate:ipc-bridge-exposure-parity'),
  guardFromMain('validate:cloud-channel-parity', cloudChannelParity, 'npm run validate:cloud-channel-parity'),
];

/** Member names — consumed by run-validate-fast.ts `loadGroupExpansions()`. */
export const GUARD_NAMES: readonly string[] = GUARDS.map((g) => g.name);

runGroupAsCli(import.meta.url, GROUP_NAME, GUARDS);
