import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'superMcpOwnerRegistry' });

const DEFAULT_HEARTBEAT_CADENCE_MS = 5_000;
const DEFAULT_FRESHNESS_WINDOW_MS = 30_000;
const START_TIME_TOLERANCE_MS = 2_000;
const HEARTBEAT_WARN_COOLDOWN_MS = 60_000;
const OWNER_KINDS = ['cli', 'cloud', 'desktop', 'eval-orchestrator', 'eval-worker', 'sweep-cli'] as const;
const INVALID_VALUE = Symbol('invalid-owner-registry-value');

type MaybeValid<T> = T | typeof INVALID_VALUE;

export type OwnerKind = 'cli' | 'cloud' | 'desktop' | 'eval-orchestrator' | 'eval-worker' | 'sweep-cli';

export interface OwnerRecord {
  ownerId: string;
  ownerKind: OwnerKind;
  ownerPid: number;
  ownerStartTimeMs: number | null;
  childPid: number | null;
  childStartTimeMs: number | null;
  childPort: number | null;
  spawnedAt: number;
  lastHeartbeatAt: number;
}

export interface RegistryConfig {
  registryDir: string;
  heartbeatCadenceMs?: number;
  freshnessWindowMs?: number;
}

export class SuperMcpOwnerRegistry {
  readonly heartbeatCadenceMs: number;
  readonly freshnessWindowMs: number;

  private readonly registryDir: string;
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly heldOwnerIds = new Set<string>();
  private readonly heartbeatWarnAtMsByOwnerId = new Map<string, number>();
  private readonly consecutiveHeartbeatFailuresByOwnerId = new Map<string, number>();
  private readonly degradedOwnerIds = new Set<string>();
  // Latest heartbeat promise kicked off by each owner's interval timer. Tracked so
  // shutdown() can await it — otherwise a timer tick's heartbeat can resolve after
  // shutdown() returns, firing its degraded breadcrumb / state mutation late (untidy
  // in prod; a source of cross-test reporter bleed in unit tests). Keyed by owner so
  // it stays bounded (each tick overwrites the prior, already-settled entry).
  private readonly inFlightHeartbeats = new Map<string, Promise<void>>();
  private writeFileFn: typeof fsPromises.writeFile = fsPromises.writeFile;

  private released = false;
  private exitHandler: (() => void) | null = null;

  constructor(config: RegistryConfig) {
    this.registryDir = config.registryDir;
    this.heartbeatCadenceMs = config.heartbeatCadenceMs ?? DEFAULT_HEARTBEAT_CADENCE_MS;
    this.freshnessWindowMs = config.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS;
  }

  async register(initial: Omit<OwnerRecord, 'lastHeartbeatAt'>): Promise<void> {
    await this.ensureRegistryDir();

    const record: OwnerRecord = {
      ...initial,
      lastHeartbeatAt: Date.now(),
    };

    await this.writeOwnerRecordAtomic(record);
    this.heldOwnerIds.add(initial.ownerId);
    this.released = false;
    this.installExitHookIfNeeded();
  }

  async heartbeat(ownerId: string): Promise<void> {
    await this.ensureRegistryDir();

    const existing = await this.readOwnerRecordById(ownerId);
    if (!existing) {
      log.debug({ ownerId }, 'Skipping heartbeat because owner record does not exist');
      return;
    }

    const updated: OwnerRecord = {
      ...existing,
      lastHeartbeatAt: Date.now(),
    };
    await this.writeOwnerRecordAtomic(updated);
  }

  async attachChild(
    ownerId: string,
    childPid: number,
    childPort: number,
    childStartTimeMs: number | null,
  ): Promise<void> {
    await this.ensureRegistryDir();

    const existing = await this.readOwnerRecordById(ownerId);
    if (!existing) {
      throw new Error(`Cannot attach child: owner record "${ownerId}" was not found`);
    }

    const updated: OwnerRecord = {
      ...existing,
      childPid,
      childPort,
      childStartTimeMs,
      lastHeartbeatAt: Date.now(),
    };
    await this.writeOwnerRecordAtomic(updated);
  }

