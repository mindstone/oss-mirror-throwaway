/**
 * Cloud Automation Store Adapter
 *
 * Lightweight adapter that satisfies the `AutomationsHandlerDeps` interface
 * used by `registerAutomationsHandlers`. Stores automation definitions in a
 * JSON file via the cloud's Store shim.
 *
 * Unlike the desktop's `AutomationScheduler` (2800+ LOC with timers, deferral,
 * and Electron deps), this adapter focuses only on CRUD operations and state
 * persistence. The actual cloud scheduling is handled by `CloudAutomationScheduler`.
 */

import Store, { CloudStoreLoadError } from './electronStoreShim';
import { MAX_AUTOMATION_RUN_HISTORY } from '@core/constants';
import { createScopedLogger } from '@core/logger';
import { normalizeAutomationModelOverride } from '@core/services/automationUtils';
import { normalizeFinishLine } from '@core/utils/finishLine';
import type {
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationRun,
  AutomationStoreState,
  AutomationScheduleQuarantineEntry,
  CloudAutomationDelta,
} from '@shared/types';
import { AutomationSchedule as ScheduleConstructors } from '@shared/utils/automationSchedule';

/** Callback invoked when a definition is upserted or deleted */
export type DefinitionChangeCallback = (definitions: AutomationDefinition[]) => void;

/** Callback invoked when an in-place lastRun/nextRun change occurs (no timer reset). */
export type AutomationDeltaCallback = (delta: CloudAutomationDelta) => void;

const log = createScopedLogger({ service: 'cloudAutomationStore' });
// Local cloud-adapter migration counter — distinct from desktop's
// AUTOMATION_STORE_VERSION (currently 33) which lives at
// `src/core/constants.ts`. The cloud doesn't replay desktop's migration
// framework; it runs its own eager fromUntrusted pass over persisted
// definitions and bumps this counter when that pass changes shape.
const STORE_VERSION = 2;

type CloudAutomationStoreState = AutomationStoreState & {
  cloud_automation_store_v?: number;
};

let activeCloudAutomationStore: CloudAutomationStoreAdapter | null = null;

function extractDefinitionId(definition: unknown): string | undefined {
  if (typeof definition !== 'object' || definition === null) {
    return undefined;
  }
  const id = (definition as { id?: unknown }).id;
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}

// BLOCKER 3A (R6 Stage 2 refinement): defaults sentinel must be `0`, not
// STORE_VERSION. If defaults seed the sentinel as STORE_VERSION, an archive
// restore that lacks the sentinel field would inherit it from defaults via
// the store-shim's `{ ...defaults, ...JSON.parse(raw) }` merge, the migration
// gate would skip, and the restored data would never be validated. With the
// sentinel set to `0`, restored archives without the field always re-run
// migration. `runEagerMigration` writes the sentinel forward to STORE_VERSION
// after a successful pass, so subsequent loads still skip cleanly.
const createDefaultState = (): CloudAutomationStoreState => ({
  version: STORE_VERSION,
  definitions: [],
  runs: [],
  quarantined: [],
  sessionTypeFilter: 'all',
  cloud_automation_store_v: 0,
});

/**
 * Cloud-side automation store adapter.
 * Manages automation definition persistence on the cloud service.
 * Definitions arrive from the desktop via the `automations:upsert` IPC channel.
 */
export class CloudAutomationStoreAdapter {
  private store: Store<CloudAutomationStoreState> | null;
  private state: CloudAutomationStoreState;
  private onDefinitionChange?: DefinitionChangeCallback;
  private onDelta?: AutomationDeltaCallback;
  private isMigrating = false;
  /**
   * Read-only latch. The cloud store shim now matches conf/electron-store
   * `clearInvalidConfig:false` semantics: a corrupt-but-real `automations.json`
   * THROWS (CloudStoreLoadError) at construction rather than swallowing and
   * re-seeding defaults. We catch that throw, preserve the on-disk file untouched
   * (`store` stays null — never written), and latch read-only so `persist()`
   * refuses to write. Without this, the first quarantine-normalise or migration
   * `persist()` would clobber the user's real automations with defaults (the
   * cloud-wipe class this fixes). Read-only until restart by design; the
   * in-memory `state` serves the session.
   */
  private readOnly = false;

