/**
 * Pre-Bootstrap Watchdog
 *
 * Runs synchronously BEFORE the cloud-service's heavy modules evaluate.
 * Detects when the previous boot crashed (boot-state's `bootPending` is
 * still true from the prior process) and rolls the Fly machine back to the
 * last-known-good image. Then `process.exit(0)` lets Fly restart the
 * machine with the new image.
 *
 * Why a cross-boot state machine (Decision D4 revised): an in-process
 * setTimeout in server.ts cannot fire after `process.exit(1)`. The recovery
 * MUST live in the NEXT boot's startup sequence, reading what the failed
 * boot wrote on disk before it died.
 *
 * Why narrow imports: see Stage C2 of
 * docs/plans/260510_cloud_image_rollback_defense_in_depth.md. This module
 * runs before any logging infra is initialized. Errors go to `console.error`
 * (synchronous stderr) so they reach Fly logs even on `process.exit`.
 *
 * Recovery contract (8 steps):
 *   1. Read boot-state and current FLY_IMAGE_REF.
 *   2. Always writeStart to record this boot (auto-increments attempt if
 *      previous boot's bootPending was true on the same image).
 *   3. If previous boot was clean, return 'no-recovery-needed'.
 *   4. If attempt count exceeded MAX_ROLLBACK_ATTEMPTS, give up (return
 *      'cap-exceeded'). The server will try to come up; if it crashes
 *      again Fly's restart cap will halt the loop.
 *   5. If FLY env is incomplete, can't roll back — return
 *      'skipped-no-fly-env'.
 *   6. Read LKG record (volume first, fallback to baked default-lkg.json).
 *   7. Anti-self-rollback: if LKG image == current image, give up.
 *   8. applyImageRollback. On success: write quarantine entry, exit 0.
 *      On failure: return structured failure outcome — server module
 *      will load next and likely crash again, but at minimum we'll have
 *      logged what happened.
 *
 * Schema-fingerprint mismatch is a WARNING (Decision D3 revised, F8). We
 * surface it but do not block rollback — a degraded cloud beats a bricked
 * cloud.
 */

import fs from 'node:fs';
import {
  createBootStateStore,
  type BootStateStore,
  type BootStateRecord,
} from './services/bootStateStore';
import {
  createLastKnownGoodImageTagStore,
  type LastKnownGoodImageTagStore,
  type LkgRecord,
} from './services/lastKnownGoodImageTagStore';
import {
  createQuarantinedTagsStore,
  type QuarantinedTagsStore,
} from './services/quarantinedTagsStore';
import {
  applyImageRollback as defaultApplyImageRollback,
  type ApplyImageRollbackResult,
  type ImageRollbackOutcome,
} from '@core/services/flyApiClient';

export const MAX_ROLLBACK_ATTEMPTS = 2;

export type WatchdogEvent =
  | { kind: 'starting'; currentImageTag: string }
  | { kind: 'no-prior-boot-state' }
  | { kind: 'prior-boot-clean' }
  | { kind: 'prior-boot-crashed'; priorAttempt: number; newAttempt: number }
  | { kind: 'cap-exceeded'; attempt: number; maxAttempts: number }
  | { kind: 'skipped-no-fly-env'; reason: string }
  | { kind: 'no-lkg-record' }
  | { kind: 'using-fallback-lkg'; fallbackPath: string }
  | { kind: 'anti-self-rollback'; targetTag: string; currentTag: string }
  | { kind: 'schema-fingerprint-mismatch'; lkgFingerprint: string; bakedFingerprint?: string }
  | { kind: 'attempting-rollback'; targetTag: string }
  | { kind: 'rollback-outcome'; outcome: ImageRollbackOutcome; error?: string }
  | { kind: 'quarantine-add-failed'; error: string }
  | { kind: 'quarantine-added'; imageTag: string };

export type WatchdogOutcome =
  | { kind: 'no-recovery-needed'; reason: 'no-prior-state' | 'prior-clean' | 'different-image' }
  | { kind: 'cap-exceeded' }
  | { kind: 'skipped-no-fly-env' }
  | { kind: 'skipped-no-lkg' }
  | { kind: 'skipped-anti-self-rollback' }
  | { kind: 'recovered'; targetImage: string }
  | { kind: 'rollback-failed'; outcome: ImageRollbackOutcome; error?: string };

export interface PreBootstrapWatchdogDeps {
  dataDir: string;
  /** Path to the baked default-lkg.json (read-only fallback). */
  fallbackLkgPath?: string;
  /** Build-time schema fingerprint from `computeSchemaFingerprint(ALL_STORE_VERSIONS)`. */
  bakedSchemaFingerprint?: string;
  env?: NodeJS.ProcessEnv;
  applyImageRollbackImpl?: typeof defaultApplyImageRollback;
  now?: () => number;
  log?: (event: WatchdogEvent) => void;
  /** Injected for tests; defaults to `createBootStateStore`. */
  bootStateStoreImpl?: BootStateStore;
  lkgStoreImpl?: LastKnownGoodImageTagStore;
  quarantineStoreImpl?: QuarantinedTagsStore;
}