  async unregister(ownerId: string): Promise<void> {
    await this.ensureRegistryDir();
    this.stopHeartbeatTimer(ownerId);
    this.clearOwnerState(ownerId);
    this.heldOwnerIds.delete(ownerId);

    try {
      await fsPromises.unlink(this.ownerRecordPath(ownerId));
    } catch (error) {
      if (!isErrnoCode(error, 'ENOENT')) {
        throw error;
      }
    } finally {
      this.removeExitHookIfUnused();
    }
  }

  async listAllOwners(): Promise<OwnerRecord[]> {
    await this.ensureRegistryDir();

    const fileNames = await fsPromises.readdir(this.registryDir);
    const owners: OwnerRecord[] = [];

    for (const fileName of fileNames) {
      if (!fileName.endsWith('.json')) {
        continue;
      }
      if (fileName.includes('.tmp.')) {
        continue;
      }

      const recordPath = path.join(this.registryDir, fileName);
      let rawRecord: string;
      try {
        rawRecord = await fsPromises.readFile(recordPath, 'utf8');
      } catch (error) {
        log.debug({ recordPath, err: toErrorMessage(error) }, 'Failed reading owner registry record');
        continue;
      }

      const parsed = parseOwnerRecord(rawRecord);
      if (!parsed) {
        log.warn(
          {
            recordPath,
            rawLength: rawRecord.length,
          },
          'Skipping malformed owner registry record',
        );
        continue;
      }

      owners.push(parsed);
    }

    return owners;
  }

  async findOwnerByChildPid(
    childPid: number,
    observedChildStartTimeMs: number | null,
  ): Promise<OwnerRecord | null> {
    if (observedChildStartTimeMs === null) {
      return null;
    }

    const owners = await this.listAllOwners();
    for (const owner of owners) {
      if (owner.childPid !== childPid) {
        continue;
      }
      if (owner.childStartTimeMs === null) {
        continue;
      }
      const deltaMs = owner.childStartTimeMs - observedChildStartTimeMs;
      if (Math.abs(deltaMs) < START_TIME_TOLERANCE_MS) {
        return owner;
      }
      log.warn(
        {
          ownerId: owner.ownerId,
          ownerKind: owner.ownerKind,
          childPid,
          recordedChildStartTimeMs: owner.childStartTimeMs,
          observedChildStartTimeMs,
          deltaMs,
        },
        'Super-MCP owner registry rejected PID match: childStartTimeMs mismatch (PID-reuse defense fired)',
      );
    }
    return null;
  }

  startHeartbeatTimer(ownerId: string): void {
    this.stopHeartbeatTimer(ownerId);

    const timer = setInterval(() => {
      // The chain ends in .catch(), so it never rejects; storing it (rather than a
      // bare floating promise) lets shutdown() await the last in-flight heartbeat.
      const chain = this.heartbeat(ownerId)
        .then(() => {
          this.clearHeartbeatState(ownerId);
        })
        .catch((error) => {
          this.handleHeartbeatError(ownerId, error);
        });
      this.inFlightHeartbeats.set(ownerId, chain);
    }, this.heartbeatCadenceMs);

    timer.unref();
    this.heartbeatTimers.set(ownerId, timer);
  }

  stopHeartbeatTimer(ownerId: string): void {
    const timer = this.heartbeatTimers.get(ownerId);
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.heartbeatTimers.delete(ownerId);
  }