  constructor() {
    try {
      this.store = new Store<CloudAutomationStoreState>({
        name: 'automations',
        defaults: createDefaultState(),
      });
    } catch (error) {
      if (error instanceof CloudStoreLoadError) {
        // Corrupt-but-real backing file: preserve it, run read-only on defaults.
        log.error(
          { storeName: 'automations', path: error.path, err: error },
          'Cloud automation store load failed on existing data — preserving file, running read-only on in-memory defaults this session',
        );
        this.store = null;
        this.readOnly = true;
      } else {
        // Unexpected construction failure (not a corrupt-file load): surface it.
        throw error;
      }
    }
    this.state = this.store?.store ?? createDefaultState();
    if (!Array.isArray(this.state.quarantined)) {
      this.state = { ...this.state, quarantined: [] };
      this.persist();
    }
    activeCloudAutomationStore = this;
    this.runEagerMigration();
  }

  /** Register a callback for definition changes (used by cloud scheduler) */
  setOnDefinitionChange(cb: DefinitionChangeCallback): void {
    this.onDefinitionChange = cb;
  }

  /**
   * Register a callback for slim per-run / per-schedule deltas.
   *
   * Wired in `cloud-service/src/bootstrap.ts` to broadcast `automation:cloud-delta`
   * to connected desktops so the desktop scheduler can mirror cloud-executed
   * runs into its `automation:state` without overwriting local-mode `runs[]`.
   */
  setOnDelta(cb: AutomationDeltaCallback): void {
    this.onDelta = cb;
  }

  private emitDelta(delta: CloudAutomationDelta): void {
    if (!this.onDelta) return;
    try {
      this.onDelta(delta);
    } catch (err) {
      log.warn({ err, deltaType: delta.type, automationId: delta.automationId }, 'Automation delta callback failed');
    }
  }

  /**
   * BLOCKER 3B (R6 Stage 2 refinement): re-read the in-memory state from disk
   * after `reloadAllStores()` swaps the underlying `_data`. Without this the
   * adapter holds the pre-restore state, and `runEagerMigration` would migrate
   * stale state and persist it OVER the restored payload.
   *
   * Call this BEFORE `runEagerMigration()` from any post-reload hook.
   */
  refresh(): void {
    // Read-only (corrupt-construct): no live store to re-read; keep in-memory state.
    if (this.readOnly || !this.store) return;
    this.state = this.store.store ?? createDefaultState();
    if (!Array.isArray(this.state.quarantined)) {
      this.state = { ...this.state, quarantined: [] };
    }
  }

  getState(): AutomationStoreState {
    return this.state;
  }