function readFallbackLkg(filePath: string): LkgRecord | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as LkgRecord;
    if (
      parsed.version !== 1 ||
      typeof parsed.imageTag !== 'string' ||
      typeof parsed.schemaFingerprint !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function runPreBootstrapWatchdog(
  deps: PreBootstrapWatchdogDeps,
): Promise<WatchdogOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const applyImageRollback = deps.applyImageRollbackImpl ?? defaultApplyImageRollback;

  const currentImageTag = env.FLY_IMAGE_REF;
  if (typeof currentImageTag !== 'string' || currentImageTag.length === 0) {
    log({ kind: 'skipped-no-fly-env', reason: 'FLY_IMAGE_REF missing' });
    return { kind: 'skipped-no-fly-env' };
  }

  log({ kind: 'starting', currentImageTag });

  const bootStateStore =
    deps.bootStateStoreImpl ?? createBootStateStore({ dataPath: deps.dataDir });
  const lkgStore =
    deps.lkgStoreImpl ?? createLastKnownGoodImageTagStore({ dataPath: deps.dataDir });
  const quarantineStore =
    deps.quarantineStoreImpl ?? createQuarantinedTagsStore({ dataPath: deps.dataDir });

  const oldState = bootStateStore.read();
  const priorCrashed =
    oldState !== null &&
    oldState.bootPending === true &&
    oldState.imageTag === currentImageTag;

  let newState: BootStateRecord;
  try {
    newState = bootStateStore.writeStart(currentImageTag, now());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[watchdog] boot-state write failed: ${message}`);
    return { kind: 'no-recovery-needed', reason: 'no-prior-state' };
  }

  if (oldState === null) {
    log({ kind: 'no-prior-boot-state' });
    return { kind: 'no-recovery-needed', reason: 'no-prior-state' };
  }
  if (!priorCrashed) {
    if (oldState.bootPending) {
      log({ kind: 'prior-boot-crashed', priorAttempt: oldState.attempt, newAttempt: 1 });
      return { kind: 'no-recovery-needed', reason: 'different-image' };
    }
    log({ kind: 'prior-boot-clean' });
    return { kind: 'no-recovery-needed', reason: 'prior-clean' };
  }

  log({ kind: 'prior-boot-crashed', priorAttempt: oldState.attempt, newAttempt: newState.attempt });

  if (newState.attempt > MAX_ROLLBACK_ATTEMPTS) {
    log({ kind: 'cap-exceeded', attempt: newState.attempt, maxAttempts: MAX_ROLLBACK_ATTEMPTS });
    return { kind: 'cap-exceeded' };
  }

  const flyApiToken = env.FLY_API_TOKEN;
  const flyAppName = env.FLY_APP_NAME;
  const flyMachineId = env.FLY_MACHINE_ID;
  if (!flyApiToken || !flyAppName || !flyMachineId) {
    log({
      kind: 'skipped-no-fly-env',
      reason: `missing Fly env: token=${!!flyApiToken} app=${!!flyAppName} machine=${!!flyMachineId}`,
    });
    return { kind: 'skipped-no-fly-env' };
  }

  let lkg = lkgStore.read();
  if (!lkg && deps.fallbackLkgPath) {
    lkg = readFallbackLkg(deps.fallbackLkgPath);
    if (lkg) log({ kind: 'using-fallback-lkg', fallbackPath: deps.fallbackLkgPath });
  }
  if (!lkg) {
    log({ kind: 'no-lkg-record' });
    return { kind: 'skipped-no-lkg' };
  }

  if (lkg.imageTag === currentImageTag) {
    log({ kind: 'anti-self-rollback', targetTag: lkg.imageTag, currentTag: currentImageTag });
    return { kind: 'skipped-anti-self-rollback' };
  }

  if (
    deps.bakedSchemaFingerprint &&
    deps.bakedSchemaFingerprint !== lkg.schemaFingerprint
  ) {
    log({
      kind: 'schema-fingerprint-mismatch',
      lkgFingerprint: lkg.schemaFingerprint,
      bakedFingerprint: deps.bakedSchemaFingerprint,
    });
  }

  log({ kind: 'attempting-rollback', targetTag: lkg.imageTag });
  let rollbackResult: ApplyImageRollbackResult;
  try {
    rollbackResult = await applyImageRollback(flyApiToken, flyAppName, flyMachineId, lkg.imageTag, {
      writerTag: 'pre-bootstrap-watchdog',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[watchdog] applyImageRollback threw: ${message}`);
    log({ kind: 'rollback-outcome', outcome: 'fly-error', error: message });
    return { kind: 'rollback-failed', outcome: 'fly-error', error: message };
  }

  log({ kind: 'rollback-outcome', outcome: rollbackResult.outcome, error: rollbackResult.error });

  if (rollbackResult.outcome !== 'rolled-back') {
    return { kind: 'rollback-failed', outcome: rollbackResult.outcome, error: rollbackResult.error };
  }

  try {
    quarantineStore.addRejected(currentImageTag, { now: now() });
    log({ kind: 'quarantine-added', imageTag: currentImageTag });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log({ kind: 'quarantine-add-failed', error: message });
    console.error(`[watchdog] quarantine write failed: ${message}`);
  }

  return { kind: 'recovered', targetImage: lkg.imageTag };
}