  async shutdown(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;

    for (const ownerId of [...this.heartbeatTimers.keys()]) {
      this.stopHeartbeatTimer(ownerId);
    }

    // Drain any heartbeat already in flight from the last timer tick so its async
    // completion (clearHeartbeatState / handleHeartbeatError → degraded breadcrumb)
    // cannot resolve after shutdown() returns. Bounded by the underlying fs ops,
    // the same way the unregister() awaits below are.
    await Promise.allSettled([...this.inFlightHeartbeats.values()]);
    this.inFlightHeartbeats.clear();

    const ownerIds = [...this.heldOwnerIds];
    await Promise.all(
      ownerIds.map(async (ownerId) => {
        try {
          await this.unregister(ownerId);
        } catch (error) {
          log.debug(
            { ownerId, err: toErrorMessage(error) },
            'Failed to unregister owner during shutdown',
          );
        }
      }),
    );
  }

  private installExitHookIfNeeded(): void {
    if (this.exitHandler) {
      return;
    }

    this.exitHandler = () => {
      this.releaseAllSync();
    };
    process.on('exit', this.exitHandler);
  }

  private removeExitHookIfUnused(): void {
    if (!this.exitHandler || this.heldOwnerIds.size > 0) {
      return;
    }

    process.removeListener('exit', this.exitHandler);
    this.exitHandler = null;
  }

  private releaseAllSync(): void {
    if (this.released) {
      return;
    }
    this.released = true;

    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();

    for (const ownerId of this.heldOwnerIds) {
      try {
        unlinkSync(this.ownerRecordPath(ownerId));
      } catch {
        // Best-effort cleanup on process exit.
      }
      this.clearOwnerState(ownerId);
    }

    this.heldOwnerIds.clear();
  }

  private handleHeartbeatError(ownerId: string, error: unknown): void {
    const previousFailures = this.consecutiveHeartbeatFailuresByOwnerId.get(ownerId) ?? 0;
    const consecutiveFailures = previousFailures + 1;
    this.consecutiveHeartbeatFailuresByOwnerId.set(ownerId, consecutiveFailures);

    const nowMs = Date.now();
    const lastWarnAtMs = this.heartbeatWarnAtMsByOwnerId.get(ownerId);
    const shouldWarn = typeof lastWarnAtMs !== 'number' || (nowMs - lastWarnAtMs) >= HEARTBEAT_WARN_COOLDOWN_MS;
    if (shouldWarn) {
      this.heartbeatWarnAtMsByOwnerId.set(ownerId, nowMs);
      log.warn(
        { ownerId, consecutiveFailures, err: toErrorMessage(error) },
        'Heartbeat update failed for owner registry entry',
      );
    }

    if (consecutiveFailures >= 3 && !this.degradedOwnerIds.has(ownerId)) {
      this.degradedOwnerIds.add(ownerId);
      this.emitDegradedBreadcrumb(ownerId, consecutiveFailures, error);
    }
  }

  private emitDegradedBreadcrumb(ownerId: string, consecutiveFailures: number, error: unknown): void {
    try {
      getErrorReporter().addBreadcrumb({
        category: 'super-mcp-owner-registry',
        message: 'owner-registry-degraded',
        level: 'warning',
        data: {
          ownerId,
          consecutiveFailures,
          err: toErrorMessage(error),
        },
      });
    } catch (breadcrumbError) {
      log.warn(
        {
          ownerId,
          consecutiveFailures,
          err: toErrorMessage(error),
          breadcrumbErr: toErrorMessage(breadcrumbError),
        },
        'Failed to emit owner registry degraded breadcrumb',
      );
    }
  }

  private clearHeartbeatState(ownerId: string): void {
    this.consecutiveHeartbeatFailuresByOwnerId.delete(ownerId);
    this.degradedOwnerIds.delete(ownerId);
  }

  private clearOwnerState(ownerId: string): void {
    this.clearHeartbeatState(ownerId);
    this.heartbeatWarnAtMsByOwnerId.delete(ownerId);
  }

  private async ensureRegistryDir(): Promise<void> {
    await fsPromises.mkdir(this.registryDir, { recursive: true });
  }

  private ownerRecordPath(ownerId: string): string {
    return path.join(this.registryDir, `${ownerId}.json`);
  }