  runEagerMigration(): void {
    if (this.isMigrating) {
      return;
    }

    const migrationVersion = this.state.cloud_automation_store_v ?? 0;
    if (migrationVersion >= STORE_VERSION) {
      return;
    }

    this.isMigrating = true;
    try {
      const sourceVersion = this.state.version;
      const existingQuarantined = [...(this.state.quarantined ?? [])];
      const existingQuarantineIds = new Set(
        existingQuarantined
          .map((entry) => extractDefinitionId(entry.definition))
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      );

      const migratedDefinitions: AutomationDefinition[] = [];
      let changed = false;

      for (const definition of this.state.definitions) {
        try {
          const migratedSchedule = ScheduleConstructors.fromUntrusted(definition.schedule, {
            source: 'cloud-reload',
            existingCreatedAt: definition.createdAt,
            now: Date.now(),
          });

          if (!migratedSchedule.ok) {
            if (!existingQuarantineIds.has(definition.id)) {
              existingQuarantined.push({
                definition,
                reason: migratedSchedule.error.message,
                quarantinedAt: Date.now(),
                sourceVersion,
              } satisfies AutomationScheduleQuarantineEntry);
              existingQuarantineIds.add(definition.id);
            }
            changed = true;
            log.warn(
              { definitionId: definition.id, reason: migratedSchedule.error.kind },
              'Automation schedule quarantined on migration',
            );
            continue;
          }

          const scheduleChanged = JSON.stringify(definition.schedule) !== JSON.stringify(migratedSchedule.value);
          if (scheduleChanged) {
            changed = true;
          }
          migratedDefinitions.push(
            scheduleChanged
              ? {
                  ...definition,
                  schedule: migratedSchedule.value,
                }
              : definition,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (!existingQuarantineIds.has(definition.id)) {
            existingQuarantined.push({
              definition,
              reason,
              quarantinedAt: Date.now(),
              sourceVersion,
            } satisfies AutomationScheduleQuarantineEntry);
            existingQuarantineIds.add(definition.id);
          }
          changed = true;
          log.warn(
            { definitionId: definition.id, reason: 'unrepairable' },
            'Automation schedule quarantined on migration',
          );
        }
      }

      this.state = {
        ...this.state,
        definitions: changed ? migratedDefinitions : this.state.definitions,
        quarantined: changed ? existingQuarantined : this.state.quarantined,
        cloud_automation_store_v: STORE_VERSION,
      };
      this.persist();

      if (changed) {
        this.onDefinitionChange?.(this.state.definitions);
      }
    } finally {
      this.isMigrating = false;
    }
  }

  upsertDefinition(patch: AutomationDefinitionInput): AutomationDefinition {
    const now = Date.now();
    const normalizedPatch = { ...patch } as AutomationDefinitionInput;
    const patchRecord = patch as Record<string, unknown>;

    if ('model' in patchRecord) {
      (normalizedPatch as AutomationDefinitionInput & { model?: string }).model =
        normalizeAutomationModelOverride(patchRecord.model);
    }

    if ('thinkingModel' in patchRecord) {
      (normalizedPatch as AutomationDefinitionInput & { thinkingModel?: string }).thinkingModel =
        normalizeAutomationModelOverride(patchRecord.thinkingModel);
    }

    if ('finishLine' in patchRecord) {
      normalizedPatch.finishLine = normalizeFinishLine(patchRecord.finishLine);
    }

    let definitions = [...this.state.definitions];
    let target: AutomationDefinition | null = null;

    if (normalizedPatch.id) {
      const existingIndex = definitions.findIndex((d) => d.id === normalizedPatch.id);
      if (existingIndex !== -1) {
        target = { ...definitions[existingIndex], ...normalizedPatch, updatedAt: now } as AutomationDefinition;
        definitions[existingIndex] = target;
      }
    }

    if (!target) {
      const id = normalizedPatch.id ?? crypto.randomUUID();
      target = {
        id,
        name: normalizedPatch.name?.trim() || 'Untitled automation',
        description: normalizedPatch.description?.trim() || undefined,
        filePath: normalizedPatch.filePath ?? '',
        schedule: normalizedPatch.schedule,
        enabled: normalizedPatch.enabled ?? true,
        catchUpIfMissed: normalizedPatch.catchUpIfMissed ?? true,
        createdAt: now,
        updatedAt: now,
        lastRunAt: null,
        lastSuccessAt: null,
        lastRunStatus: undefined,
        nextRunAt: null,
        isSystem: normalizedPatch.isSystem,
        systemType: normalizedPatch.systemType,
        executeIn: normalizedPatch.executeIn,
        timezone: normalizedPatch.timezone,
        executor: normalizedPatch.executor,
        scriptModule: normalizedPatch.scriptModule,
        model: (normalizedPatch as AutomationDefinitionInput & { model?: string }).model,
        thinkingModel: (normalizedPatch as AutomationDefinitionInput & { thinkingModel?: string }).thinkingModel,
        finishLine: normalizeFinishLine(normalizedPatch.finishLine),
      } satisfies AutomationDefinition;
      definitions = [target, ...definitions];
    }

    if (target.executeIn === 'cloud') {
      // Validate executeIn restrictions: system and event-triggered automations cannot run in cloud
      if (target.isSystem) {
        log.warn({ automationId: target.id }, 'System automations cannot run in cloud — forcing executeIn to local');
        target.executeIn = 'local';
        target.timezone = undefined;
      } else if (target.schedule.type === 'event') {
        log.warn({ automationId: target.id }, 'Event-triggered automations cannot run in cloud — forcing executeIn to local');
        target.executeIn = 'local';
        target.timezone = undefined;
      }
    }

    const quarantinedAfterUpsert = this.state.quarantined.filter(
      (entry) => extractDefinitionId(entry.definition) !== target?.id,
    );

    this.state = { ...this.state, definitions, quarantined: quarantinedAfterUpsert };
    this.persist();
    this.onDefinitionChange?.(definitions);
    return target;
  }

  deleteDefinition(id: string): AutomationStoreState {
    const definitions = this.state.definitions.filter((d) => d.id !== id);
    const runs = this.state.runs.filter((r) => r.automationId !== id);
    const quarantined = this.state.quarantined.filter((entry) => extractDefinitionId(entry.definition) !== id);
    this.state = { ...this.state, definitions, runs, quarantined };
    this.persist();
    this.onDefinitionChange?.(definitions);
    return this.state;
  }

  /** Manual run is a no-op on the cloud adapter (cloud scheduler handles execution) */
  async runNow(_id: string): Promise<AutomationRun | null> {
    // Cloud does not support manual runNow from IPC — only scheduled runs
    return null;
  }

  setSessionTypeFilter(filter: 'all' | 'conversations' | 'automations'): AutomationStoreState {
    this.state = { ...this.state, sessionTypeFilter: filter };
    this.persist();
    return this.state;
  }

  /** Record a completed run */
  recordRun(run: AutomationRun, options?: { advanceScheduleSlot?: boolean }): void {
    const lastRunAt = run.completedAt ?? run.startedAt;
    const shouldAdvanceScheduleSlot = options?.advanceScheduleSlot ?? true;
    const isSuccessful = run.status === 'success' || run.status === 'completed_with_blocks';
    let lastSuccessAt: number | null | undefined;
    this.state = {
      ...this.state,
      runs: [run, ...this.state.runs].slice(0, MAX_AUTOMATION_RUN_HISTORY),
      definitions: this.state.definitions.map((d) => {
        if (d.id !== run.automationId) return d;
        lastSuccessAt = isSuccessful ? lastRunAt : d.lastSuccessAt;
        return {
          ...d,
          lastRunAt: shouldAdvanceScheduleSlot ? lastRunAt : d.lastRunAt,
          lastRunStatus: run.status,
          lastSuccessAt,
        };
      }),
    };
    this.persist();
    this.emitDelta({
      type: 'automation-run-recorded',
      automationId: run.automationId,
      lastRunAt,
      lastRunStatus: run.status,
      lastSuccessAt: lastSuccessAt ?? null,
      run,
    });
  }

  /**
   * Update only `nextRunAt` for the given definition, persist, and emit a
   * slim delta. Intentionally does NOT call `onDefinitionChange` — the cloud
   * scheduler invokes this AFTER scheduling timers, so triggering a definition
   * change here would cause a reschedule cycle.
   */
  updateDefinitionNextRunAt(id: string, nextRunAt: number): void {
    let changed = false;
    const definitions = this.state.definitions.map((d) => {
      if (d.id !== id) return d;
      if (d.nextRunAt === nextRunAt) return d;
      changed = true;
      return { ...d, nextRunAt };
    });
    if (!changed) return;
    this.state = { ...this.state, definitions };
    this.persist();
    this.emitDelta({
      type: 'automation-next-run-updated',
      automationId: id,
      nextRunAt,
    });
  }

  private persist(): void {
    // Read-only latch (corrupt-construct): never persist over a preserved
    // corrupt file. The in-memory `state` still serves the session.
    if (this.readOnly || !this.store) {
      log.warn(
        { storeName: 'automations' },
        'Cloud automation store is read-only (corrupt backing file preserved) — skipping persist',
      );
      return;
    }
    this.store.store = this.state;
  }
}

export function runCloudAutomationStoreEagerMigration(): void {
  // BLOCKER 3B: refresh() reads the on-disk state into the adapter cache so
  // post-archive-restore migrations operate on the restored payload, not the
  // stale pre-restore copy.
  activeCloudAutomationStore?.refresh();
  activeCloudAutomationStore?.runEagerMigration();
}
