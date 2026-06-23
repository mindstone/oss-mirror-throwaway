/**
 * Inbound Trigger Service
 *
 * Generic polling framework that detects external events (Slack @-mentions,
 * emails, etc.) via pluggable adapters and spawns agent turns in response.
 *
 * Design:
 * - One trigger processed per poll cycle (oldest-first)
 * - Per-adapter concurrency guard (skip poll if previous still running)
 * - Per-source: skip poll if an active inbound turn is running for that source
 * - lastSeenTs only advances after successful agent turn completion
 * - State persisted to electron-store with migration framework
 * - Uses createBatteryThrottledInterval for battery-aware polling
 *
 * This service is NOT wired into the app in this stage — that happens in Stage 3.
 */

import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { createBatteryThrottledInterval } from '../visibilityAwareScheduler';
import { sanitizeEventForMainAccumulation } from '../agentEventDispatcher';
import { updateConversationWithEvent, type ConversationStateShape } from '@shared/utils/conversationState';
import { migrateStore, shouldEnterReadOnlyMode, type MigrationFn, type MigrationResult } from '../../utils/storeMigration';
import { loadStoreSafely, isLoadFailedReadOnly, resolveConfStorePath, safeCreateStore } from '@core/utils/loadStoreSafely';
import { createId } from '@shared/utils/id';
import { hashTeamId } from '@shared/utils/teamIdHash';
import type { AgentSession, AgentTurnMessage } from '@shared/types';
import type {
  InboundTrigger,
  InboundTriggerAdapter,
  InboundTriggerAdapterState,
  InboundTriggerServiceDeps,
  InboundTriggerSourceState,
  InboundTriggerStoreState,
} from './types';
import {
  FIRST_ENABLE_LOOKBACK_MS,
  INBOUND_TRIGGER_STORE_VERSION,
  MAX_PROCESSED_IDS,
} from './types';

const log = createScopedLogger({ service: 'inboundTriggerService' });

const LEGACY_SLACK_INBOUND_SESSION_ID_RE = /^inbound-slack-mention--/;

// ---------------------------------------------------------------------------
// Store defaults & migrations
// ---------------------------------------------------------------------------

const createDefaultState = (): InboundTriggerStoreState => ({
  version: INBOUND_TRIGGER_STORE_VERSION,
  adapters: {},
});

