/**
 * Fly Restart Policy Migration
 *
 * Backfills the `[[restart]]` policy onto existing Fly Machines that were
 * created before the cap was added to fly.toml.
 *
 * fly.toml's restart stanza only applies at machine-creation time. Customers
 * whose machines already exist (including everyone running today) never pick
 * up the policy from a fly.toml change — they need an explicit
 * `fly machine update` to land the new restart fields on the existing
 * config.
 *
 * This migration runs once per machine, gated by a sentinel file on `/data`.
 * Subsequent boots see the sentinel and skip. If the migration call fails
 * (Fly API error, missing token), it leaves the sentinel absent so the next
 * scheduler cycle retries; failures do not block boot.
 *
 * See Stage B / Decision F11 of
 * docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { updateMachineConfig } from '@core/services/flyApiClient';

const log = createScopedLogger({ service: 'fly-restart-policy-migration' });

export const RESTART_POLICY_SENTINEL_FILE = '.restart-policy-migrated';
export const RESTART_POLICY = 'on-failure' as const;
export const RESTART_MAX_RETRIES = 5;

export interface FlyRestartPolicyMigrationDeps {
  dataDir: string;
  /** Defaults to `updateMachineConfig` from flyApiClient; injectable for tests. */
  updateMachineConfigImpl?: typeof updateMachineConfig;
  /** Defaults to `Date.now()`. */
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export type FlyRestartPolicyMigrationOutcome =
  | 'migrated'
  | 'already-migrated'
  | 'skipped-no-fly-env'
  | 'skipped-non-fly'
  | 'fly-error';

export interface FlyRestartPolicyMigrationResult {
  outcome: FlyRestartPolicyMigrationOutcome;
  error?: string;
}

interface SentinelContents {
  migratedAt: number;
  imageTag?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildPatcher(): (config: Record<string, unknown>) => Record<string, unknown> {
  return (config) => {
    const existing = isPlainObject(config.restart) ? config.restart : {};
    if (
      existing.policy === RESTART_POLICY &&
      existing.max_retries === RESTART_MAX_RETRIES
    ) {
      return config;
    }
    return {
      ...config,
      restart: {
        ...existing,
        policy: RESTART_POLICY,
        max_retries: RESTART_MAX_RETRIES,
      },
    };
  };
}

export async function applyFlyRestartPolicyMigration(
  deps: FlyRestartPolicyMigrationDeps,
): Promise<FlyRestartPolicyMigrationResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const update = deps.updateMachineConfigImpl ?? updateMachineConfig;
  const sentinelPath = path.join(deps.dataDir, RESTART_POLICY_SENTINEL_FILE);

  try {
    await fs.access(sentinelPath);
    return { outcome: 'already-migrated' };
  } catch {
    // Sentinel missing — continue with migration.
  }

  if (!env.FLY_MACHINE_ID) {
    log.debug({ outcome: 'skipped-non-fly' }, 'Restart-policy migration skipped: not on Fly');
    return { outcome: 'skipped-non-fly' };
  }

  const flyApiToken = env.FLY_API_TOKEN;
  const flyAppName = env.FLY_APP_NAME;
  const flyMachineId = env.FLY_MACHINE_ID;
  if (!flyApiToken || !flyAppName) {
    log.warn(
      { outcome: 'skipped-no-fly-env', hasToken: !!flyApiToken, hasApp: !!flyAppName },
      'Restart-policy migration skipped: Fly env incomplete',
    );
    return { outcome: 'skipped-no-fly-env' };
  }

  log.info(
    { event: 'fly-restart-policy-migration-attempt', flyAppName, flyMachineId },
    'Applying restart policy migration to existing Fly machine',
  );

  const result = await update(flyApiToken, flyAppName, flyMachineId, buildPatcher());
  if (!result.success) {
    log.warn(
      { event: 'fly-restart-policy-migration-failed', error: result.error },
      'Restart-policy migration failed; will retry on next scheduler cycle',
    );
    return { outcome: 'fly-error', error: result.error };
  }

  const contents: SentinelContents = {
    migratedAt: now(),
    imageTag: env.FLY_IMAGE_REF,
  };
  try {
    await fs.mkdir(deps.dataDir, { recursive: true });
    await fs.writeFile(sentinelPath, `${JSON.stringify(contents)}\n`, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { event: 'fly-restart-policy-migration-sentinel-write-failed', error: message },
      'Restart-policy migration succeeded but sentinel write failed; may retry next cycle',
    );
  }

  log.info(
    { event: 'fly-restart-policy-migration-applied', flyAppName, flyMachineId },
    'Restart-policy migration applied',
  );
  return { outcome: 'migrated' };
}