  private async readOwnerRecordById(ownerId: string): Promise<OwnerRecord | null> {
    const recordPath = this.ownerRecordPath(ownerId);
    let rawRecord: string;
    try {
      rawRecord = await fsPromises.readFile(recordPath, 'utf8');
    } catch (error) {
      if (isErrnoCode(error, 'ENOENT')) {
        return null;
      }
      log.debug({ ownerId, recordPath, err: toErrorMessage(error) }, 'Failed reading owner record');
      throw error;
    }

    const parsed = parseOwnerRecord(rawRecord);
    if (!parsed) {
      log.warn(
        {
          ownerId,
          recordPath,
          rawLength: rawRecord.length,
        },
        'Owner record is malformed; treating as missing',
      );
      return null;
    }

    return parsed;
  }

  private async writeOwnerRecordAtomic(record: OwnerRecord): Promise<void> {
    const recordPath = this.ownerRecordPath(record.ownerId);
    const tmpPath = `${recordPath}.tmp.${randomUUID()}`;
    const payload = JSON.stringify(record);

    await this.ensureRegistryDir();
    try {
      await this.writeFileFn(tmpPath, payload, 'utf8');
      await fsPromises.rename(tmpPath, recordPath);
    } catch (error) {
      try {
        await fsPromises.unlink(tmpPath);
      } catch {
        // Best-effort temp-file cleanup.
      }
      throw error;
    }
  }
}

function parseOwnerRecord(rawRecord: string): OwnerRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRecord);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const ownerId = typeof parsed.ownerId === 'string' ? parsed.ownerId : null;
  const ownerKind = isOwnerKind(parsed.ownerKind) ? parsed.ownerKind : null;
  const ownerPid = toRequiredPositiveInt(parsed.ownerPid);
  const ownerStartTimeMs = toOptionalNullableNonNegativeInt(parsed.ownerStartTimeMs, true);
  const childPid = toOptionalNullablePositiveInt(parsed.childPid, true);
  const childStartTimeMs = toOptionalNullableNonNegativeInt(parsed.childStartTimeMs, true);
  const childPort = toOptionalNullablePositiveInt(parsed.childPort, true);
  const spawnedAt = toRequiredNonNegativeInt(parsed.spawnedAt);
  const lastHeartbeatAt = toRequiredNonNegativeInt(parsed.lastHeartbeatAt);

  if (
    ownerId === null
    || ownerKind === null
    || ownerPid === INVALID_VALUE
    || ownerStartTimeMs === INVALID_VALUE
    || childPid === INVALID_VALUE
    || childStartTimeMs === INVALID_VALUE
    || childPort === INVALID_VALUE
    || spawnedAt === INVALID_VALUE
    || lastHeartbeatAt === INVALID_VALUE
  ) {
    return null;
  }

  return {
    ownerId,
    ownerKind,
    ownerPid,
    ownerStartTimeMs,
    childPid,
    childStartTimeMs,
    childPort,
    spawnedAt,
    lastHeartbeatAt,
  };
}

function toRequiredPositiveInt(value: unknown): MaybeValid<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return INVALID_VALUE;
  }
  return value;
}

function toRequiredNonNegativeInt(value: unknown): MaybeValid<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return INVALID_VALUE;
  }
  return value;
}

function toOptionalNullablePositiveInt(value: unknown, allowMissing: boolean): MaybeValid<number | null> {
  if (value === undefined) {
    return allowMissing ? null : INVALID_VALUE;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return INVALID_VALUE;
  }
  return value;
}

function toOptionalNullableNonNegativeInt(value: unknown, allowMissing: boolean): MaybeValid<number | null> {
  if (value === undefined) {
    return allowMissing ? null : INVALID_VALUE;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return INVALID_VALUE;
  }
  return value;
}

function isOwnerKind(value: unknown): value is OwnerKind {
  return typeof value === 'string' && OWNER_KINDS.includes(value as OwnerKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