const INBOUND_TRIGGER_MIGRATIONS: Record<number, MigrationFn<InboundTriggerStoreState>> = {
  // No migrations yet — version 1 is the initial version.
  // Future migrations will be added here as the state shape evolves.
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh adapter state entry */
const createAdapterState = (enabled: boolean): InboundTriggerAdapterState => ({
  enabled,
  lastPollAt: null,
  lastErrorAt: null,
  lastError: null,
  pollCount: 0,
  triggerCount: 0,
  sources: {},
});

/** Get or create source state within an adapter */
const getOrCreateSourceState = (
  adapterState: InboundTriggerAdapterState,
  sourceId: string
): InboundTriggerSourceState => {
  if (!adapterState.sources[sourceId]) {
    adapterState.sources[sourceId] = {
      lastSeenTs: null,
      lastProcessedIds: [],
    };
  }
  return adapterState.sources[sourceId];
};

/**
 * Add a message ID to the LRU dedup list.
 * Maintains max size by trimming oldest entries.
 */
const addToProcessedIds = (ids: string[], messageId: string): string[] => {
  const updated = [...ids, messageId];
  if (updated.length > MAX_PROCESSED_IDS) {
    return updated.slice(updated.length - MAX_PROCESSED_IDS);
  }
  return updated;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class InboundTriggerService {
  private readonly store: KeyValueStore<InboundTriggerStoreState>;
  private state: InboundTriggerStoreState;
  private readonly adapters = new Map<string, InboundTriggerAdapter>();
  private readonly pollingCleanups = new Map<string, () => void>();
  private readonly pollInProgress = new Set<string>();
  private readonly activeTurnsBySource = new Map<string, string>(); // sourceKey → sessionId
  private readonly lastPolledSourceIndex = new Map<string, number>(); // adapterId → last source index (for round-robin)
  private readOnlyMode = false;
  private disposed = false;

  constructor(private readonly deps: InboundTriggerServiceDeps) {
    // Guard CONSTRUCTION: conf throws at construct time on a corrupt file.
    const created = safeCreateStore<InboundTriggerStoreState>(
      { name: 'inbound-triggers', defaults: createDefaultState() },
      createDefaultState(),
    );
    this.store = created.store;
    if (created.loadFailed) {
      this.readOnlyMode = true;
      this.state = createDefaultState();
      log.warn('Inbound trigger store construction failed on existing data - read-only (data preserved)');
      return;
    }

    // Guard the `.store` read + migrate: a thrown load (corrupt JSON / schema /
    // decrypt / transient IO) must NEVER reset+persist over real data — and must
    // not crash construction. Classify ENOENT (fresh init) vs
    // existing-but-unreadable (preserve raw + back up + latch read-only).
    const store = this.store;
    const guarded = loadStoreSafely<MigrationResult<InboundTriggerStoreState>>(
      'inbound-triggers',
      resolveConfStorePath('inbound-triggers'),
      () =>
        migrateStore(store.store, {
          storeName: 'inbound-triggers',
          currentVersion: INBOUND_TRIGGER_STORE_VERSION,
          migrations: INBOUND_TRIGGER_MIGRATIONS,
          createDefault: createDefaultState,
        }),
      // Consumed only on `absent` (genuine fresh init → writable); `load-failed`
      // short-circuits before reading shouldPersist.
      () => ({
        data: createDefaultState(),
        status: 'fresh' as const,
        fromVersion: null,
        toVersion: INBOUND_TRIGGER_STORE_VERSION,
        backupPath: null,
        shouldPersist: true,
      }),
    );

    if (isLoadFailedReadOnly(guarded)) {
      // Existing-but-unreadable file: preserve it, run on ephemeral defaults,
      // block writes.
      this.readOnlyMode = true;
      this.state = createDefaultState();
    } else {
      const migrationResult = guarded.data;
      this.readOnlyMode = shouldEnterReadOnlyMode(migrationResult);
      if (migrationResult.shouldPersist) {
        this.store.store = migrationResult.data;
      }
      this.state = migrationResult.data;
    }

    log.info(
      {
        version: this.state.version,
        adapterCount: Object.keys(this.state.adapters).length,
        readOnly: this.readOnlyMode,
      },
      'Inbound trigger store loaded'
    );
  }

  // -------------------------------------------------------------------------
  // Adapter Registration
  // -------------------------------------------------------------------------

  /**
   * Register an adapter. Must be called before initialize().
   */
  registerAdapter(adapter: InboundTriggerAdapter): void {
    if (this.adapters.has(adapter.id)) {
      log.warn({ adapterId: adapter.id }, 'Adapter already registered, replacing');
    }
    this.adapters.set(adapter.id, adapter);

    // Ensure adapter has a state entry
    if (!this.state.adapters[adapter.id]) {
      this.state.adapters[adapter.id] = createAdapterState(false);
      this.persistState();
    }

    log.info(
      { adapterId: adapter.id, displayName: adapter.displayName },
      'Adapter registered'
    );
  }

  markSourcePolledNow(adapterId: string, sourceId: string, timestamp: string = String(Date.now())): string {
    const adapterState = this.state.adapters[adapterId];
    if (!adapterState) {
      return timestamp;
    }

    const sourceState = getOrCreateSourceState(adapterState, sourceId);
    sourceState.lastSeenTs = timestamp;
    adapterState.lastPollAt = Date.now();
    this.persistState();
    log.info(
      { adapterId, sourceId, timestamp },
      'Inbound trigger source cursor advanced without polling',
    );
    return timestamp;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the service: start polling for all enabled adapters.
   */
  initialize(): void {
    log.info('Initializing inbound trigger service');

    for (const [adapterId, adapterState] of Object.entries(this.state.adapters)) {
      if (adapterState.enabled && this.adapters.has(adapterId)) {
        this.startPolling(adapterId);
      }
    }

    log.info(
      {
        registeredAdapters: [...this.adapters.keys()],
        enabledAdapters: Object.entries(this.state.adapters)
          .filter(([, s]) => s.enabled)
          .map(([id]) => id),
      },
      'Inbound trigger service initialized'
    );
  }

  /**
   * Graceful shutdown: stop all polling loops and persist state.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    log.info('Disposing inbound trigger service');

    for (const [adapterId, cleanup] of this.pollingCleanups) {
      cleanup();
      log.debug({ adapterId }, 'Stopped polling');
    }
    this.pollingCleanups.clear();
    this.persistState();

    log.info('Inbound trigger service disposed');
  }

  // -------------------------------------------------------------------------
  // Polling Control
  // -------------------------------------------------------------------------

  /**
   * Start polling for a specific adapter.
   */
  startPolling(adapterId: string): void {
    if (this.disposed) {
      log.warn({ adapterId }, 'Cannot start polling — service is disposed');
      return;
    }

    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      log.warn({ adapterId }, 'Cannot start polling — adapter not registered');
      return;
    }

    // Stop existing polling if any
    this.stopPolling(adapterId);

    const normalMs = adapter.getDefaultIntervalMs();
    const batteryMs = normalMs * 2;

    log.info(
      { adapterId, normalMs, batteryMs },
      'Starting polling for adapter'
    );

    const cleanup = createBatteryThrottledInterval(
      () => this.pollAdapter(adapterId),
      normalMs,
      batteryMs
    );

    this.pollingCleanups.set(adapterId, cleanup);
  }

  /**
   * Stop polling for a specific adapter.
   */
  stopPolling(adapterId: string): void {
    const cleanup = this.pollingCleanups.get(adapterId);
    if (cleanup) {
      cleanup();
      this.pollingCleanups.delete(adapterId);
      log.info({ adapterId }, 'Stopped polling for adapter');
    }
  }

  /**
   * Enable or disable an adapter. Starts/stops polling accordingly.
   */
  setAdapterEnabled(adapterId: string, enabled: boolean): void {
    const adapterState = this.state.adapters[adapterId];
    if (!adapterState) {
      log.warn({ adapterId }, 'Cannot set enabled — adapter state not found');
      return;
    }

    if (adapterState.enabled === enabled) {
      return; // No change
    }

    adapterState.enabled = enabled;
    this.persistState();

    log.info({ adapterId, enabled }, 'Adapter enabled state changed');

    if (enabled) {
      this.startPolling(adapterId);
    } else {
      this.stopPolling(adapterId);
    }
  }

  // -------------------------------------------------------------------------
  // State Access
  // -------------------------------------------------------------------------

  /** Get the current persisted state (read-only snapshot) */
  getState(): InboundTriggerStoreState {
    return this.state;
  }

  /** Get state for a specific adapter */
  getAdapterState(adapterId: string): InboundTriggerAdapterState | null {
    return this.state.adapters[adapterId] ?? null;
  }

  /** Check if an adapter's prerequisites are met for enabling */
  async checkPrerequisites(adapterId: string): Promise<{ ready: boolean; reason: string | null }> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      return { ready: false, reason: 'Adapter not registered.' };
    }
    return adapter.checkPrerequisites();
  }

  // -------------------------------------------------------------------------
  // Core Polling Logic
  // -------------------------------------------------------------------------

  /**
   * Poll a single adapter for new triggers.
   * Enforces concurrency guard and processes one trigger per cycle.
   */
  private async pollAdapter(adapterId: string): Promise<void> {
    if (this.disposed) return;

    // Concurrency guard: skip if previous poll is still running
    if (this.pollInProgress.has(adapterId)) {
      log.debug({ adapterId }, 'Poll skipped — previous poll still in progress');
      return;
    }

    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      log.warn({ adapterId }, 'Poll skipped — adapter not registered');
      return;
    }

    const adapterState = this.state.adapters[adapterId];
    if (!adapterState?.enabled) {
      log.debug({ adapterId }, 'Poll skipped — adapter disabled');
      return;
    }

    this.pollInProgress.add(adapterId);

    try {
      // Check if adapter is configured (tokens, credentials, etc.)
      const configured = await adapter.isConfigured();
      if (!configured) {
        log.debug({ adapterId }, 'Poll skipped — adapter not configured');
        return;
      }

      // Get all sources this adapter should poll
      const sourceIds = await adapter.getSourceIds();
      if (sourceIds.length === 0) {
        log.debug({ adapterId }, 'Poll skipped — no sources to poll');
        return;
      }

      // Round-robin: start from where we left off last cycle to prevent starvation
      const lastIdx = this.lastPolledSourceIndex.get(adapterId) ?? -1;
      const startIdx = (lastIdx + 1) % sourceIds.length;
      const orderedSourceIds = [
        ...sourceIds.slice(startIdx),
        ...sourceIds.slice(0, startIdx),
      ];

      // Try each source until we find a trigger (one trigger per cycle)
      for (let i = 0; i < orderedSourceIds.length; i++) {
        if (this.disposed) return;

        const sourceId = orderedSourceIds[i];
        const sourceKey = `${adapterId}:${sourceId}`;

        // Skip if there's an active inbound turn for this source
        if (this.activeTurnsBySource.has(sourceKey)) {
          log.debug(
            { adapterId, sourceId },
            'Source skipped — active inbound turn running'
          );
          continue;
        }

        const sourceState = getOrCreateSourceState(adapterState, sourceId);

        // First-enable lookback: set lastSeenTs to 5 minutes ago and persist
        let effectiveLastSeenTs = sourceState.lastSeenTs;
        if (effectiveLastSeenTs === null) {
          const lookbackTs = String(Date.now() - FIRST_ENABLE_LOOKBACK_MS);
          effectiveLastSeenTs = lookbackTs;
          sourceState.lastSeenTs = lookbackTs; // Persist to prevent sliding window
          log.info(
            { adapterId, sourceId, lookbackTs },
            'First poll for source — using and persisting lookback timestamp'
          );
        }

        // Build dedup set from persisted IDs
        const processedIds = new Set(sourceState.lastProcessedIds);

        // Poll the adapter for this source
        const trigger = await adapter.poll(sourceId, effectiveLastSeenTs, processedIds);

        if (trigger) {
          log.info(
            {
              adapterId,
              sourceId,
              messageId: trigger.messageId,
              summary: trigger.summary,
            },
            'Trigger detected'
          );

          // Track round-robin position (index in original sourceIds array)
          const originalIdx = sourceIds.indexOf(sourceId);
          this.lastPolledSourceIndex.set(adapterId, originalIdx);

          // Process trigger in background (don't block polling for other sources)
          this.processTrigger(adapter, adapterState, sourceState, sourceKey, trigger)
            .catch((err) => {
              log.error({ err, adapterId, sourceId }, 'Background trigger processing failed');
            });

          // Update poll stats once per cycle
          adapterState.lastPollAt = Date.now();
          adapterState.pollCount += 1;
          adapterState.lastError = null;
          adapterState.lastErrorAt = null;
          this.persistState();
          return; // One trigger per cycle
        }
      }

      // No triggers found in any source — update stats once per cycle
      adapterState.lastPollAt = Date.now();
      adapterState.pollCount += 1;
      adapterState.lastError = null;
      adapterState.lastErrorAt = null;
      this.persistState();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error({ err: error, adapterId }, 'Poll failed');

      if (adapterState) {
        adapterState.lastErrorAt = Date.now();
        adapterState.lastError = errorMessage;
        this.persistState();
      }
    } finally {
      this.pollInProgress.delete(adapterId);
    }
  }

  /**
   * Process a single trigger: acknowledge, spawn agent turn, update state.
   */
  private async processTrigger(
    adapter: InboundTriggerAdapter,
    adapterState: InboundTriggerAdapterState,
    sourceState: InboundTriggerSourceState,
    sourceKey: string,
    trigger: InboundTrigger
  ): Promise<void> {
    if (trigger.externalContext) {
      await this.processExternalContextTrigger(adapter, adapterState, sourceState, sourceKey, trigger);
      return;
    }

    await this.processLegacyTrigger(adapter, adapterState, sourceState, sourceKey, trigger);
  }

  private async processLegacyTrigger(
    adapter: InboundTriggerAdapter,
    adapterState: InboundTriggerAdapterState,
    sourceState: InboundTriggerSourceState,
    sourceKey: string,
    trigger: InboundTrigger
  ): Promise<void> {
    const sessionId = `inbound-${adapter.id}--${randomUUID()}`;
    const turnId = randomUUID();

    // 1. Post acknowledgment (best-effort)
    try {
      await adapter.postAcknowledgment(trigger);
      log.debug(
        { adapterId: adapter.id, messageId: trigger.messageId },
        'Acknowledgment posted'
      );
    } catch (ackError) {
      log.warn(
        { err: ackError, adapterId: adapter.id, messageId: trigger.messageId },
        'Acknowledgment failed — proceeding with agent turn'
      );
    }

    // 2. Build prompt
    const prompt = adapter.buildPrompt(trigger);

    // 3. Create session via dep
    try {
      await this.deps.createSession({
        id: sessionId,
        title: trigger.summary,
        createdAt: Date.now(),
        origin: 'inbound-trigger',
      });
    } catch (sessionError) {
      log.error(
        { err: sessionError, sessionId },
        'Failed to create session — skipping trigger'
      );
      return;
    }

    // 4. Track active turn for this source (prevents concurrent polls)
    this.activeTurnsBySource.set(sourceKey, sessionId);

    // 5. Add to processed IDs (dedup) — do this before the turn to prevent
    //    re-detection if the turn takes a long time
    sourceState.lastProcessedIds = addToProcessedIds(
      sourceState.lastProcessedIds,
      trigger.messageId
    );
    adapterState.triggerCount += 1;

    // 6. Create adapter-specific safety hook (if the adapter provides one)
    const safetyHook = adapter.createSafetyHook?.(trigger, this.deps.getSettings()) ?? undefined;

    // 7. Build user-facing display message (shown in conversation sidebar).
    //    Separate from the agent prompt which contains internal instructions.
    const displayMessage = adapter.buildDisplayMessage?.(trigger) ?? trigger.summary;
    const startedAt = Date.now();
    const userMessage: AgentTurnMessage = {
      id: createId(),
      role: 'user',
      turnId,
      text: displayMessage,
      createdAt: startedAt,
    };

    // 8. Broadcast full session to renderer for immediate sidebar visibility.
    //    Must happen after building userMessage so the renderer gets a complete session.
    const initialSession: AgentSession = {
      id: sessionId,
      title: trigger.summary,
      createdAt: startedAt,
      updatedAt: startedAt,
      messages: [userMessage],
      eventsByTurn: {},
      activeTurnId: turnId,
      isBusy: true,
      lastError: null,
      resolvedAt: null,
      origin: 'inbound-trigger',
    };
    this.deps.broadcastToRenderer('inbound-triggers:session-created', initialSession);

    // 9. Set up event accumulation (same pattern as automations)
    //    Since win=null for background turns, events aren't sent to the renderer via IPC.
    //    We accumulate them here and persist to the session store so the conversation
    //    is visible when the user opens it.
    let convState: ConversationStateShape = {
      messages: [],
      eventsByTurn: {},
      activeTurnId: turnId,
      focusedTurnId: null,
      isBusy: true,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    };

    const persistSession = () => {
      const messages: AgentTurnMessage[] = [userMessage, ...convState.messages];
      const session: AgentSession = {
        id: sessionId,
        title: trigger.summary,
        createdAt: startedAt,
        updatedAt: Date.now(),
        messages,
        eventsByTurn: convState.eventsByTurn,
        activeTurnId: convState.activeTurnId,
        isBusy: convState.isBusy,
        lastError: convState.lastError,
          resolvedAt: null,
        origin: 'inbound-trigger',
      };
      this.deps.updateSession(session).catch((err) => {
        log.warn({ err, sessionId }, 'Failed to persist inbound trigger session');
      });
    };

    const onEvent = (event: import('@shared/types').AgentEvent) => {
      const sanitized = sanitizeEventForMainAccumulation(event);
      // Stage 2: thinking_delta is transient (manifest persistence.mainAccumulator:false) —
      // don't fold it into the persisted inbound-trigger conversation state.
      if (event.type !== 'thinking_delta') {
        convState = updateConversationWithEvent(convState, turnId, sanitized);
      }

      if (event.type === 'result' || event.type === 'error') {
        convState.activeTurnId = null;
        convState.isBusy = false;
        if (event.type === 'error') {
          convState.lastError = event.error;
        }
      }
      persistSession();
    };

    // 9. Execute agent turn
    try {
      await this.deps.executeAgentTurn(turnId, prompt, {
        sessionId,
        onEvent,
        inboundSafetyHook: safetyHook,
      });

      // Success: advance lastSeenTs
      sourceState.lastSeenTs = trigger.timestamp;
      log.info(
        {
          adapterId: adapter.id,
          sourceId: trigger.sourceId,
          sessionId,
          messageId: trigger.messageId,
        },
        'Inbound trigger agent turn completed successfully'
      );
    } catch (turnError) {
      // Failure: do NOT advance lastSeenTs (allow retry on next cycle).
      // The messageId is already in processedIds, so it won't be picked up again
      // within the LRU window. This is intentional — we don't want infinite retries
      // for permanently failing triggers.
      log.error(
        {
          err: turnError,
          adapterId: adapter.id,
          sourceId: trigger.sourceId,
          sessionId,
        },
        'Inbound trigger agent turn failed'
      );
    } finally {
      this.activeTurnsBySource.delete(sourceKey);
      this.persistState();
    }
  }

  private async processExternalContextTrigger(
    adapter: InboundTriggerAdapter,
    adapterState: InboundTriggerAdapterState,
    sourceState: InboundTriggerSourceState,
    sourceKey: string,
    trigger: InboundTrigger
  ): Promise<void> {
    const context = trigger.externalContext;
    if (!context) {
      await this.processLegacyTrigger(adapter, adapterState, sourceState, sourceKey, trigger);
      return;
    }

    // 1. Post acknowledgment (best-effort), matching the legacy desktop polling behavior.
    try {
      await adapter.postAcknowledgment(trigger);
      log.debug(
        { adapterId: adapter.id, messageId: trigger.messageId },
        'Acknowledgment posted',
      );
    } catch (ackError) {
      log.warn(
        { err: ackError, adapterId: adapter.id, messageId: trigger.messageId },
        'Acknowledgment failed — proceeding with external conversation routing',
      );
    }

    const sourceTeamId = context.kind === 'slack-thread' || context.kind === 'slack-mention-poll'
      ? context.identity.teamId
      : trigger.sourceId;
    const teamIdHash = hashTeamId(sourceTeamId);
    const eventId = trigger.timestamp;
    const text = adapter.buildPrompt(trigger);
    const service = this.deps.externalConversationService;
    const resolver = this.deps.conversationScopeResolver;

    if (!service || !resolver) {
      log.warn(
        { adapterId: adapter.id, messageId: trigger.messageId },
        'External conversation dependencies missing — falling back to legacy inbound trigger path',
      );
      adapter.releaseDuplicateGuard?.(trigger);
      // COMPAT: slack-mention-poll fallback
      await this.processLegacyTrigger(adapter, adapterState, sourceState, sourceKey, trigger);
      return;
    }

    this.activeTurnsBySource.set(sourceKey, `external:${trigger.messageId}`);

    try {
      const existing = resolver.lookup(context);
      if (existing) {
        if (LEGACY_SLACK_INBOUND_SESSION_ID_RE.test(existing.conversationId)) {
          log.info(
            { sessionId: existing.conversationId, teamIdHash },
            'slack_polling_legacy_session_observed',
          );
        }
        log.info(
          { eventId, teamIdHash, outcome: 'existing' },
          'slack_desktop_thread_binding_probe',
        );
        await service.injectMessage({
          conversationId: existing.conversationId,
          context,
          text,
        });
      } else if (this.deps.getSettings().experimental?.slackDesktopThreadContinuity !== false) {
        log.info(
          { eventId, teamIdHash, outcome: 'created-new' },
          'slack_desktop_thread_binding_probe',
        );
        await service.createConversation(context, {
          userText: this.extractUserTextForExternalConversation(trigger),
          switchToConversation: false,
        });
      } else {
        log.info(
          { eventId, teamIdHash, outcome: 'fallback-legacy' },
          'slack_desktop_thread_binding_probe',
        );
        adapter.releaseDuplicateGuard?.(trigger);
        // COMPAT: slack-mention-poll fallback
        await this.processLegacyTrigger(adapter, adapterState, sourceState, sourceKey, trigger);
        return;
      }

      // F23 / 260523 §G5: advance the polling cursor only after
      // injectMessage/createConversation returns successfully. If the call
      // throws, lastSeenTs stays put so the next poll retries; downstream
      // Slack delivery failures surface through the existing
      // external-delivery:failed safety net rather than a polling retry.
      sourceState.lastProcessedIds = addToProcessedIds(
        sourceState.lastProcessedIds,
        trigger.messageId,
      );
      adapterState.triggerCount += 1;
      sourceState.lastSeenTs = trigger.timestamp;
      log.info(
        {
          adapterId: adapter.id,
          sourceId: trigger.sourceId,
          messageId: trigger.messageId,
        },
        'Inbound trigger external conversation routed successfully',
      );
    } catch (err) {
      adapter.releaseDuplicateGuard?.(trigger);
      log.error(
        {
          err,
          adapterId: adapter.id,
          sourceId: trigger.sourceId,
          messageId: trigger.messageId,
        },
        'Inbound trigger external conversation routing failed',
      );
    } finally {
      this.activeTurnsBySource.delete(sourceKey);
      this.persistState();
    }
  }

  private extractUserTextForExternalConversation(trigger: InboundTrigger): string {
    const text = trigger.context.text;
    return typeof text === 'string' ? text : trigger.summary;
  }

  // -------------------------------------------------------------------------
  // State Persistence
  // -------------------------------------------------------------------------

  private persistState(): void {
    if (this.readOnlyMode) {
      log.debug('Skipping state persist — read-only mode');
      return;
    }
    try {
      this.store.store = this.state;
    } catch (error) {
      log.error({ err: error }, 'Failed to persist inbound trigger state');
    }
  }
}
