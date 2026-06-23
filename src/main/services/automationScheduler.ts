import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { KeyValueStore } from '@core/store';
import type {
  AgentEvent,
  AgentSession,
  AgentTurnMessage,
  AutomationAdmissionBlock,
  AppSettings,
  AutomationDefinition,
  AutomationEventType,
  AutomationProviderReadinessSummary,
  AutomationRun,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationScheduleQuarantineEntry,
  AutomationStoreState,
  AutomationTrigger,
  AutomationDefinitionInput,
  CloudAutomationDelta,
  PersonalizedUseCase
} from '@shared/types';
import { AUTOMATION_STORE_VERSION, MAX_AUTOMATION_RUN_HISTORY } from '../constants';
// Scheduling logic lives in @shared/utils/automationScheduling.
// Import for local use within this file; re-exported below for backward compatibility.
import {
  calculateNextRunAt as _calculateNextRunAt,
  calculateMostRecentScheduledTime as _calculateMostRecentScheduledTime,
} from '@shared/utils/automationScheduling';
import { createScopedLogger } from '@core/logger';
import { apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';
import { relativePortablePath } from '@core/utils/portablePath';
import { normalizeFinishLine } from '@core/utils/finishLine';
import {
  stripYamlFrontmatter,
  substitutePromptVariables,
  injectEventContext,
  normalizeAutomationModelOverride,
} from '@core/services/automationUtils';
import { getScheduler, type SchedulerTimerHandle } from '@core/scheduler';
import type { ChiefOfStaffHygieneRunResult } from '@core/services/chiefOfStaffHygieneRunnerService';
import {
  evaluateProviderReadinessRule,
  evaluateRateLimitCooldownRule,
  isProviderReadinessEligibleAutomation,
  scheduleDefinitionWithMaxTimeout,
  shouldSkipDueToActiveRun,
  summarizeProviderReadinessBlocks,
  waitForInteractiveTurnToSettle,
} from '@core/services/automation/automationRules';
import { validateProviderCredentials, type ProviderCredentialState } from '@core/utils/validateProviderCredentials';
import { getCodexAuthProvider } from '@core/codexAuth';

const log = createScopedLogger({ service: 'automationScheduler' });
import { migrateStore, shouldEnterReadOnlyMode, type VersionedData, type MigrationFn } from '../utils/storeMigration';
import { loadStoreSafely, isLoadFailedReadOnly, resolveConfStorePath, safeCreateStore } from '@core/utils/loadStoreSafely';
import { trackMainEvent, getOrGenerateAnonymousId } from '../analytics';
import { hashSessionId } from '@shared/trackingTypes';
import { deriveInteractionTimestamp, updateConversationWithEvent, type ConversationStateShape } from '@shared/utils/conversationState';
import { assertEventHasSeq, type SequencedAgentEvent } from '@shared/utils/eventIdentity';
import { nextContentUpdatedAt } from '@shared/utils/sessionTimestamps';
import {
  broadcastSequencedAgentEvent,
  dispatchAgentErrorEvent,
  dispatchAgentEvent,
  sanitizeEventForMainAccumulation,
  showAutomationOutcomeNotification,
} from './agentEventDispatcher';
import { getErrorReporter } from '@core/errorReporter';
import { createId } from '@shared/utils/id';
import { resolveLibraryPath, isPathInsideLexical } from '../utils/systemUtils';
import { agentTurnRegistry } from './agentTurnRegistry';
import { isShuttingDown } from './shutdownState';
import { getSystemSettingsPath } from './systemSettingsSync';
import { getIncrementalSessionStore } from './incrementalSessionStore';
import { CIRCUIT_BREAKER_DENIAL_PREFIX } from './safety/constants';
import { markRunComplete, onAllResolved, clearAutomation } from './safety/automationPendingItemsTracker';
import { buildFocusAutomationContext } from './focusAutomationContext';
import { clearSessionStagedCalls } from './safety/stagedToolCallsService';
import { runAutomationScript } from '@core/services/automations/scriptRunner';
import { AutomationSchedule as ScheduleConstructors } from '@shared/utils/automationSchedule';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import { isMainFlagEnabled, type MainFeatureFlagOverrides } from '@shared/featureFlags';
import type { MigrationFallbackTelemetry } from '@shared/types/fallbackTelemetry';
import { fireAndForget } from '@shared/utils/fireAndForget';

const SOURCE_CAPTURE_SKILL_FILE_PATH = 'rebel-system/skills/memory/source-capture/SKILL.md';
const SOURCE_CAPTURE_AUTOMATION_FILE_PATH = 'rebel-system/skills/memory/source-capture/AUTOMATION.md';

function normalizeLegacyAutomationDefinition(definition: AutomationDefinition): AutomationDefinition {
  if (
    definition.isSystem &&
    definition.systemType === 'source-capture' &&
    definition.filePath === SOURCE_CAPTURE_SKILL_FILE_PATH
  ) {
    return {
      ...definition,
      filePath: SOURCE_CAPTURE_AUTOMATION_FILE_PATH,
    };
  }

  return definition;
}

function normalizeLegacyAutomationDefinitions(definitions: AutomationDefinition[]): AutomationDefinition[] {
  let changed = false;
  const normalized = definitions.map((definition) => {
    const nextDefinition = normalizeLegacyAutomationDefinition(definition);
    if (nextDefinition !== definition) {
      changed = true;
    }
    return nextDefinition;
  });

  return changed ? normalized : definitions;
}

function extractDefinitionId(definition: unknown): string | undefined {
  if (typeof definition !== 'object' || definition === null) {
    return undefined;
  }
  const id = (definition as { id?: unknown }).id;
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined;
}

type UseCaseGenerationResult = {
  success: boolean;
  useCases?: PersonalizedUseCase[];
  userFirstName?: string;
  error?: string;
};

type CommunityRefreshResult = {
  success: boolean;
  error?: string;
};

type CalendarSyncResult = {
  success: boolean;
  meetingCount?: number;
  error?: string;
};

/**
 * Return shape for the space-maintenance daily pipeline. Mirrors
 * `MaintenanceResult` in `@core/services/spaceMaintenanceService` but kept
 * structural here so the scheduler doesn't need to import the core type
 * (avoids a runtime module load on the scheduler's critical path).
 */
type SpaceMaintenanceResult = {
  scanned: number;
  quarantinedIdentical: number;
  mergedSuccessfully: number;
  mergeFailed: number;
  mergeSkippedBackoff: number;
  mergeSkippedCircuitBreaker: number;
  mergeSkippedBinary: number;
  mergeSkippedTooLarge: number;
  mergeAbortedRace: number;
  frontmatterRepaired: number;
  errors: string[];
  elapsedMs: number;
  timeBudgetExceeded?: boolean;
};

type AutomationSchedulerDeps = {
  getCoreDirectory: () => string | null;
  executeAgentTurn: (
    turnId: string,
    prompt: string,
    options: {
      sessionId: string;
      onEvent: (event: AgentEvent) => void;
      modelOverride?: string;
      thinkingModelOverride?: string;
    }
  ) => Promise<void>;
  notifyRenderer?: (state: AutomationStoreState) => void;
  getSettings?: () => AppSettings;
  updateSettings?: (updater: (current: AppSettings) => AppSettings) => void;
  generateUseCases?: (settings: AppSettings) => Promise<UseCaseGenerationResult>;
  refreshCommunityHighlights?: () => Promise<CommunityRefreshResult>;
  refreshVideoRecs?: () => Promise<{ success: boolean; error?: string }>;
  syncCalendarCache?: () => Promise<CalendarSyncResult>;
  /**
   * Run the daily space-maintenance pipeline. Wired in `src/main/index.ts`
   * via the Electron-backed adapter. Returning a plain result object lets
   * the scheduler translate it into an `AutomationExecutionResult` without
   * re-importing core types.
   */
  runSpaceMaintenance?: (coreDir: string, settings: AppSettings) => Promise<SpaceMaintenanceResult>;
  runChiefOfStaffHygiene?: (coreDir: string, settings: AppSettings) => Promise<ChiefOfStaffHygieneRunResult>;
};

export type AutomationDefinitionPatch = Omit<AutomationDefinitionInput, 'schedule'> & {
  // R6 Stage 3: schedule is branded-only. All callers must produce values via
  // `AutomationSchedule.*` constructors or `fromUntrusted`. Untyped boundary
  // payloads are normalised at the IPC / bridge entry points before reaching
  // upsertDefinition (see automationsHandlers.ts and bundledInboxBridge.ts).
  schedule?: AutomationSchedule;
};

type AutomationExecutionResult = {
  status: AutomationRunStatus;
  error?: string | null;
  errorKind?: Extract<AgentEvent, { type: 'error' }>['errorKind'];
  limitScope?: Extract<AgentEvent, { type: 'error' }>['limitScope'];
  credentialSource?: Extract<AgentEvent, { type: 'error' }>['credentialSource'];
  headlineClass?: Extract<AgentEvent, { type: 'error' }>['headlineClass'];
  // Already redacted upstream (AgentEvent.rawError via redactAndTruncateRawError);
  // length-bounded (200 chars) only at the analytics emission site, not here.
  rawError?: string;
  rateLimitResetAtMs?: number;
  admissionBlock?: AutomationAdmissionBlock;
  /**
   * Whether this run should consume the current schedule slot by advancing
   * definition.lastRunAt. Defaults to true.
   */
  advanceScheduleSlot?: boolean;
  session: AgentSession | null;
  eventsByTurn?: Record<string, AgentEvent[]>;
  messages?: AgentTurnMessage[];
  summary?: string;
  blockedActions?: import('@shared/types').BlockedAction[];
  startedAt: number;
  completedAt: number;
  tokenUsage?: import('@shared/types').AutomationRunTokenUsage;
  estimatedCostUsd?: number;
  targetPeriodStart?: number;
};

// Approximate Claude pricing (Sonnet-class). Last verified: Feb 2026.
// Update when model mix changes or Anthropic adjusts pricing.
const COST_PER_INPUT_TOKEN = 3 / 1_000_000;   // ~$3/1M input tokens
const COST_PER_OUTPUT_TOKEN = 15 / 1_000_000;  // ~$15/1M output tokens

/**
 * Extract aggregated token usage from result events across all turns.
 * Returns null if no usage data was found (e.g. non-LLM pipelines).
 * @internal
 */
export function extractTokenUsageFromEvents(
  eventsByTurn: Record<string, AgentEvent[]> | undefined
): { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number | null; toolCallCount: number } | null {
  if (!eventsByTurn) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd: number | null = null;
  let toolCallCount = 0;
  let hasUsage = false;

  for (const events of Object.values(eventsByTurn)) {
    for (const event of events) {
      if (event.type === 'result' && event.usage) {
        inputTokens += event.usage.inputTokens ?? 0;
        outputTokens += event.usage.outputTokens ?? 0;
        cacheReadTokens += event.usage.cacheReadTokens ?? 0;
        if (event.usage.costUsd != null) {
          costUsd = (costUsd ?? 0) + event.usage.costUsd;
        }
        if (event.toolMetrics) {
          toolCallCount += event.toolMetrics.totalToolCalls;
        }
        hasUsage = true;
      }
    }
  }

  return hasUsage ? { inputTokens, outputTokens, cacheReadTokens, costUsd, toolCallCount } : null;
}

interface AutomationStoreShape extends AutomationStoreState, VersionedData {}

const WINS_LEARNINGS_AUTOMATION_ID = 'system-wins-learnings-uncover';
const COMMUNITY_HIGHLIGHTS_AUTOMATION_ID = 'system-community-highlights';
const COMMUNITY_VIDEO_RECS_AUTOMATION_ID = 'system-community-video-recs';

/**
 * System automation types that use non-LLM pipelines (no agent runtime process).
 * These are exempt from interactive turn deferral since they're lightweight.
 * Note: 'use-case-refresh' is deprecated but harmless to include.
 */
const NON_LLM_SYSTEM_TYPES = new Set([
  'use-case-refresh',
  'community-highlights',
  'calendar-sync',
  'chief-of-staff-hygiene',
]);
const DIRECT_SYSTEM_PIPELINE_TYPES = new Set([
  'use-case-refresh',
  'community-highlights',
  'calendar-sync',
  'community-video-recs',
  'chief-of-staff-hygiene',
]);
const CALENDAR_SYNC_AUTOMATION_ID = 'system-calendar-sync';
const SOURCE_CAPTURE_AUTOMATION_ID = 'system-source-capture';
const TRANSCRIPT_ANALYSIS_AUTOMATION_ID = 'system-transcript-analysis';
const TRANSCRIPT_DISTRIBUTION_AUTOMATION_ID = 'system-transcript-distribution';
const MORNING_TRIAGE_AUTOMATION_ID = 'system-morning-triage';
const FOCUS_WEEKLY_PREP_AUTOMATION_ID = 'system-focus-weekly-prep';
const FOCUS_MONTHLY_REVIEW_AUTOMATION_ID = 'system-focus-monthly-review';
const SPACE_MAINTENANCE_AUTOMATION_ID = 'system-space-maintenance';
const CHIEF_OF_STAFF_HYGIENE_AUTOMATION_ID = 'system-chief-of-staff-hygiene';

/**
 * Create default automation state with all system automations.
 * Called for fresh installs (no existing data).
 */
const createDefaultAutomationState = (): AutomationStoreShape => {
  const now = Date.now();
  return {
    version: AUTOMATION_STORE_VERSION,
    definitions: [
      // Daily wins & learnings
      {
        id: WINS_LEARNINGS_AUTOMATION_ID,
        name: 'Daily Wins & Learnings',
        description: 'Uncover your most impactful wins and learnings from the past 24 hours',
        filePath: 'rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md',
        schedule: ScheduleConstructors.daily({ time: '09:30' }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'wins-learnings-uncover',
      },
      // Community highlights
      {
        id: COMMUNITY_HIGHLIGHTS_AUTOMATION_ID,
        name: 'Community Highlights',
        description: 'Fetch trending topics from the Rebels community',
        filePath: '',
        schedule: ScheduleConstructors.daily({ time: '08:00' }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'community-highlights'
      },
      // Calendar sync (daily at 7am) - disabled by default, direct sync handles Google/Microsoft
      // Only enabled when user has other calendar providers (settings.calendar.useOtherCalendarProvider)
      {
        id: CALENDAR_SYNC_AUTOMATION_ID,
        name: 'Calendar Sync (Other Providers)',
        description: 'Sync calendars using LLM (for non-Google/Microsoft providers)',
        filePath: '',
        schedule: ScheduleConstructors.daily({ time: '07:00' }),
        enabled: false, // Disabled by default - direct sync handles Google/Microsoft
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'calendar-sync',
      },
      // Source capture (three times daily).
      // Stage 2C (260514_openrouter_sonnet_bypass_remediation.md): the `model`
      // field is intentionally omitted on the fresh-install default. The
      // hardcoded `'claude-sonnet-4-6'` literal here was the Sonnet-bypass
      // root cause for OpenRouter / Codex users — it overrode the active
      // provider's helper-resolved default. Resolution is now deferred to
      // fire-time via `getDefaultModelForProvider(settings, 'background')`.
      {
        id: SOURCE_CAPTURE_AUTOMATION_ID,
        name: 'Source Capture',
        description: 'Capture citable sources (meetings, documents, files) into memory with provenance metadata',
        filePath: SOURCE_CAPTURE_AUTOMATION_FILE_PATH,
        schedule: ScheduleConstructors.daily({ time: '12:30', additionalTimes: ['09:30', '15:00', '17:30'] }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'source-capture',
      },
      // Transcript analysis (event-triggered)
      {
        id: TRANSCRIPT_ANALYSIS_AUTOMATION_ID,
        name: 'When Transcript Arrives',
        description: 'Process meeting transcripts with context enrichment and follow-up proposals',
        filePath: 'rebel-system/skills/meetings/transcript-analysis/SKILL.md',
        schedule: ScheduleConstructors.event({ eventType: 'transcript-ready' }),
        enabled: true,
        catchUpIfMissed: false,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'transcript-analysis',
      },
      // Transcript distribution to spaces (event-triggered, fires after async upgrade)
      {
        id: TRANSCRIPT_DISTRIBUTION_AUTOMATION_ID,
        name: 'Distribute Transcript to Spaces',
        description: 'Evaluate transcript content and distribute to relevant spaces',
        filePath: 'rebel-system/skills/meetings/transcript-distribution/SKILL.md',
        schedule: ScheduleConstructors.event({ eventType: 'transcript-distribution-ready' }),
        enabled: true,
        catchUpIfMissed: false,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'transcript-distribution',
      },
      // Morning triage (daily at 07:30, catches up if missed)
      {
        id: MORNING_TRIAGE_AUTOMATION_ID,
        name: 'Morning Triage',
        description: 'Reviews active inbox items against calendar, email, and Slack to set metadata, mark completions, and surface items for today.',
        filePath: 'rebel-system/skills/operations/morning-triage/AUTOMATION.md',
        schedule: ScheduleConstructors.daily({ time: '07:30' }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'morning-triage',
      },
      // Community video picks (monthly on 1st at 09:00)
      {
        id: COMMUNITY_VIDEO_RECS_AUTOMATION_ID,
        name: 'Community Video Picks',
        description: 'Monthly curation of community talk videos relevant to your work',
        filePath: '',
        schedule: ScheduleConstructors.monthly({ daysOfMonth: [1], time: '09:00' }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'community-video-recs',
      },
      // Focus weekly prep (Sunday 7pm, catches up Monday morning)
      {
        id: FOCUS_WEEKLY_PREP_AUTOMATION_ID,
        name: 'Focus: Weekly Prep',
        description: 'Chief-of-staff weekly briefing — analyzes calendar and goals to surface alignment gaps, preparation needs, and strategic priorities.',
        filePath: 'rebel-system/skills/focus/focus-weekly-prep/AUTOMATION.md',
        schedule: ScheduleConstructors.weekly({ daysOfWeek: [0], time: '19:00' }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'focus-weekly-prep',
      },
      // Focus monthly review (1st of month, 7pm, catches up)
      {
        id: FOCUS_MONTHLY_REVIEW_AUTOMATION_ID,
        name: 'Focus: Monthly Review',
        description: 'Chief-of-staff monthly retrospective — reviews time allocation vs goals, surfaces patterns, and recommends adjustments.',
        filePath: 'rebel-system/skills/focus/focus-monthly-review/AUTOMATION.md',
        schedule: ScheduleConstructors.monthly({ daysOfMonth: [1], time: '19:00' }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'focus-monthly-review',
      },
      // Space maintenance (daily at 06:00) — cleans up .conflict-cloud files
      // via LLM merge for shared-space users. Run-time gated to surfaces
      // that actually have non-private shared spaces configured.
      {
        id: SPACE_MAINTENANCE_AUTOMATION_ID,
        name: 'Space Maintenance',
        description: 'Daily cleanup and conflict resolution for shared spaces',
        filePath: '',
        schedule: ScheduleConstructors.daily({ time: '06:00' }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'space-maintenance',
      },
      // Chief-of-Staff hygiene (weekly at 06:20) — routine private context cleanup.
      {
        id: CHIEF_OF_STAFF_HYGIENE_AUTOMATION_ID,
        name: 'Chief-of-Staff Hygiene',
        description: 'Weekly cleanup for private profile context',
        filePath: '',
        schedule: ScheduleConstructors.weekly({ daysOfWeek: [0], time: '06:20' }),
        enabled: true,
        catchUpIfMissed: true,
        createdAt: now,
        updatedAt: now,
        isSystem: true,
        systemType: 'chief-of-staff-hygiene',
      },
    ],
    runs: [],
    quarantined: [],
    sessionTypeFilter: 'all'
  };
};

const AUTOMATION_MIGRATIONS: Record<number, MigrationFn<AutomationStoreShape>> = {
  1: (data) => {
    const now = Date.now();
    const existingWinsLearnings = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'wins-learnings-uncover'
    );

    if (existingWinsLearnings) {
      return { ...data, version: 2 };
    }

    const winsLearningsAutomation: AutomationDefinition = {
      id: WINS_LEARNINGS_AUTOMATION_ID,
      name: 'Daily Wins & Learnings',
      description: 'Uncover your most impactful wins and learnings from the past 24 hours',
      filePath: 'rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md',
      schedule: ScheduleConstructors.daily({ time: '09:30' }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'wins-learnings-uncover'
    };

    return {
      ...data,
      version: 2,
      definitions: [...data.definitions, winsLearningsAutomation]
    };
  },
  2: (data) => {
    // Migrate runOnLaunch -> catchUpIfMissed
    // For hourly: default false (too frequent for catch-up)
    // For daily+: default true (users likely want to catch up)
    const definitions = data.definitions.map((def) => {
      const isHourly = def.schedule?.type === 'hourly';
      const legacyDef = def as AutomationDefinition & { runOnLaunch?: boolean };
      const legacyRunOnLaunch = legacyDef.runOnLaunch;
      const { runOnLaunch: _removed, ...rest } = legacyDef;
      return {
        ...rest,
        catchUpIfMissed: isHourly ? false : (legacyRunOnLaunch ?? true)
      } as AutomationDefinition;
    });
    return { ...data, version: 3, definitions };
  },
  3: (data) => {
    // Fix wins-and-learnings-uncover path: skills moved to folder-based format
    // Old: rebel-system/skills/operations/wins-and-learnings-uncover.md
    // New: rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md
    const definitions = data.definitions.map((def) => {
      if (def.filePath === 'rebel-system/skills/operations/wins-and-learnings-uncover.md') {
        return {
          ...def,
          filePath: 'rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md'
        };
      }
      return def;
    });
    return { ...data, version: 4, definitions };
  },
  4: (data) => {
    // Add community highlights system automation
    const now = Date.now();
    const existingCommunity = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'community-highlights'
    );

    if (existingCommunity) {
      return { ...data, version: 5 };
    }

    const communityAutomation: AutomationDefinition = {
      id: COMMUNITY_HIGHLIGHTS_AUTOMATION_ID,
      name: 'Community Highlights',
      description: 'Fetch trending topics from the Rebels community',
      filePath: '', // Not file-based
      schedule: ScheduleConstructors.daily({ time: '08:00' }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'community-highlights'
    };

    return {
      ...data,
      version: 5,
      definitions: [...data.definitions, communityAutomation]
    };
  },
  5: (data) => {
    // Add calendar sync system automation (daily at 7am)
    // Note: Originally was hourly with broken 'interval' field, now daily
    const now = Date.now();
    const existingCalendarSync = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'calendar-sync'
    );

    if (existingCalendarSync) {
      return { ...data, version: 6 };
    }

    const calendarSyncAutomation: AutomationDefinition = {
      id: CALENDAR_SYNC_AUTOMATION_ID,
      name: 'Calendar Sync',
      description: 'Sync upcoming meetings from connected calendars into the 24h cache',
      filePath: '', // Not file-based - uses special execution path
      schedule: ScheduleConstructors.daily({ time: '07:00' }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'calendar-sync'
    };

    return {
      ...data,
      version: 6,
      definitions: [...data.definitions, calendarSyncAutomation]
    };
  },
  6: (data) => {
    // v6→v7: Add support for event-triggered automations
    // No data migration needed - the new 'event' schedule type is additive
    // Existing automations continue to work unchanged
    return { ...data, version: 7 };
  },
  7: (data) => {
    // v7→v8: Add source-capture system automation (runs twice daily: lunchtime and end of workday)
    const now = Date.now();
    const existingSourceCapture = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'source-capture'
    );

    if (existingSourceCapture) {
      return { ...data, version: 8 };
    }

    const sourceCaptureAutomation: AutomationDefinition = {
      id: SOURCE_CAPTURE_AUTOMATION_ID,
      name: 'Source Capture',
      description: 'Capture citable sources (meetings, documents, files) into memory with provenance metadata',
      filePath: SOURCE_CAPTURE_SKILL_FILE_PATH,
      schedule: ScheduleConstructors.daily({ time: '12:30', additionalTimes: ['17:30'] }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'source-capture'
    };

    return {
      ...data,
      version: 8,
      definitions: [...data.definitions, sourceCaptureAutomation]
    };
  },
  8: (data) => {
    // v8→v9: Remove duplicated eventsByTurn/messages/session from runs
    // This data is already stored in sessions/<sessionId>.json
    // Removing reduces automations.json from ~20MB to ~100KB
    const runs = (Array.isArray(data.runs) ? data.runs : []).map((run) => {
      if (!run || typeof run !== 'object') return run as AutomationRun;
      const legacyRun = run as AutomationRun & {
        _eventsByTurn?: unknown;
        _messages?: unknown;
        session?: { id?: string } | null;
      };
      const { _eventsByTurn, _messages, session, ...rest } = legacyRun;
      // Ensure sessionId is preserved from session.id if missing
      const sessionId = rest.sessionId ?? session?.id ?? null;
      return { ...rest, sessionId } as AutomationRun;
    });
    return { ...data, version: 9, runs };
  },
  9: (data) => {
    // v9→v10: Update source-capture to use AUTOMATION.md wrapper instead of SKILL.md
    // The SKILL.md is reference documentation; AUTOMATION.md is the actionable prompt
    const definitions = data.definitions.map((def) => {
      if (def.filePath === SOURCE_CAPTURE_SKILL_FILE_PATH) {
        return {
          ...def,
          filePath: SOURCE_CAPTURE_AUTOMATION_FILE_PATH
        };
      }
      return def;
    });
    return { ...data, version: 10, definitions };
  },
  10: (data) => {
    // v10→v11: Add transcript-analysis system automation (event-triggered)
    // Fires when any meeting transcript is saved, processes it with context enrichment
    const now = Date.now();
    const existingTranscriptAnalysis = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'transcript-analysis'
    );

    if (existingTranscriptAnalysis) {
      return { ...data, version: 11 };
    }

    const transcriptAnalysisAutomation: AutomationDefinition = {
      id: TRANSCRIPT_ANALYSIS_AUTOMATION_ID,
      name: 'When Transcript Arrives',
      description: 'Process meeting transcripts with context enrichment and follow-up proposals',
      filePath: 'rebel-system/skills/meetings/transcript-analysis/SKILL.md',
      schedule: ScheduleConstructors.event({ eventType: 'transcript-ready' }),
      enabled: true,
      catchUpIfMissed: false, // Event-triggered - catch-up doesn't apply (Plaud sync has its own retry)
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'transcript-analysis'
    };

    return {
      ...data,
      version: 11,
      definitions: [...data.definitions, transcriptAnalysisAutomation]
    };
  },
  11: (data) => {
    // v11→v12: Update calendar-sync from hourly to daily at 7am
    // The hourly schedule was broken anyway (used non-existent 'interval' field)
    const definitions = data.definitions.map((def) => {
      if (def.isSystem && def.systemType === 'calendar-sync') {
        return {
          ...def,
          schedule: ScheduleConstructors.daily({ time: '07:00' }),
          catchUpIfMissed: true,
          updatedAt: Date.now()
        };
      }
      return def;
    });
    return { ...data, version: 12, definitions };
  },
  12: (data) => {
    // v12→v13: Disable calendar-sync automation by default
    // Calendar sync now uses free direct MCP calls (calendarSyncScheduler) instead of expensive LLM automation.
    // Users who have other calendars (not Google/Microsoft) can re-enable via settings toggle.
    const definitions = data.definitions.map((def) => {
      if (def.isSystem && def.systemType === 'calendar-sync') {
        return {
          ...def,
          enabled: false, // Disable by default - direct sync takes over
          updatedAt: Date.now()
        };
      }
      return def;
    });
    return { ...data, version: 13, definitions };
  },
  13: (data) => {
    // v13→v14: Convert showAutomationSessions boolean to sessionTypeFilter tri-state
    // The new filter adds 'all' option which shows both conversations and automations (default)
    // Existing users get 'all' by default to experience the new blended view
    // Only preserve 'automations' if user had explicitly set showAutomationSessions: true
    
    // Guard against partial upgrades: if sessionTypeFilter already exists, just clean up
    const dataAsAny = data as unknown as { sessionTypeFilter?: string; showAutomationSessions?: boolean };
    if ('sessionTypeFilter' in dataAsAny && typeof dataAsAny.sessionTypeFilter === 'string') {
      const { showAutomationSessions: _removed, ...rest } = dataAsAny;
      return { ...rest, version: 14 } as typeof data;
    }
    
    const oldShowAutomations = dataAsAny.showAutomationSessions;
    const sessionTypeFilter = oldShowAutomations === true ? 'automations' : 'all';
    
    // Remove old field and add new one
    const { showAutomationSessions: _removed, ...rest } = dataAsAny;
    return { ...rest, version: 14, sessionTypeFilter } as typeof data;
  },
  14: (data) => {
    // v14→v15: Add access rules fields to automation definitions (legacy — now superseded by Safety Prompt)
    // No-op: fields will be stripped in v16→v17 migration.
    return { ...data, version: 15 };
  },
  15: (data) => {
    // v15→v16: Auto-approve system automation access rules (legacy — now superseded by Safety Prompt).
    // No-op: originally a separate v16 migration was supposed to strip these fields,
    // but a duplicate JS key meant it never ran. The fields are now inert (Safety Prompt
    // is the canonical mechanism). See the v16 migration comment below.
    return { ...data, version: 16 };
  },
  // NOTE: A previous v16 migration existed to strip accessRules/accessRulesStatus/
  // toolApprovalGrants (Safety Prompt replaced them). It was dead code due to a duplicate
  // JS object key — the migration below silently overwrote it. Removed to prevent confusion.
  // The stale fields on non-inbox automations are harmless (Safety Prompt ignores them).
  16: (data) => {
    // v16→v17: Add rebel_inbox_list + rebel_inbox_update (archive only) to wins-learnings-uncover and source-capture.
    // Enables LLM-based freshness checks by piggybacking on existing automations.
    // - approved + unmodified (v16 built-in) rules: apply new rules, keep approved
    // - approved + user-customized rules: leave alone (user explicitly modified them)
    // - all other statuses (pending_review, update_suggested, generation_failed, undefined):
    //   apply new rules and auto-approve. This is intentional for system automations
    //   (same pattern as v15→v16): built-in automations should receive capability
    //   updates without requiring re-approval. The new capabilities (read inbox list +
    //   archive only) are conservative and evidence-gated via prompt instructions.

    const V16_RULES: Partial<Record<string, string>> = {
      'wins-learnings-uncover': `PURPOSE: Review the user's recent meetings, emails, and conversations from the past 24 hours to identify and summarise their most impactful wins and key learnings.

ALLOWED ACTIONS:
- Read emails (list, search, read message content) for the past 1-2 days
- Read calendar events and meeting details for the past 1-2 days
- Read meeting transcripts and notes from the user's workspace
- Read existing memory/space content and workspace files for context
- Read Slack messages from the user's channels for the past 1-2 days
- Write a summary to the user's personal memory
- Do NOT create Actions from wins, learnings, reflections, recaps, or share-to-social suggestions

INBOX QUALITY RULES (when using rebel_inbox_add):
- Only add concrete, actionable tasks the user owns or must act on
- Do NOT add other people's tasks ("Harry needs to fix X" is Harry's task)
- Do NOT add insights, wins, learnings, or recaps as inbox items — those belong in the Coach section, not the inbox
- Do NOT add items the user has already completed (check archived/executed items first)
- Do NOT add newsletter content, promotional emails, or automated digests as tasks
- Do NOT add items from tools the user hasn't connected — only use data from active integrations
- Each item must have enough context to act on without re-reading the source material
- Do NOT add status confirmations or "already resolved" items — those are FYI, not tasks
- Each item title must be specific enough to act on without re-reading the source
- TITLE FORMAT: Every title MUST start with an action verb (Review, Follow up, Send, Share, Check, etc.). "Customer training" is a topic — "Review customer training proposal" is an action. Topics are not inbox items.
- Set important: false if you're less than 80% confident the user personally must act on this. When in doubt, false — the item still exists in the inbox but won't crowd the homepage.

NEVER ALLOWED:
- Send, delete, or modify emails
- Create, modify, or delete calendar events
- Post to Slack, Teams, or other messaging platforms
- Modify or delete existing memory entries (only create new ones)
- Write to shared spaces (personal memory only)
- Access data older than 2 days without explicit date calculation

EXAMPLES OF OK CALLS:
- gmail:list_messages with query "newer_than:1d"
- gmail:get_message to read message content
- google_calendar:list_events for the past 24 hours
- search_slack_messages for the user's recent activity
- Read workspace files modified in the past 1-2 days
- Write to personal memory summarising wins and learnings
- Write wins and learnings to personal memory/Coach context — not Actions

EXAMPLES OF NOT OK CALLS:
- gmail:send_message (sending is out of scope)
- gmail:trash_message (deleting is out of scope)
- google_calendar:create_event (creating events is out of scope)
- post_slack_message (posting messages is out of scope)
- Write to shared spaces or other users' memory
- rebel_inbox_add with a win, learning, insight, recap, reflection, or share-to-social suggestion (write to memory/Coach context instead)
- rebel_inbox_add for a task someone else owns`,

      'source-capture': `PURPOSE: Capture citable sources from recent meetings, documents, and files into memory with provenance metadata for later reference.

ALLOWED ACTIONS:
- Read calendar events and meeting details
- Read meeting transcripts and notes
- Read emails for source material references
- Read files and documents that were recently accessed or shared
- Write new source entries to the user's personal memory (Chief-of-Staff) with provenance metadata (author, date, context)
- Update existing personal memory entries to add or enrich source metadata and citations
- Use rebel_inbox_feedback to review recent dismissed Actions feedback for this automation before creating new items
- Use rebel_inbox_add to notify the user of newly captured high-value sources

INBOX QUALITY RULES (when using rebel_inbox_add):
- Before creating Actions, call rebel_inbox_feedback with automationId "system-source-capture" and automationName "source-capture". Treat examples as weak evidence, not keyword rules.
- Only add items requiring the user's action (e.g. "Review source X before Friday meeting")
- Do NOT add other people's tasks or items the user doesn't need to act on
- Do NOT add insights, summaries, or recaps — those belong in the Coach section, not the inbox
- Each item must include enough context to act on without re-reading the source
- Do NOT add status confirmations or "already resolved" items — those are FYI, not tasks
- Each item title must be specific enough to act on without re-reading the source

NEVER ALLOWED:
- Send, delete, or modify emails
- Create, modify, or delete calendar events
- Delete source files, documents, or memory entries
- Post to messaging platforms (Slack, Teams, etc.)

NOTE: Writing to shared spaces requires separate approval. If the automation determines a source belongs in a shared space, it will request approval through the interactive approval flow. Approved spaces will be added to these rules automatically.

EXAMPLES OF OK CALLS:
- google_calendar:list_events to find recent meetings
- gmail:list_messages to find document references
- gmail:get_message to read source content
- Read meeting transcript files
- Write to Chief-of-Staff memory with source provenance metadata
- Edit existing personal memory file to add source citations
- rebel_inbox_feedback to calibrate against recent dismissed source-capture Actions
- rebel_inbox_add to flag a high-value source for the user

EXAMPLES OF NOT OK CALLS:
- gmail:send_message (sending is out of scope)
- gmail:trash_message (deleting is out of scope)
- Delete memory entries or source files
- slack:post_message (wrong integration)
- rebel_inbox_add with a summary or insight (write to memory instead)`,
    };

    const definitions = data.definitions.map((def) => {
      if (!def.isSystem || !def.systemType) return def;

      const updatedRules = V16_RULES[def.systemType];
      if (!updatedRules) return def;

      // Only migrate wins-learnings-uncover and source-capture
      const v16Rules = V16_RULES[def.systemType];
      if (!v16Rules) return def;

      if (def.accessRulesStatus === 'approved' && def.accessRules) {
        if (def.accessRules.trim() !== v16Rules.trim()) {
          // User customized rules — don't touch
          return def;
        }
      }

      return {
        ...def,
        accessRules: updatedRules,
        accessRulesStatus: 'approved' as const,
      };
    });
    return { ...data, version: 17, definitions };
  },
  17: (data) => {
    // v17→v18: Add 15:00 Source Capture run for mid-afternoon freshness check.
    // Gives users actionable inbox updates while there's still time in the day.
    const definitions = data.definitions.map((def) => {
      try {
        if (def.isSystem && def.systemType === 'source-capture' && def.schedule?.type === 'daily') {
          const times = def.schedule.additionalTimes ?? [];
          if (!times.includes('15:00')) {
            return {
              ...def,
              schedule: ScheduleConstructors.daily({
                time: def.schedule.time,
                additionalTimes: ['15:00', ...times],
              }),
            };
          }
        }
      } catch {
        // Leave the definition; eager migration handles quarantine.
        return def;
      }
      return def;
    });
    return { ...data, version: 18, definitions };
  },
  18: (data) => {
    // v18→v19: Force-add rebel_inbox_list + rebel_inbox_update to wins-learnings-uncover
    // and source-capture access rules. The v16→v17 migration skipped users whose rules
    // didn't exactly match the v16 snapshot (i.e., any customization). This left those
    // automations unable to perform freshness checks. This migration is additive-only:
    // it appends inbox capabilities to existing rules without removing anything.
    const INBOX_ALLOWED = `- Read active inbox items via rebel_inbox_list to check for externally completed tasks
- Read recent dismissed Actions feedback via rebel_inbox_feedback to avoid repeating source-specific misses
- Archive confirmed-complete inbox items via rebel_inbox_update with archived=true (ONLY when evidence found in email/calendar/Slack that the task was completed)`;
    const INBOX_OK = `- rebel_inbox_list to check active items against recent activity
- rebel_inbox_feedback to calibrate proposed Actions against recent dismissals
- rebel_inbox_update with { id, archived: true } when sent email confirms completion`;
    const INBOX_NOT_OK = `- rebel_inbox_update to modify item content (archive status only)
- rebel_inbox_remove (no deleting — archive only)`;

    const TYPES_TO_PATCH: string[] = ['wins-learnings-uncover', 'source-capture'];

    const definitions = data.definitions.map((def) => {
      if (!def.isSystem || !def.systemType || !TYPES_TO_PATCH.includes(def.systemType)) return def;
      if (!def.accessRules) return def;

      const rules = def.accessRules as string;
      if (rules.includes('rebel_inbox_list')) return def;

      let patched = rules;

      const allowedIdx = patched.indexOf('ALLOWED ACTIONS:');
      if (allowedIdx !== -1) {
        const neverIdx = patched.indexOf('NEVER ALLOWED:', allowedIdx);
        if (neverIdx !== -1) {
          patched = patched.slice(0, neverIdx) + INBOX_ALLOWED + '\n\n' + patched.slice(neverIdx);
        }
      }

      const okIdx = patched.lastIndexOf('EXAMPLES OF OK CALLS:');
      if (okIdx !== -1) {
        const notOkIdx = patched.indexOf('EXAMPLES OF NOT OK CALLS:', okIdx);
        if (notOkIdx !== -1) {
          patched = patched.slice(0, notOkIdx) + INBOX_OK + '\n\n' + patched.slice(notOkIdx);
        }
      }

      const notOkEnd = patched.lastIndexOf('EXAMPLES OF NOT OK CALLS:');
      if (notOkEnd !== -1) {
        patched = patched.trimEnd() + '\n' + INBOX_NOT_OK;
      }

      return { ...def, accessRules: patched };
    });
    return { ...data, version: 19, definitions };
  },
  19: (data) => {
    // v19→v20: Widen the "2 days" data access constraint for inbox freshness checks.
    // The tool safety layer blocks searches like `newer_than:5d` because stored rules
    // say "Access data older than 2 days" is NEVER ALLOWED. Add an explicit exception
    // for targeted inbox freshness searches (up to 14 days).
    const OLD_CONSTRAINT = 'Access data older than 2 days without explicit date calculation';
    const NEW_CONSTRAINT = 'Access data older than 2 days without explicit date calculation — EXCEPTION: inbox freshness checks may search sent mail up to 14 days back when cross-referencing a specific inbox item';

    const definitions = data.definitions.map((def) => {
      if (!def.isSystem || !def.accessRules) return def;
      const rules = def.accessRules as string;
      if (!rules.includes(OLD_CONSTRAINT) || rules.includes('EXCEPTION:')) return def;
      return { ...def, accessRules: rules.replace(OLD_CONSTRAINT, NEW_CONSTRAINT) };
    });
    return { ...data, version: 20, definitions };
  },
  20: (data) => {
    // v20→v21: Add transcript-distribution system automation (event-triggered).
    // Fires after transcript reaches final quality; distributes to relevant spaces.
    const now = Date.now();
    const existingDistribution = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'transcript-distribution'
    );
    if (existingDistribution) {
      return { ...data, version: 21 };
    }
    const transcriptDistributionAutomation: AutomationDefinition = {
      id: TRANSCRIPT_DISTRIBUTION_AUTOMATION_ID,
      name: 'Distribute Transcript to Spaces',
      description: 'Evaluate transcript content and distribute to relevant spaces',
      filePath: 'rebel-system/skills/meetings/transcript-distribution/SKILL.md',
      schedule: ScheduleConstructors.event({ eventType: 'transcript-distribution-ready' }),
      enabled: true,
      catchUpIfMissed: false,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'transcript-distribution',
    };
    return {
      ...data,
      version: 21,
      definitions: [...data.definitions, transcriptDistributionAutomation],
    };
  },
  21: (data) => {
    // v21→v22: Add optional per-automation model fields.
    // No-op migration because these fields are optional.
    return { ...data, version: 22 };
  },
  22: (data) => {
    // v22→v23: Add morning-triage system automation (daily at 07:30).
    // Cross-references calendar, email, and Slack with active inbox items
    // to set metadata, mark completions, and surface items for today.
    const now = Date.now();
    const existingMorningTriage = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'morning-triage'
    );
    if (existingMorningTriage) {
      return { ...data, version: 23 };
    }
    const morningTriageAutomation: AutomationDefinition = {
      id: MORNING_TRIAGE_AUTOMATION_ID,
      name: 'Morning Triage',
      description: 'Reviews active inbox items against calendar, email, and Slack to set metadata, mark completions, and surface items for today.',
      filePath: 'rebel-system/skills/operations/morning-triage/AUTOMATION.md',
      schedule: ScheduleConstructors.daily({ time: '07:30' }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'morning-triage',
    };
    return {
      ...data,
      version: 23,
      definitions: [...data.definitions, morningTriageAutomation],
    };
  },
  23: (data) => {
    // v23→v24: Defensive re-migration — fix source-capture stores where the v9→v10
    // filePath update didn't apply. AUTOMATION.md has the actionable [PROCESS];
    // SKILL.md is reference documentation that causes the agent to ask instead of act.
    const definitions = data.definitions.map((def) => {
      if (
        def.isSystem &&
        def.systemType === 'source-capture' &&
        def.filePath === SOURCE_CAPTURE_SKILL_FILE_PATH
      ) {
        return {
          ...def,
          filePath: SOURCE_CAPTURE_AUTOMATION_FILE_PATH
        };
      }
      return def;
    });
    return { ...data, version: 24, definitions };
  },
  24: (data) => {
    // v24→v25: Add 09:30 Source Capture run to close the morning coverage gap
    // between Morning Triage (07:30) and the first Source Capture (12:30).
    //
    // BLOCKER 2 (R6 Stage 2 refinement): same per-definition try/catch as v31→v32
    // so a malformed pre-existing `daily.time` doesn't propagate the throw and
    // wipe the user's whole automation list via storeMigration.ts catch-and-replace.
    const definitions = data.definitions.map((def) => {
      try {
        if (def.isSystem && def.systemType === 'source-capture' && def.schedule?.type === 'daily') {
          const times = def.schedule.additionalTimes ?? [];
          if (!times.includes('09:30')) {
            return {
              ...def,
              schedule: ScheduleConstructors.daily({
                time: def.schedule.time,
                additionalTimes: ['09:30', ...times],
              }),
            };
          }
        }
      } catch {
        // Leave the definition; eager migration handles quarantine.
        return def;
      }
      return def;
    });
    return { ...data, version: 25, definitions };
  },
  25: (data) => {
    // v25→v26: Add support for once-scheduled automations.
    // No data migration needed — the new 'once' schedule type is additive.
    return { ...data, version: 26 };
  },
  26: (data) => {
    // v26→v27: Stage 2C (260514_openrouter_sonnet_bypass_remediation.md).
    //
    // ORIGINAL behavior (v26 release): Set Source Capture to use Sonnet in
    // single-model mode when no `model` was already set. This was the run-once
    // overwrite that, on OpenRouter / Codex installs, silently rewrote a
    // freshly-migrated record to Sonnet at next boot — bypassing the active
    // provider and incurring the 4×/day cost compounding documented in D-CO-3.
    //
    // CURRENT behavior (Option B, additive-only, flag-gated): the migration
    // map function is a pure version bump. It NEVER mutates `definitions` —
    // the legacy v26 record (often with empty `model`) is upgraded in-place
    // to v27 unchanged. Provider-aware mutation is opt-in via the
    // `enableV26V27ProviderMigration` flag (default OFF) and is performed by
    // `applyProviderAwareV26V27Pass()` in the constructor, AFTER eager
    // schedule migration. That pass:
    //   - resolves the model via `getDefaultModelForProvider(settings, 'background')`
    //   - emits `MigrationFallbackTelemetry` (kind:'settings', bootPhase:'migration')
    //   - mutates only when flag ON AND `activeProvider === 'anthropic'`
    //   - skips telemetry entirely when an existing user model is present
    //     (case (c) per iter-3 D-BS-1/D-OP-1 — no migration event to report)
    //
    // Source Capture's runtime fire-time call site additionally resolves the
    // model via the helper when the persisted record has no `model`, so
    // greenfield v27 installs (no model on the record) route correctly to the
    // active provider's default without ever needing the migration mutation.
    return { ...data, version: 27 };
  },
  27: (data) => {
    // v27→v28: Add community video picks system automation (monthly on 1st at 09:00).
    // Curates personalized video recommendations from community talk recordings.
    const now = Date.now();
    const existingVideoRecs = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'community-video-recs'
    );
    if (existingVideoRecs) {
      return { ...data, version: 28 };
    }
    const videoRecsAutomation: AutomationDefinition = {
      id: COMMUNITY_VIDEO_RECS_AUTOMATION_ID,
      name: 'Community Video Picks',
      description: 'Monthly curation of community talk videos relevant to your work',
      filePath: '',
      schedule: ScheduleConstructors.monthly({ daysOfMonth: [1], time: '09:00' }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'community-video-recs',
    };
    return {
      ...data,
      version: 28,
      definitions: [...data.definitions, videoRecsAutomation],
    };
  },
  28: (data) => {
    // v28→v29: Add Focus weekly prep system automation (Sunday 7pm, catches up).
    // Chief-of-staff strategic briefing with calendar + goals analysis.
    const now = Date.now();
    const existing = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'focus-weekly-prep'
    );
    if (existing) {
      return { ...data, version: 29 };
    }
    const focusWeeklyPrep: AutomationDefinition = {
      id: FOCUS_WEEKLY_PREP_AUTOMATION_ID,
      name: 'Focus: Weekly Prep',
      description: 'Chief-of-staff weekly briefing — analyzes calendar and goals to surface alignment gaps, preparation needs, and strategic priorities.',
      filePath: 'rebel-system/skills/focus/focus-weekly-prep/AUTOMATION.md',
      schedule: ScheduleConstructors.weekly({ daysOfWeek: [0], time: '19:00' }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'focus-weekly-prep',
    };
    return {
      ...data,
      version: 29,
      definitions: [...data.definitions, focusWeeklyPrep],
    };
  },
  29: (data) => {
    // v29→v30: Add Focus monthly review system automation (1st of month, 7pm).
    // Monthly retrospective: time allocation vs goals, patterns, recommendations.
    const now = Date.now();
    const existing = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'focus-monthly-review'
    );
    if (existing) {
      return { ...data, version: 30 };
    }
    const focusMonthlyReview: AutomationDefinition = {
      id: FOCUS_MONTHLY_REVIEW_AUTOMATION_ID,
      name: 'Focus: Monthly Review',
      description: 'Chief-of-staff monthly retrospective — reviews time allocation vs goals, surfaces patterns, and recommends adjustments.',
      filePath: 'rebel-system/skills/focus/focus-monthly-review/AUTOMATION.md',
      schedule: ScheduleConstructors.monthly({ daysOfMonth: [1], time: '19:00' }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'focus-monthly-review',
    };
    return {
      ...data,
      version: 30,
      definitions: [...data.definitions, focusMonthlyReview],
    };
  },
  30: (data) => {
    // v30→v31: Add space-maintenance system automation (daily at 06:00).
    // Cleans up .conflict-cloud files via LLM merge for shared-space users.
    //
    // BLOCKER 4 (R6 Stage 2 refinement): if a previous load quarantined the
    // space-maintenance entry (malformed schedule shape from a future / fork
    // version), recreate the system-default fresh AND drop the orphan
    // quarantine envelope in the same step. The pre-fix branch SKIPPED
    // recreation when quarantined, leaving the user with no working space-
    // maintenance automation. The system-default schedule is well-defined
    // and recovery from the quarantine envelope is not needed.
    const existing = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'space-maintenance'
    );
    const quarantinedAfterRecreate = (data.quarantined ?? []).filter(
      (entry) => extractDefinitionId(entry.definition) !== SPACE_MAINTENANCE_AUTOMATION_ID,
    );
    if (existing) {
      return {
        ...data,
        version: 31,
        quarantined: quarantinedAfterRecreate,
      };
    }
    const now = Date.now();
    const spaceMaintenanceAutomation: AutomationDefinition = {
      id: SPACE_MAINTENANCE_AUTOMATION_ID,
      name: 'Space Maintenance',
      description: 'Daily cleanup and conflict resolution for shared spaces',
      filePath: '',
      schedule: ScheduleConstructors.daily({ time: '06:00' }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'space-maintenance',
      // proposeMerge uses settings.modelRoles.auxiliary — NOT this definition's
      // `model` field. Intentionally omitted so downstream model-override
      // paths don't pick up a stale value.
    };
    return {
      ...data,
      version: 31,
      definitions: [...data.definitions, spaceMaintenanceAutomation],
      quarantined: quarantinedAfterRecreate,
    };
  },
  31: (data) => {
    // v31→v32: Backfill missing anchorDate on every_n_days schedules.
    // MCP-created automations before this fix lacked anchorDate, causing the
    // scheduling math to fall back to anchor=now and fire on every app launch.
    // Uses createdAt as the anchor (best approximation of original user intent).
    //
    // BLOCKER 2 (R6 Stage 2 refinement): per-definition try/catch keeps a
    // throw inside the constructor (e.g. malformed `intervalDays: 0` or
    // `time: '9:00'`) from propagating up to `migrateStore`'s framework
    // catch-and-replace-with-default at storeMigration.ts:263-280, which
    // would silently nuke ALL user automations. On constructor throw we
    // return the definition unchanged — the post-migration eager migration
    // (`runEagerScheduleMigration`) handles quarantine.
    const definitions = data.definitions.map((def: AutomationDefinition) => {
      try {
        if (def.schedule?.type !== 'every_n_days') return def;
        const sched = def.schedule as { anchorDate?: string };
        if (sched.anchorDate && typeof sched.anchorDate === 'string' && sched.anchorDate.length > 0) return def;
        const fallback = def.createdAt ? new Date(def.createdAt) : new Date();
        return {
          ...def,
          schedule: ScheduleConstructors.everyNDays({
            intervalDays: def.schedule.intervalDays,
            time: def.schedule.time,
            anchorDate: fallback.toISOString().slice(0, 10),
          }),
        };
      } catch {
        // Leave the definition; runEagerScheduleMigration will quarantine.
        return def;
      }
    });
    return { ...data, version: 32, definitions };
  },
  32: (data) => {
    return {
      ...data,
      version: 33,
      quarantined: Array.isArray(data.quarantined) ? data.quarantined : [],
    };
  },
  33: (data) => {
    const existing = data.definitions.find(
      (def) => def.isSystem && def.systemType === 'chief-of-staff-hygiene',
    );
    const quarantinedAfterRecreate = (data.quarantined ?? []).filter(
      (entry) => extractDefinitionId(entry.definition) !== CHIEF_OF_STAFF_HYGIENE_AUTOMATION_ID,
    );
    if (existing) {
      return {
        ...data,
        version: 34,
        quarantined: quarantinedAfterRecreate,
      };
    }
    const now = Date.now();
    const chiefOfStaffHygieneAutomation: AutomationDefinition = {
      id: CHIEF_OF_STAFF_HYGIENE_AUTOMATION_ID,
      name: 'Chief-of-Staff Hygiene',
      description: 'Weekly cleanup for private profile context',
      filePath: '',
      schedule: ScheduleConstructors.weekly({ daysOfWeek: [0], time: '06:20' }),
      enabled: true,
      catchUpIfMissed: true,
      createdAt: now,
      updatedAt: now,
      isSystem: true,
      systemType: 'chief-of-staff-hygiene',
    };
    return {
      ...data,
      version: 34,
      definitions: [...data.definitions, chiefOfStaffHygieneAutomation],
      quarantined: quarantinedAfterRecreate,
    };
  },
  34: (data) => {
    const definitions = data.definitions.map((def) => {
      if (def.isSystem && def.systemType === 'chief-of-staff-hygiene') {
        return {
          ...def,
          description: 'Weekly cleanup for private profile context',
          schedule: ScheduleConstructors.weekly({ daysOfWeek: [0], time: '06:20' }),
          updatedAt: Date.now(),
        };
      }
      return def;
    });
    return {
      ...data,
      version: 35,
      definitions,
    };
  },
  35: (data) => {
    // v35→v36: allow Source Capture to read bounded dismissal feedback
    // examples before proposing new Actions. This is read-only calibration,
    // not a keyword suppression rule.
    const definitions = data.definitions.map((def) => {
      if (!def.isSystem || def.systemType !== 'source-capture' || typeof def.accessRules !== 'string') {
        return def;
      }
      if (def.accessRules.includes('rebel_inbox_feedback')) return def;
      return {
        ...def,
        accessRules: `${def.accessRules}

ADDITIONAL OK TOOL:
- rebel_inbox_feedback to review recent dismissed source-capture Actions as weak examples before creating new Actions. Do not use it to create keyword blacklists.`,
      };
    });
    return {
      ...data,
      version: 36,
      definitions,
    };
  },
  36: (data) => {
    // v36→v37: Scrub the v26-era hardcoded `claude-sonnet-4-6` literal from
    // system Source Capture records. The original v26 fresh-install default
    // baked Sonnet directly into the persisted record, which silently bypassed
    // the active provider for OpenRouter / Codex installs. The current v27
    // pure-version-bump migration only fills in unset model fields, so
    // existing users whose store still holds the literal need a one-shot
    // scrub. Limited to:
    //   - isSystem === true
    //   - systemType === 'source-capture'
    //   - model is exactly the v26 literal ('claude-sonnet-4-6' or its
    //     OpenRouter id-space twin 'anthropic/claude-sonnet-4-6')
    // After scrub, fire-time resolution via getDefaultModelForProvider falls
    // through to the active provider's background default, which is what
    // greenfield v27 installs already do. User-set or non-Sonnet models on
    // Source Capture, and any Sonnet model on user-created automations, are
    // explicitly preserved.
    // Plan-doc: docs/plans/260514_openrouter_sonnet_bypass_remediation.md.
    const STALE_SONNET_LITERALS = new Set(['claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6']);
    const definitions = data.definitions.map((def) => {
      if (!def.isSystem || def.systemType !== 'source-capture') return def;
      if (typeof def.model !== 'string' || !STALE_SONNET_LITERALS.has(def.model)) return def;
      const { model: _stale, ...rest } = def;
      return rest as AutomationDefinition;
    });
    return {
      ...data,
      version: 37,
      definitions,
    };
  },
};

const clampRuns = (runs: AutomationRun[]): AutomationRun[] =>
  runs.slice(0, MAX_AUTOMATION_RUN_HISTORY);

// stripYamlFrontmatter — imported from @core/services/automationUtils

const STALLED_RUN_TIMEOUT_MS = 30 * 60 * 1000;

const TERMINAL_RUN_STATUSES: ReadonlySet<AutomationRunStatus> = new Set([
  'success', 'completed_with_blocks', 'failure', 'blocked_by_security', 'cancelled',
]);

const _minutesToMs = (minutes: number): number => minutes * 60_000;

// formatLastSuccessTimestamp, substitutePromptVariables — imported from @core/services/automationUtils

// sanitizeContextValue, injectEventContext — imported from @core/services/automationUtils

// normalizeAutomationModelOverride — imported from @core/services/automationUtils

/**
 * Re-export from @shared/utils/automationScheduling for backward compatibility.
 * Desktop tests and other callers import from this file.
 */
export const calculateNextRunAt = _calculateNextRunAt;

export const calculateMostRecentScheduledTime = _calculateMostRecentScheduledTime;

export class AutomationScheduler {
  private readonly store: KeyValueStore<AutomationStoreState>;
  private timers = new Map<string, SchedulerTimerHandle>();
  private readonly scheduler = getScheduler();
  private stateSnapshot: AutomationStoreState;
  private readOnlyMode = false;
  private lowPowerModeReason: string | null = null;
  private _throttledBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BROADCAST_THROTTLE_MS = 500;
  private static readonly BROADCAST_THROTTLE_HIGH_CONCURRENCY_MS = 1500;
  private static readonly SESSION_UPSERT_DEBOUNCE_MS = 2000;
  private _pendingSessionUpserts = new Map<string, AgentSession>();
  private _sessionUpsertTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private isMigratingScheduleDefinitions = false;

  /** Tracks consecutive rules-update restarts per automation for loop protection */
  private rulesUpdateRestartCounts = new Map<string, number>();
  private static readonly MAX_RULES_UPDATE_RESTARTS = 3;

  // Pre-v17 definitions snapshot captured before migration strips accessRules.
  // Used by Safety Prompt migration to read legacy access rules.
  private legacyAccessRulesSnapshot: Array<{ name: string; description?: string; accessRules?: string; accessRulesStatus?: string }> | null = null;

  constructor(private readonly deps: AutomationSchedulerDeps) {
    const loadStart = Date.now();
    // Guard CONSTRUCTION: conf throws at construct time on a corrupt file.
    const created = safeCreateStore<AutomationStoreState>(
      { name: 'automations', defaults: createDefaultAutomationState() },
      createDefaultAutomationState(),
    );
    this.store = created.store;
    const loadDurationMs = Date.now() - loadStart;
    if (created.loadFailed) {
      this.readOnlyMode = true;
      this.stateSnapshot = createDefaultAutomationState();
      log.warn('Automation store construction failed on existing data - operating in read-only mode (data preserved)');
      return;
    }

    // Guard the `.store` read: a thrown load (corrupt JSON / schema / decrypt /
    // transient IO) must NEVER reset+persist over real automation data — and must
    // not crash construction. Classify ENOENT (fresh init) vs
    // existing-but-unreadable (preserve raw + back up + latch read-only).
    const guardedRaw = loadStoreSafely<AutomationStoreState>(
      'automations',
      resolveConfStorePath('automations'),
      () => this.store.store,
      createDefaultAutomationState,
    );
    if (isLoadFailedReadOnly(guardedRaw)) {
      // Existing-but-unreadable file: preserve it, run on ephemeral defaults,
      // block all writes (commitState/persist honour `readOnlyMode`).
      this.readOnlyMode = true;
      this.stateSnapshot = createDefaultAutomationState();
      log.warn('Automation store load failed on existing data - operating in read-only mode (data preserved)');
      return;
    }

    // Diagnostic: measure store size for OOM debugging
    const rawState = guardedRaw.data;
    const runCount = rawState.runs?.length ?? 0;
    const stateJsonSize = JSON.stringify(rawState).length;
    const largestRunSize = rawState.runs?.reduce((max, run) => {
      const runSize = JSON.stringify(run).length;
      return runSize > max ? runSize : max;
    }, 0) ?? 0;
    log.info(
      {
        loadDurationMs,
        runCount,
        stateJsonSizeKB: Math.round(stateJsonSize / 1024),
        largestRunSizeKB: Math.round(largestRunSize / 1024),
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      },
      'Automation store loaded - diagnostic metrics'
    );

    // Capture pre-migration definitions for Safety Prompt migration.
    // The v16→v17 migration strips accessRules, so we snapshot them first.
    if (rawState.version != null && rawState.version < 17) {
      this.legacyAccessRulesSnapshot = (rawState.definitions ?? [])
        .filter((d) => typeof d.accessRules === 'string' && d.accessRules.trim().length > 0)
        .map((d) => ({
          name: d.name,
          description: d.description,
          accessRules: d.accessRules as string,
          accessRulesStatus: d.accessRulesStatus,
        }));
    }

    // Use migration framework for safe version handling. Reuse the already
    // guard-loaded `rawState` so we don't re-read `.store` (which could re-throw).
    const migrationResult = migrateStore(rawState, {
      storeName: 'automations',
      currentVersion: AUTOMATION_STORE_VERSION,
      migrations: AUTOMATION_MIGRATIONS,
      createDefault: createDefaultAutomationState
    });

    // Track read-only mode for future version protection AND corrupted
    // migrations. The corrupted case matters here because of the post-load
    // persist below (`providerAwareState !== migrationResult.data && !readOnly`):
    // on corrupted we run on in-memory defaults while the real data stays on
    // disk, so read-only must block BOTH the `shouldPersist` write (already
    // false) AND that post-load write from clobbering the preserved file.
    this.readOnlyMode = shouldEnterReadOnlyMode(migrationResult);

    // Persist migrated data if needed
    if (migrationResult.shouldPersist) {
      this.store.store = migrationResult.data;
    }

    // Log migration status
    if (migrationResult.status === 'future_version') {
      log.warn(
        {
          storedVersion: migrationResult.fromVersion,
          currentVersion: AUTOMATION_STORE_VERSION
        },
        'Automation store from newer app version - operating in read-only mode to prevent data loss'
      );
    } else if (migrationResult.status === 'migrated') {
      log.info(
        {
          fromVersion: migrationResult.fromVersion,
          toVersion: migrationResult.toVersion,
          backupPath: migrationResult.backupPath
        },
        'Automation store migrated successfully'
      );
    }

    const normalizedRuns = this.normalizeRuns(migrationResult.data.runs);
    const normalizedDefinitions = normalizeLegacyAutomationDefinitions(migrationResult.data.definitions);
    const normalizedQuarantined = Array.isArray(migrationResult.data.quarantined)
      ? migrationResult.data.quarantined
      : [];

    const normalizedState =
      normalizedRuns === migrationResult.data.runs &&
      normalizedDefinitions === migrationResult.data.definitions &&
      normalizedQuarantined === migrationResult.data.quarantined
        ? migrationResult.data
        : {
            ...migrationResult.data,
            definitions: normalizedDefinitions,
            runs: normalizedRuns,
            quarantined: normalizedQuarantined,
          };

    const initialState = this.runEagerScheduleMigration(normalizedState, migrationResult.fromVersion);

    // Stage 2C — provider-aware v26→v27 post-load pass.
    // Plan-doc: docs/plans/260514_openrouter_sonnet_bypass_remediation.md (L577–593).
    // Runs after eager migration so it sees the post-migration definition set
    // but BEFORE persist + snapshot so any mutation lands in the same write.
    // No-op when fromVersion > 26 (already at v27 or beyond) and when
    // settings are not yet wired (graceful degrade — telemetry emits a warn).
    const providerAwareState = this.applyProviderAwareV26V27Pass(
      initialState,
      migrationResult.fromVersion,
    );

    if (providerAwareState !== migrationResult.data && !this.readOnlyMode) {
      this.store.store = providerAwareState;
    }
    this.stateSnapshot = providerAwareState;
  }

  private commitState(
    next: AutomationStoreState,
    options?: { persist?: boolean; suppressBroadcast?: boolean; persistState?: AutomationStoreState }
  ): AutomationStoreState {
    const normalizedDefinitions = normalizeLegacyAutomationDefinitions(next.definitions);
    const normalizedRuns = this.normalizeRuns(next.runs);
    const nextState =
      normalizedDefinitions === next.definitions && normalizedRuns === next.runs
        ? next
        : {
            ...next,
            definitions: normalizedDefinitions,
            runs: normalizedRuns
          };
    this.stateSnapshot = nextState;
    
    // Respect read-only mode for future version protection
    if ((options?.persist ?? true) && !this.readOnlyMode) {
      const persistStart = Date.now();
      const stateToPersist = options?.persistState
        ? {
            ...options.persistState,
            definitions: normalizeLegacyAutomationDefinitions(options.persistState.definitions),
            runs: this.normalizeRuns(options.persistState.runs),
          }
        : nextState;
      this.store.store = stateToPersist;
      const persistDurationMs = Date.now() - persistStart;
      // Log slow persists (>100ms) which can cause beach ball
      if (persistDurationMs > 100) {
        const stateSize = JSON.stringify(stateToPersist).length;
        log.warn(
          {
            persistDurationMs,
            stateSizeKB: Math.round(stateSize / 1024),
            runCount: nextState.runs.length,
            heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
          },
          'Slow automation store persist detected - potential beach ball cause'
        );
      }
      import('./perfAccumulator').then(({ recordStoreWrite }) => {
        recordStoreWrite(persistDurationMs, 'automation.persist');
      }).catch(() => { /* ignore import errors */ });
    } else if (this.readOnlyMode && (options?.persist ?? true)) {
      log.debug('Skipping automation store persist - operating in read-only mode');
    }
    
    if (!options?.suppressBroadcast) {
      this.broadcast();
    }
    return nextState;
  }

  private updateState(
    updater: (state: AutomationStoreState) => AutomationStoreState,
    options?: { persist?: boolean; suppressBroadcast?: boolean; persistState?: AutomationStoreState }
  ): AutomationStoreState {
    const next = updater(this.stateSnapshot);
    return this.commitState(next, options);
  }

  private updateRunsCollection(state: AutomationStoreState, run: AutomationRun): AutomationRun[] {
    const existingIndex = state.runs.findIndex((item) => item.id === run.id);
    if (existingIndex !== -1) {
      const nextRuns = [...state.runs];
      nextRuns[existingIndex] = run;
      return nextRuns;
    }
    return clampRuns([run, ...state.runs]);
  }

  private stripRunForStorage(run: AutomationRun): AutomationRun {
    const { eventsByTurn: _eventsByTurn, messages: _messages, session: _session, ...lightRun } = run;
    return lightRun;
  }

  private projectRunForBroadcast(run: AutomationRun): AutomationRun {
    return {
      ...run,
      eventsByTurn: undefined,
      messages: undefined,
      session: run.status === 'running' && run.session
        ? {
            ...run.session,
            messages: [],
            eventsByTurn: {},
          }
        : null,
    };
  }

  private stageRunSnapshot(run: AutomationRun): void {
    this.updateState(
      (state) => ({
        ...state,
        runs: this.updateRunsCollection(state, run)
      }),
      { persist: false, suppressBroadcast: true }
    );
    this.scheduleThrottledBroadcast();
  }

  private normalizeRuns(runs: AutomationRun[]): AutomationRun[] {
    if (!runs || runs.length === 0) {
      return runs;
    }
    let changed = false;
    const now = Date.now();
    const normalized = runs.map((run) => {
      if (!run || run.status !== 'running') {
        return run;
      }

      if (run.session) {
        const sessionResolved = Boolean(run.session.resolvedAt) || !run.session.isBusy || !run.session.activeTurnId;
        if (sessionResolved) {
          const completedAt = run.session.resolvedAt ?? run.completedAt ?? now;
          const hasError = Boolean(run.session.lastError);
          changed = true;
          return {
            ...run,
            status: hasError ? 'failure' : 'success',
            error: hasError ? run.session.lastError ?? run.error ?? null : null,
            completedAt,
            session: {
              ...run.session,
              isBusy: false,
              activeTurnId: null,
              resolvedAt: completedAt,
              lastError: run.session.lastError ?? (hasError ? run.session.lastError ?? run.error ?? null : null)
            }
          } satisfies AutomationRun;
        }
      }

      if (now - run.startedAt > STALLED_RUN_TIMEOUT_MS) {
        changed = true;
        const completedAt = run.completedAt ?? now;
        return {
          ...run,
          status: 'failure',
          error: run.error ?? 'Run did not complete within 30 minutes.',
          completedAt,
          session: run.session
            ? {
                ...run.session,
                isBusy: false,
                activeTurnId: null,
                resolvedAt: run.session.resolvedAt ?? completedAt,
                lastError: run.session.lastError ?? 'Run timed out before completion.'
              }
            : null
        } satisfies AutomationRun;
      }

      return run;
    });

    return changed ? normalized : runs;
  }

  /**
   * Stage 2C — provider-aware v26→v27 post-load pass.
   *
   * Plan-doc: `docs/plans/260514_openrouter_sonnet_bypass_remediation.md`
   * (Stage 2C, L565–595; iter-3 BLOCKER #2 at L392; case-(c) contract at L394).
   *
   * Fires only when this load's `fromVersion <= 26` — i.e. the migration map
   * just performed (or attempted) a v26→v27 transition. On later loads
   * (already at v27) this is a no-op.
   *
   * Behaviour matrix:
   * - No Source Capture record exists → no-op (no telemetry).
   * - All Source Capture records have a user-set `model` → no-op (no
   *   telemetry; iter-3 case (c): no migration event to report).
   * - Settings unavailable (`deps.getSettings?.()` undefined) → warn-log only,
   *   no mutation, no telemetry. The runtime fire-time helper will still
   *   route correctly when settings are wired later in the boot sequence.
   * - Flag OFF (default): telemetry emits with `mutationApplied: false`. The
   *   persisted record keeps its (often-empty) `model`; fire-time resolution
   *   provides the provider-correct default.
   * - Flag ON + `activeProvider === 'anthropic'`: mutate the candidate
   *   records to the helper-resolved Sonnet default; telemetry emits with
   *   `mutationApplied: true`.
   * - Flag ON + `activeProvider !== 'anthropic'`: hard guard — never mutate
   *   regardless of flag state. Telemetry emits with `mutationApplied: false`.
   *   The Stage 5 dashboard alert watches for `mutationApplied: true &&
   *   activeProvider !== 'anthropic'` and must fire if this guard is bypassed.
   *
   * @internal Exposed for unit tests via the module under test only.
   */
  private applyProviderAwareV26V27Pass(
    state: AutomationStoreState,
    fromVersion: number | null,
    options?: { flagOverrides?: MainFeatureFlagOverrides },
  ): AutomationStoreState {
    if (fromVersion === null || fromVersion === undefined || fromVersion > 26) {
      return state;
    }

    const sourceCaptureDefs = state.definitions.filter(
      (def) => def.isSystem && def.systemType === 'source-capture',
    );
    if (sourceCaptureDefs.length === 0) {
      return state;
    }

    const candidates = sourceCaptureDefs.filter((def) => !def.model);
    if (candidates.length === 0) {
      // Iter-3 case (c): every Source Capture record has a user-set model.
      // No migration event to report → emit NO telemetry, not even
      // `mutationApplied: false`. The Stage 5 dashboard alert would
      // otherwise misfire on every flag-ON load that encounters a
      // customized record.
      return state;
    }

    const settings = this.deps.getSettings?.();
    if (!settings) {
      log.warn(
        {
          fromVersion,
          automationCount: candidates.length,
        },
        'applyProviderAwareV26V27Pass: settings unavailable — skipping mutation and telemetry; runtime fire-time helper will resolve the active provider default',
      );
      return state;
    }

    const flagEnabled = isMainFlagEnabled(
      'enableV26V27ProviderMigration',
      options?.flagOverrides,
    );
    const rawProvider = settings.activeProvider;
    const activeProvider: 'anthropic' | 'openrouter' | 'codex' =
      rawProvider === 'openrouter' || rawProvider === 'codex'
        ? rawProvider
        : 'anthropic';

    let resolvedModel = '';
    let providerFallbackReason: 'helper-error' | null = null;
    try {
      resolvedModel = getDefaultModelForProvider(settings, 'background');
    } catch (err) {
      providerFallbackReason = 'helper-error';
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'getDefaultModelForProvider helper failed during v26→v27 provider-aware pass',
      );
    }

    const shouldMutate =
      flagEnabled && activeProvider === 'anthropic' && providerFallbackReason === null;

    let nextState = state;
    if (shouldMutate && resolvedModel.length > 0) {
      const nextDefinitions = state.definitions.map((def) => {
        if (def.isSystem && def.systemType === 'source-capture' && !def.model) {
          return { ...def, model: resolvedModel };
        }
        return def;
      });
      nextState = { ...state, definitions: nextDefinitions };
    }

    const telemetry: MigrationFallbackTelemetry = {
      event: 'provider.modelDefault.resolved',
      kind: 'settings',
      bootPhase: 'migration',
      site: 'automationScheduler:v26_to_v27',
      provider: activeProvider,
      role: 'background',
      resolvedModel: resolvedModel,
      credentialState: 'valid',
      providerFallbackReason,
      migration: 'v26_to_v27',
      mutationApplied: shouldMutate && resolvedModel.length > 0,
      defaultedTo: resolvedModel.length > 0 ? resolvedModel : null,
      activeProvider,
      automationCount: candidates.length,
      mutationFlagState: flagEnabled,
    };

    try {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: telemetry.event,
        properties: { ...telemetry },
      });
    } catch (err) {
      // Telemetry must never break boot. Log and continue.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to emit v26→v27 migration telemetry',
      );
    }

    return nextState;
  }

  private runEagerScheduleMigration(
    state: AutomationStoreState,
    sourceVersion: number | null,
  ): AutomationStoreState {
    if (this.isMigratingScheduleDefinitions) {
      return state;
    }

    this.isMigratingScheduleDefinitions = true;
    try {
      const existingQuarantined = [...state.quarantined];
      const existingQuarantineIds = new Set(
        existingQuarantined
          .map((entry) => extractDefinitionId(entry.definition))
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      );

      const migratedDefinitions: AutomationDefinition[] = [];
      let changed = false;

      for (const definition of state.definitions) {
        try {
          const migratedSchedule = ScheduleConstructors.fromUntrusted(definition.schedule, {
            source: 'store-load',
            existingCreatedAt: definition.createdAt,
            now: Date.now(),
          });

          if (!migratedSchedule.ok) {
            if (!existingQuarantineIds.has(definition.id)) {
              existingQuarantined.push({
                definition,
                reason: migratedSchedule.error.message,
                quarantinedAt: Date.now(),
                ...(sourceVersion !== null ? { sourceVersion } : {}),
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
            log.warn(
              {
                definitionId: definition.id,
                reason: 'repaired',
              },
              'Automation schedule migrated on load',
            );
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
              ...(sourceVersion !== null ? { sourceVersion } : {}),
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

      if (!changed) {
        return state;
      }

      return {
        ...state,
        definitions: migratedDefinitions,
        quarantined: existingQuarantined,
      };
    } finally {
      this.isMigratingScheduleDefinitions = false;
    }
  }

  initialize(): void {
    const state = this.stateSnapshot;
    state.definitions.forEach((definition) => {
      this.scheduleAutomation(definition);
    });
    log.info(
      {
        definitionCount: state.definitions.length,
        runCount: state.runs.length
      },
      'Automation scheduler initialized'
    );
    this.broadcast();
  }

  getState(): AutomationStoreState {
    return this.stateSnapshot;
  }

  getProviderReadinessSummary(): AutomationProviderReadinessSummary {
    const readiness = this.getProviderReadinessDecision();
    return summarizeProviderReadinessBlocks({
      readiness,
      runs: this.stateSnapshot.runs,
      definitions: this.stateSnapshot.definitions,
    });
  }

  /** Returns pre-v17 access rules snapshot (captured before migration stripped them). */
  getLegacyAccessRules(): Array<{ name: string; description?: string; accessRules?: string; accessRulesStatus?: string }> {
    return this.legacyAccessRulesSnapshot ?? [];
  }

  setSessionTypeFilter(filter: 'all' | 'conversations' | 'automations'): AutomationStoreState {
    log.info({ filter }, 'Session type filter updated');
    return this.updateState(
      (current) => ({
        ...current,
        sessionTypeFilter: filter
      }),
      { persist: true }
    );
  }

  private getProviderReadinessDecision(): ReturnType<typeof evaluateProviderReadinessRule> {
    const settings = this.deps.getSettings?.();
    if (!settings || !this.hasProviderReadinessInputs(settings)) {
      return { status: 'ready' };
    }

    let codexConnected = false;
    try {
      codexConnected = getCodexAuthProvider().isConnected();
    } catch (err) {
      log.debug({ err }, 'Codex auth provider unavailable while evaluating automation provider readiness');
    }

    const credentialState = validateProviderCredentials(settings, codexConnected);
    return evaluateProviderReadinessRule({ credentialState });
  }

  private getProviderCredentialStateSnapshot(): ProviderCredentialState | null {
    const settings = this.deps.getSettings?.();
    if (!settings || !this.hasProviderReadinessInputs(settings)) {
      return null;
    }

    let codexConnected = false;
    try {
      codexConnected = getCodexAuthProvider().isConnected();
    } catch (err) {
      log.debug({ err }, 'Codex auth provider unavailable while snapshotting provider credentials');
    }

    return validateProviderCredentials(settings, codexConnected);
  }

  private hasProviderReadinessInputs(settings: AppSettings): boolean {
    return Object.prototype.hasOwnProperty.call(settings, 'activeProvider')
      || Object.prototype.hasOwnProperty.call(settings, 'providerKeys')
      || Object.prototype.hasOwnProperty.call(settings, 'openRouter');
  }

  /**
   * Merge a slim delta produced by cloud's automation store into the desktop
   * automation state. Mirrors cloud-executed run history into the desktop UI
   * without overwriting local-mode `runs[]` (which a full `automation:state`
   * push would do).
   *
   * Intentionally does NOT touch timers or kick off rescheduling — cloud owns
   * scheduling for `executeIn: 'cloud'` automations. The desktop renderer
   * subscribers wake up via the broadcast emitted by `commitState`.
   *
   * See `docs-private/investigations/260515_cloud_automation_bugs.md` § BUG 1+11.
   */
  applyCloudDelta(delta: CloudAutomationDelta): void {
    const automationId = delta.automationId;
    const definitionExists = this.stateSnapshot.definitions.some((d) => d.id === automationId);
    if (!definitionExists) {
      log.debug({ automationId, deltaType: delta.type }, 'Ignoring cloud automation delta for unknown definition');
      return;
    }

    if (delta.type === 'automation-run-recorded') {
      const incomingRun = delta.run;
      const alreadyRecorded = this.stateSnapshot.runs.some((r) => r.id === incomingRun.id);
      this.updateState(
        (current) => {
          const definitions = current.definitions.map((d) => {
            if (d.id !== automationId) return d;
            const lastSuccessAt =
              delta.lastSuccessAt !== undefined ? delta.lastSuccessAt : d.lastSuccessAt;
            return {
              ...d,
              lastRunAt: delta.lastRunAt,
              lastRunStatus: delta.lastRunStatus,
              lastSuccessAt,
              updatedAt: Date.now(),
            } satisfies AutomationDefinition;
          });
          const runs = alreadyRecorded
            ? current.runs
            : clampRuns([incomingRun, ...current.runs]);
          return { ...current, definitions, runs };
        },
        { persist: true }
      );
      log.info(
        {
          automationId,
          runId: incomingRun.id,
          status: delta.lastRunStatus,
          appended: !alreadyRecorded,
        },
        'Mirrored cloud automation run into desktop state',
      );
      return;
    }

    if (delta.type === 'automation-next-run-updated') {
      this.updateState(
        (current) => {
          const definitions = current.definitions.map((d) => {
            if (d.id !== automationId) return d;
            if (d.nextRunAt === delta.nextRunAt) return d;
            return {
              ...d,
              nextRunAt: delta.nextRunAt,
              updatedAt: Date.now(),
            } satisfies AutomationDefinition;
          });
          return { ...current, definitions };
        },
        { persist: true }
      );
      log.debug(
        { automationId, nextRunAt: delta.nextRunAt },
        'Mirrored cloud automation nextRunAt into desktop state',
      );
      return;
    }
  }

  upsertDefinition(patch: AutomationDefinitionPatch): AutomationDefinition {
    const now = Date.now();
    const normalizedPatch = { ...patch } as AutomationDefinitionPatch;
    const patchRecord = patch as Record<string, unknown>;
    // R6 Stage 3: `AutomationDefinitionPatch.schedule` is branded-only.
    // Boundary callers (IPC handler, bundled bridge, plugin converter) run
    // `fromUntrusted` and produce `AutomationSchedule`; internal callers use
    // `AutomationSchedule.*` constructors. The brand makes the inner
    // `fromUntrusted` re-call demonstrably redundant, and the runtime
    // anchorDate backfill that lived here is unreachable from typed callers.
    const normalizedSchedule: AutomationSchedule | undefined = normalizedPatch.schedule;
    let existing = normalizedPatch.id
      ? this.stateSnapshot.definitions.find((definition) => definition.id === normalizedPatch.id)
      : undefined;

    if ('model' in patchRecord) {
      (normalizedPatch as AutomationDefinitionPatch & { model?: string }).model =
        normalizeAutomationModelOverride(patchRecord.model);
    }

    if ('thinkingModel' in patchRecord) {
      (normalizedPatch as AutomationDefinitionPatch & { thinkingModel?: string }).thinkingModel =
        normalizeAutomationModelOverride(patchRecord.thinkingModel);
    }

    if ('finishLine' in patchRecord) {
      normalizedPatch.finishLine = normalizeFinishLine(patchRecord.finishLine);
    }

    let definitions = [...this.stateSnapshot.definitions];
    let target: AutomationDefinition | null = null;
    let previousEnabledState: boolean | null = null;

    if (normalizedPatch.id) {
      const existingIndex = definitions.findIndex((def) => def.id === normalizedPatch.id);
      if (existingIndex !== -1) {
        existing = definitions[existingIndex];
        previousEnabledState = existing.enabled;
        target = {
          ...existing,
          ...normalizedPatch,
          ...(normalizedSchedule ? { schedule: normalizedSchedule } : {}),
          updatedAt: now
        } as AutomationDefinition;

        // When a user sets a filePath on a NON-LLM system automation (which originally
        // had no file), convert it to a custom automation. This ensures UI grouping,
        // analytics, and deferral reflect the automation's actual execution mode.
        // Note: after clearing, re-onboarding will create a fresh system automation.
        if (
          existing.isSystem &&
          existing.systemType &&
          NON_LLM_SYSTEM_TYPES.has(existing.systemType) &&
          !existing.filePath?.trim() &&
          normalizedPatch.filePath &&
          normalizedPatch.filePath.trim() !== ''
        ) {
          target.isSystem = undefined;
          target.systemType = undefined;
        }

        definitions[existingIndex] = target;
      }
    }

    if (!target) {
      if (!normalizedSchedule) {
        throw new Error('Schedule is required when creating a new automation.');
      }
      const id = normalizedPatch.id ?? randomUUID();
      const isHourly = normalizedSchedule.type === 'hourly';
      target = {
        id,
        name: normalizedPatch.name?.trim() || 'Untitled automation',
        description: normalizedPatch.description?.trim() || undefined,
        filePath: normalizedPatch.filePath ?? '',
        schedule: normalizedSchedule,
        enabled: normalizedPatch.enabled ?? true,
        catchUpIfMissed: normalizedPatch.catchUpIfMissed ?? (isHourly ? false : true),
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
        model: (normalizedPatch as AutomationDefinitionPatch & { model?: string }).model,
        thinkingModel: (normalizedPatch as AutomationDefinitionPatch & { thinkingModel?: string }).thinkingModel,
        finishLine: normalizeFinishLine(normalizedPatch.finishLine),
      } satisfies AutomationDefinition;
      definitions = [target, ...definitions];
    }

    if (!target) {
      throw new Error('Failed to resolve automation target during upsert.');
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

    // When switching to once or rescheduling a once-automation, reset run state.
    // Without this, inherited lastRunStatus from a prior schedule type (e.g. daily)
    // would cause calculateNextRunAt to return null and the once-automation never fires.
    if (target.schedule.type === 'once' && existing) {
      const existingSchedule = existing.schedule as { type: string; dateTime?: string };
      const newSchedule = normalizedSchedule as { type: string; dateTime?: string } | undefined;
      const switchingToOnce = existingSchedule.type !== 'once';
      const dateTimeChanged = existingSchedule.type === 'once' && newSchedule?.dateTime && newSchedule.dateTime !== existingSchedule.dateTime;
      if (switchingToOnce || dateTimeChanged) {
        target.lastRunAt = null;
        target.lastRunStatus = undefined;
        target.lastSuccessAt = null;
      }
    }

    target = normalizeLegacyAutomationDefinition(target);
    target.nextRunAt = this.calculateNextRunAt(target, Date.now());
    definitions = definitions.map((definition) => (definition.id === target?.id ? target : definition));

    // BLOCKER 4 (R6 Stage 2 refinement): when upserting a definition whose ID
    // matches an existing quarantine entry, atomically remove that quarantine
    // entry. Without this, renderer onboarding (`usePermissionsOrchestrator`)
    // — which finds quarantined system-default IDs and reuses them — would
    // create a live definition while the stale quarantine entry persists,
    // leaving the user with an orphaned envelope visible in the UI.
    const quarantinedAfterUpsert = this.stateSnapshot.quarantined.filter(
      (entry) => extractDefinitionId(entry.definition) !== target?.id,
    );

    this.commitState(
      {
        ...this.stateSnapshot,
        definitions,
        quarantined: quarantinedAfterUpsert,
      },
      { persist: true }
    );
    this.scheduleAutomation(target);

    // Track enabled/disabled state changes
    if (previousEnabledState !== null && previousEnabledState !== target.enabled) {
      const runCount = this.stateSnapshot.runs.filter((r) => r.automationId === target.id).length;
      if (target.enabled) {
        trackMainEvent({
          anonymousId: getOrGenerateAnonymousId(),
          event: 'Automation Enabled',
          properties: { automationId: target.id }
        });
      } else {
        trackMainEvent({
          anonymousId: getOrGenerateAnonymousId(),
          event: 'Automation Disabled',
          properties: { automationId: target.id, runCount }
        });
      }
    }

    return target;
  }

  deleteDefinition(id: string): AutomationStoreState {
    const current = this.stateSnapshot;
    const definitions = current.definitions.filter((def) => def.id !== id);
    const quarantined = current.quarantined.filter((entry) => extractDefinitionId(entry.definition) !== id);
    this.clearTimer(id);

    // Clean up staged items and tracker state for this automation
    clearAutomation(id);

    // Clean up pending session upsert timers for this automation
    this.cancelSessionUpsertTimersForAutomation(id);

    // Clean up staged tool calls for this automation's sessions
    const automationRuns = current.runs.filter((run) => run.automationId === id);
    for (const run of automationRuns) {
      if (run.sessionId) {
        clearSessionStagedCalls(run.sessionId);
      }
    }

    const runs = current.runs.filter((run) => run.automationId !== id);
    return this.commitState(
      {
        ...current,
        definitions,
        runs,
        quarantined,
      },
      { persist: true }
    );
  }

  async runNow(id: string, trigger: AutomationTrigger = 'manual'): Promise<AutomationRun | null> {
    const definition = this.stateSnapshot.definitions.find((def) => def.id === id);
    if (!definition) {
      log.warn({ automationId: id }, 'Run requested for missing automation');
      return null;
    }

    // Prevent concurrent runs of the same automation
    if (shouldSkipDueToActiveRun(this.isAutomationRunning(id))) {
      log.info({ automationId: id }, 'Automation already running, skipping duplicate run request');
      return null;
    }

    log.info({ automationId: id, trigger }, 'Automation run requested');
    return await this.executeAutomation(definition, trigger);
  }

  handleAppLaunch(): void {
    this.checkForMissedRuns('launch');
  }

  /**
   * Staggered version of handleAppLaunch that queues catch-ups for sequential execution.
   * Use this instead of handleAppLaunch() to avoid simultaneous automation runs at startup.
   * 
   * @param queueCatchUp Callback to queue each catch-up for staggered execution
   */
  handleAppLaunchStaggered(
    queueCatchUp: (automationId: string, execute: () => Promise<void>) => void
  ): void {
    this.checkForMissedRunsStaggered('launch', queueCatchUp);
  }

  /**
   * Check for missed runs but queue them for staggered execution instead of running immediately.
   */
  private checkForMissedRunsStaggered(
    context: 'launch' | 'resume',
    queueCatchUp: (automationId: string, execute: () => Promise<void>) => void
  ): void {
    const now = Date.now();
    const gracePeriodMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const newUserGracePeriodMs = 24 * 60 * 60 * 1000; // 1 day

    const settings = this.deps.getSettings?.();
    const onboardingCompletedAt = settings?.onboardingFirstCompletedAt;
    if (onboardingCompletedAt && (now - onboardingCompletedAt) < newUserGracePeriodMs) {
      log.info(
        { onboardingCompletedAt, onboardingAgeHours: Math.round((now - onboardingCompletedAt) / 3600000) },
        'Staggered catch-up skipped for all automations: new user grace period (< 24h since onboarding)'
      );
      return;
    }

    // Collect all automations that need catch-up
    const catchUps: Array<{ def: AutomationDefinition; shouldHaveRunAt: number }> = [];

    for (const def of this.stateSnapshot.definitions) {
      if (!def.enabled || def.catchUpIfMissed === false || shouldSkipDueToActiveRun(this.isAutomationRunning(def.id))) {
        continue;
      }
      // Once-automations that already ran successfully don't need catch-up
      if (def.schedule.type === 'once' &&
          (def.lastRunStatus === 'success' || def.lastRunStatus === 'completed_with_blocks')) {
        continue;
      }
      // Cloud-selected automations catch up on cloud when cloud is active
      if (def.executeIn === 'cloud' && this.isCloudActiveForScheduling()) {
        continue;
      }

      const shouldHaveRunAt = this.calculateMostRecentScheduledTime(def, now);
      if (!shouldHaveRunAt) continue;

      const lastRun = def.lastRunAt ?? 0;
      const missedRun = shouldHaveRunAt > lastRun;
      const missedBy = now - shouldHaveRunAt;
      const withinGrace = missedBy < gracePeriodMs;

      if (missedRun && withinGrace) {
        catchUps.push({ def, shouldHaveRunAt });
      }
    }

    if (catchUps.length === 0) {
      log.debug({ context }, 'No missed automations to catch up');
      return;
    }

    // Sort by shouldHaveRunAt (oldest first) to maintain temporal order
    catchUps.sort((a, b) => a.shouldHaveRunAt - b.shouldHaveRunAt);

    log.info(
      { context, count: catchUps.length, automations: catchUps.map(c => c.def.name) },
      'Queueing staggered automation catch-ups'
    );

    for (const { def, shouldHaveRunAt } of catchUps) {
      const automationId = def.id;
      queueCatchUp(automationId, async () => {
        // Re-check state at execution time (user may have disabled or run manually since queue time)
        const currentDef = this.stateSnapshot.definitions.find(d => d.id === automationId);
        if (!currentDef) {
          log.debug({ automationId }, 'Staggered catch-up skipped: automation no longer exists');
          return;
        }
        if (!currentDef.enabled) {
          log.debug({ automationId }, 'Staggered catch-up skipped: automation disabled');
          return;
        }
        if (shouldSkipDueToActiveRun(this.isAutomationRunning(automationId))) {
          log.debug({ automationId }, 'Staggered catch-up skipped: automation already running');
          return;
        }
        // Check if it's still missed (user may have run it manually)
        const currentLastRun = currentDef.lastRunAt ?? 0;
        if (shouldHaveRunAt <= currentLastRun) {
          log.debug({ automationId, shouldHaveRunAt, currentLastRun }, 'Staggered catch-up skipped: already ran');
          return;
        }

        log.info(
          {
            automationId,
            automationName: currentDef.name,
            shouldHaveRunAt: new Date(shouldHaveRunAt).toISOString(),
            context
          },
          'Executing staggered catch-up'
        );
        await this.executeAutomation(currentDef, 'catch-up');
      });
    }
  }

  /**
   * Trigger automations that match a specific event type.
   * Used for event-driven automations (e.g., transcript-ready).
   *
   * @param eventType The event type that occurred
   * @param context Optional context data to inject into the automation prompt
   * @returns Array of automation runs that were triggered
   */
  async triggerByEvent(
    eventType: AutomationEventType,
    context?: Record<string, unknown>
  ): Promise<AutomationRun[]> {
    const runs: AutomationRun[] = [];

    // Find all enabled event-triggered automations matching this event type
    // (cloud-selected automations are excluded only when cloud is active — cloud has no event sources in Phase B)
    const matching = this.stateSnapshot.definitions.filter((def) => {
      if (!def.enabled) return false;
      if (def.executeIn === 'cloud' && this.isCloudActiveForScheduling()) return false;
      if (def.schedule.type !== 'event') return false;

      const scheduleEventType = def.schedule.eventType;
      if (!scheduleEventType) return false;

      // Match exact event type or parent type
      // e.g., 'transcript-ready' matches 'transcript-ready', 'transcript-ready:rebel', 'transcript-ready:external'
      if (scheduleEventType === eventType) return true;
      if (eventType.startsWith(scheduleEventType + ':')) return true;
      // e.g., 'transcript-ready:rebel' also matches 'transcript-ready'
      if (scheduleEventType.startsWith(eventType + ':')) return false; // More specific doesn't match less specific
      if (eventType.split(':')[0] === scheduleEventType) return true;

      return false;
    });

    if (matching.length === 0) {
      log.debug({ eventType }, 'No automations configured for event type');
      return runs;
    }

    // Log only context keys to avoid PII exposure (participants, meeting titles, file paths)
    log.info(
      { eventType, matchCount: matching.length, contextKeys: Object.keys(context ?? {}) },
      'Triggering event-based automations'
    );

    for (const def of matching) {
      // Prevent concurrent runs of the same automation
      if (shouldSkipDueToActiveRun(this.isAutomationRunning(def.id))) {
        log.info(
          { automationId: def.id, eventType },
          'Automation already running, skipping event trigger'
        );
        continue;
      }

      const run = await this.executeAutomation(def, 'event', context);
      if (run) {
        runs.push(run);
      }
    }

    return runs;
  }

  /**
   * Wait for any active interactive (conversation) turn to finish before
   * starting an LLM automation. Avoids two agent processes competing
   * for CPU, network, and memory simultaneously.
   *
   * Uses a cumulative deadline so back-to-back user turns don't reset the timer.
   */
  private async waitForInteractiveIdle(
    automationId: string
  ): Promise<{ deferred: boolean; deferredMs: number; timedOut: boolean; shuttingDown: boolean }> {
    const MAX_DEFERRAL_MS = 5 * 60 * 1000; // 5 minutes cumulative cap
    const POLL_INTERVAL_MS = 2000;
    const GRACE_MS = 5000;

    const start = Date.now();
    const deadline = start + MAX_DEFERRAL_MS;

    log.info({ automationId }, 'Deferring automation: interactive turn in progress');

    // Outer loop: wait for interactive turn to clear, then grace period
    while (agentTurnRegistry.hasInteractiveTurn() && Date.now() < deadline && !isShuttingDown()) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (isShuttingDown()) {
      return { deferred: true, deferredMs: Date.now() - start, timedOut: false, shuttingDown: true };
    }

    if (Date.now() >= deadline) {
      const deferredMs = Date.now() - start;
      log.warn({ automationId, deferredMs }, 'Automation deferral timed out, proceeding anyway');
      return { deferred: true, deferredMs, timedOut: true, shuttingDown: false };
    }

    // Grace period: wait a few seconds in case user starts a new turn
    await new Promise((resolve) => setTimeout(resolve, GRACE_MS));

    // Re-check after grace: if new interactive turn started and deadline not exceeded, keep waiting
    while (agentTurnRegistry.hasInteractiveTurn() && Date.now() < deadline && !isShuttingDown()) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      if (isShuttingDown()) {
        return { deferred: true, deferredMs: Date.now() - start, timedOut: false, shuttingDown: true };
      }

      if (!agentTurnRegistry.hasInteractiveTurn()) {
        // Another grace period before proceeding
        await new Promise((resolve) => setTimeout(resolve, GRACE_MS));
      }
    }

    if (isShuttingDown()) {
      return { deferred: true, deferredMs: Date.now() - start, timedOut: false, shuttingDown: true };
    }

    const deferredMs = Date.now() - start;
    const timedOut = Date.now() >= deadline;

    if (timedOut) {
      log.warn({ automationId, deferredMs }, 'Automation deferral timed out, proceeding anyway');
    } else {
      log.info({ automationId, deferredMs }, 'Interactive turn cleared, resuming automation');
    }

    return { deferred: true, deferredMs, timedOut, shuttingDown: false };
  }

  private persistAdmissionBlockedRun(args: {
    automationId: string;
    trigger: AutomationTrigger;
    executor?: 'llm' | 'script';
    admissionBlock: AutomationAdmissionBlock;
    advanceScheduleSlot: boolean;
  }): AutomationRun {
    const now = Date.now();
    const { admissionBlock } = args;
    const runStatus: AutomationRunStatus = admissionBlock.source === 'provider-readiness'
      ? 'provider_not_ready'
      : 'failure';
    return this.persistRun(args.automationId, randomUUID(), {
      status: runStatus,
      error: admissionBlock.message,
      session: null,
      startedAt: now,
      completedAt: now,
      trigger: args.trigger,
      executor: args.executor,
      admissionBlock,
      errorKind: admissionBlock.errorKind,
      headlineClass: admissionBlock.headlineClass,
      advanceScheduleSlot: args.advanceScheduleSlot,
    });
  }

  private shouldDeferForRecordedResetWindow(args: {
    automationId: string;
    trigger: AutomationTrigger;
    credentialState: ProviderCredentialState | null;
  }): { shouldDefer: boolean; resetAtMs?: number; remainingMs?: number } {
    if (args.trigger !== 'schedule' && args.trigger !== 'catch-up') {
      return { shouldDefer: false };
    }

    // Spawn-time re-evaluation against current provider state intentionally means
    // switching away from Codex naturally cancels this deferral.
    if (!args.credentialState || args.credentialState.kind !== 'codex' || args.credentialState.status !== 'connected') {
      return { shouldDefer: false };
    }

    const latestRun = this.stateSnapshot.runs.find((run) => run.automationId === args.automationId);
    if (!latestRun) {
      return { shouldDefer: false };
    }

    if (
      latestRun.errorKind !== 'rate_limit'
      || latestRun.limitScope !== 'plan'
      || latestRun.credentialSource !== 'codex-subscription'
    ) {
      return { shouldDefer: false };
    }

    const resetAtMs = latestRun.rateLimitResetAtMs;
    if (typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs)) {
      return { shouldDefer: false };
    }

    const remainingMs = resetAtMs - Date.now();
    if (remainingMs <= 0) {
      return { shouldDefer: false };
    }

    return { shouldDefer: true, resetAtMs, remainingMs };
  }

  private async executeAutomation(
    automation: AutomationDefinition,
    trigger: AutomationTrigger,
    eventContext?: Record<string, unknown>
  ): Promise<AutomationRun | null> {
    // Don't auto-run automations until onboarding is complete. A fresh install seeds
    // default automations (Morning Triage, Weekly Prep, …) and schedules them before
    // any API key exists, so an immediate catch-up/scheduled run would just create
    // errored "Authentication is missing" sessions in a brand-new profile. Manual runs
    // (explicit user action) always proceed; automatic triggers wait for the next
    // occurrence after onboarding flips `onboardingCompleted` to true.
    // Missing settings (no deps) reads as "not onboarded" — err toward not running.
    // Scope: this gates the DESKTOP scheduler only. Cloud-side execution
    // (cloudAutomationScheduler) is a separate surface, but the seeded defaults run
    // local (system/event automations are forced local) and a pre-onboarding user has
    // no user-created cloud automations, so the fresh-install case is fully covered here.
    if (trigger !== 'manual' && this.deps.getSettings?.()?.onboardingCompleted !== true) {
      log.info({ automationId: automation.id, trigger }, 'Skipping automation — onboarding not complete');
      if (automation.schedule.type !== 'event') {
        this.scheduleAutomation(automation);
      }
      return null;
    }

    // Cloud-selected automations run on cloud only when cloud is active.
    // Exception: manual runNow always executes locally (explicit user action from desktop UI).
    if (automation.executeIn === 'cloud' && trigger !== 'manual') {
      if (this.isCloudActiveForScheduling()) {
        log.debug({ automationId: automation.id, trigger }, 'Skipping execution — cloud is active and will handle this automation');
        // Reschedule so desktop keeps its safety-net timer for the next occurrence.
        // Without this, the timer fires once, gets eaten by the cloud skip, and desktop
        // loses its fallback timer (the finally block below only runs after full execution).
        if (automation.schedule.type !== 'event') {
          this.scheduleAutomation(automation);
        }
        return null;
      }
      log.info({ automationId: automation.id, trigger }, 'Cloud unavailable — executing cloud-selected automation locally as fallback');
    }

    const credentialStateSnapshot = this.getProviderCredentialStateSnapshot();
    if ((trigger === 'schedule' || trigger === 'catch-up') && isProviderReadinessEligibleAutomation(automation)) {
      const providerReadiness =
        credentialStateSnapshot == null
          ? ({ status: 'ready' } as const)
          : evaluateProviderReadinessRule({ credentialState: credentialStateSnapshot });
      if (providerReadiness.status === 'blocked') {
        const shouldAdvanceScheduleSlot = automation.schedule.type !== 'once';
        log.info(
          {
            automationId: automation.id,
            trigger,
            blockCode: providerReadiness.reason.code,
            provider: providerReadiness.reason.provider,
            advanceScheduleSlot: shouldAdvanceScheduleSlot,
          },
          'Skipping automation spawn — provider readiness gate blocked scheduling',
        );
        const blockedRun = this.persistAdmissionBlockedRun({
          automationId: automation.id,
          trigger,
          executor: this.getAnalyticsExecutor(automation),
          admissionBlock: providerReadiness.reason,
          // Keep once schedules retryable after reconnect. Recurring schedules
          // still advance normally so launch/resume catch-up does not re-fire
          // the same blocked occurrence repeatedly.
          advanceScheduleSlot: shouldAdvanceScheduleSlot,
        });
        if (automation.schedule.type !== 'event' && automation.schedule.type !== 'once') {
          const updatedDefinition = this.stateSnapshot.definitions.find((def) => def.id === automation.id) ?? automation;
          this.scheduleAutomation(updatedDefinition);
        }
        return blockedRun;
      }

      const resetWindowDeferral = this.shouldDeferForRecordedResetWindow({
        automationId: automation.id,
        trigger,
        credentialState: credentialStateSnapshot,
      });
      if (resetWindowDeferral.shouldDefer) {
        log.info(
          {
            automationId: automation.id,
            trigger,
            resetAtMs: resetWindowDeferral.resetAtMs,
            remainingMs: Math.round(resetWindowDeferral.remainingMs ?? 0),
          },
          'Skipping scheduled automation spawn until recorded subscription reset window elapses',
        );
        if (automation.schedule.type !== 'event') {
          this.scheduleAutomation(automation);
        }
        return null;
      }
    }

    const rateLimitDecision = evaluateRateLimitCooldownRule({
      isAvailable: apiRateLimitCooldown.isAvailable(),
      remainingMs: apiRateLimitCooldown.remainingMs(),
    });
    if (trigger !== 'manual' && rateLimitDecision.shouldDefer) {
      if (trigger === 'schedule' || trigger === 'catch-up') {
        this.deferAutomationToRetrySameOccurrence({
          automation,
          trigger,
          delayMs: rateLimitDecision.deferMs,
          reason: rateLimitDecision.reason ?? 'API rate-limit cooldown active',
        });
        return null;
      }

      log.info({ automationId: automation.id }, 'API rate-limit cooldown active — skipping automation');
      return null;
    }

    // Skip deferral for: manual runs (user explicitly requested), event triggers (time-sensitive),
    // and most non-LLM system automations without a custom filePath (lightweight, no agent runtime process).
    // Chief-of-Staff hygiene is also non-LLM, but it reads memory files and should wait
    // for active interactive turns before checking the always-loaded README.
    const shouldDefer = trigger !== 'manual' && trigger !== 'event'
      && !(automation.isSystem
        && automation.systemType
        && NON_LLM_SYSTEM_TYPES.has(automation.systemType)
        && automation.systemType !== 'chief-of-staff-hygiene'
        && !automation.filePath?.trim());

    if (shouldDefer && agentTurnRegistry.hasInteractiveTurn()) {
      const result = await waitForInteractiveTurnToSettle({
        hasInteractiveTurn: () => agentTurnRegistry.hasInteractiveTurn(),
        isShuttingDown,
        scheduler: this.scheduler,
        waitForVisible: true,
      });
      if (result.shuttingDown) {
        log.info({ automationId: automation.id }, 'Automation skipped due to app shutdown during deferral');
        return null;
      }
      // Re-validate: automation may have been disabled/deleted or started by another trigger during wait
      const currentDef = this.stateSnapshot.definitions.find(d => d.id === automation.id);
      if (!currentDef || !currentDef.enabled) {
        log.info({ automationId: automation.id, deferredMs: result.deferredMs }, 'Automation disabled during deferral, skipping');
        return null;
      }
      if (shouldSkipDueToActiveRun(this.isAutomationRunning(automation.id))) {
        log.info({ automationId: automation.id, deferredMs: result.deferredMs }, 'Automation already running after deferral, skipping');
        return null;
      }
    }

    // Skip system automations on day 1 of onboarding - user is still learning the product
    if (automation.isSystem && this.deps.getSettings) {
      const settings = this.deps.getSettings();
      const completedAt = settings.onboardingFirstCompletedAt ?? settings.onboardingCompletedAt;
      if (completedAt) {
        // Calculate day dynamically from completion timestamp
        const completedDate = new Date(completedAt);
        const today = new Date();
        completedDate.setHours(0, 0, 0, 0);
        today.setHours(0, 0, 0, 0);
        const msPerDay = 24 * 60 * 60 * 1000;
        const daysSinceCompletion = Math.floor((today.getTime() - completedDate.getTime()) / msPerDay);
        const onboardingDay = daysSinceCompletion + 1;
        
        if (onboardingDay === 1) {
          log.info(
            { automationId: automation.id, trigger },
            'Skipping system automation on onboarding day 1'
          );
          return null;
        }
      }
    }

    // Belt-and-suspenders: skip calendar-sync automation when useOtherCalendarProvider is off.
    // Returns null (no run persisted) to avoid advancing lastRunAt and suppressing future catch-ups.
    if (automation.isSystem && automation.systemType === 'calendar-sync' && this.deps.getSettings) {
      const settings = this.deps.getSettings();
      if (!settings.calendar?.useOtherCalendarProvider) {
        log.warn(
          { automationId: automation.id, trigger },
          'Calendar sync automation triggered but useOtherCalendarProvider is off — disabling and skipping'
        );
        this.setCalendarSyncAutomationEnabled(false);
        return null;
      }
    }

    const executor = this.getAnalyticsExecutor(automation);
    const runId = randomUUID();
    const startedAt = Date.now();
    log.info({ automationId: automation.id, runId, trigger }, 'Automation execution started');
    try {
      const result = await this.runAutomationPipeline(automation, trigger, runId, eventContext);
      log.info({ automationId: automation.id, runId }, 'Automation pipeline completed');
      return this.persistRun(automation.id, runId, {
        ...result,
        trigger,
        executor,
      });
    } catch (error) {
      log.error({ err: error, automationId: automation.id }, 'Automation execution failed');
      return this.persistRun(automation.id, runId, {
        status: 'failure',
        error: error instanceof Error ? error.message : String(error),
        session: null,
        startedAt,
        completedAt: Date.now(),
        trigger,
        executor,
      });
    } finally {
      // Re-fetch definition to avoid rescheduling stale/deleted/disabled automations
      const currentDefinition = this.stateSnapshot.definitions.find(d => d.id === automation.id);
      if (currentDefinition && currentDefinition.schedule.type !== 'event') {
        // Only reschedule time-based automations, not event-triggered ones
        this.scheduleAutomation(currentDefinition);
        log.info({ automationId: automation.id, runId }, 'Automation rescheduled after run');
      } else if (currentDefinition?.schedule.type === 'event') {
        log.info({ automationId: automation.id, runId }, 'Event-triggered automation completed');
      }
    }
  }

  private async runAutomationPipeline(
    automation: AutomationDefinition,
    trigger: AutomationTrigger,
    runId: string,
    eventContext?: Record<string, unknown>
  ): Promise<AutomationExecutionResult> {
    if (automation.executor !== undefined && automation.executor !== 'llm' && automation.executor !== 'script') {
      log.warn({ automationId: automation.id, executor: automation.executor }, 'Unknown executor; failing closed');
      const startedAt = Date.now();
      return {
        status: 'failure',
        error: `Unknown executor: ${String(automation.executor)}`,
        session: null,
        messages: [],
        eventsByTurn: {},
        startedAt,
        completedAt: startedAt,
      };
    }

    // Handle system automations with special execution paths.
    // If the automation has a non-empty filePath (user customized it), skip the
    // non-LLM pipelines and fall through to file-based execution.
    if (!automation.filePath?.trim()) {
      if (automation.isSystem && automation.systemType === 'use-case-refresh') {
        return this.runUseCaseRefreshPipeline(automation, runId);
      }
      if (automation.isSystem && automation.systemType === 'community-highlights') {
        return this.runCommunityHighlightsPipeline(automation, runId);
      }
      if (automation.isSystem && automation.systemType === 'calendar-sync') {
        return this.runCalendarSyncPipeline(automation, runId);
      }
      if (automation.isSystem && automation.systemType === 'community-video-recs') {
        return this.runCommunityVideoRecsPipeline(automation, runId);
      }
      if (automation.isSystem && automation.systemType === 'space-maintenance') {
        return this.runSpaceMaintenancePipeline(automation, runId);
      }
      if (automation.isSystem && automation.systemType === 'chief-of-staff-hygiene') {
        return this.runChiefOfStaffHygienePipeline(automation, runId);
      }
    }

    if (automation.executor === 'script') {
      return await this.runScriptAutomationPipeline(automation, trigger, runId);
    }

    const coreDirectory = this.deps.getCoreDirectory();
    if (!coreDirectory) {
      throw new Error('Workspace directory is not configured.');
    }

    const { resolved, root, fileContent } = await this.resolveAutomationFile(automation, coreDirectory);

    // Enrich Focus automations with pre-computed structured data
    let targetPeriodStart: number | undefined;
    let enrichedContext = eventContext;
    if (automation.isSystem &&
        (automation.systemType === 'focus-weekly-prep' || automation.systemType === 'focus-monthly-review')) {
      const focusContext = await buildFocusAutomationContext(automation.systemType);
      targetPeriodStart = focusContext.targetPeriodStart;
      enrichedContext = { ...eventContext, focusData: focusContext.focusData };
    }

    const prompt = this.buildAutomationPrompt(fileContent, automation, enrichedContext);

    const startedAt = Date.now();
    // Use prefixed session ID so costs are categorized as 'automation' by agentTurnExecutor
    // Format: automation-{type}--{uuid} where type is systemType (for system automations) or id
    const automationType = automation.systemType ?? automation.id;
    const sessionId = `automation-${automationType}--${randomUUID()}`;
    const turnId = randomUUID();
    const relativePath = relativePortablePath(root, resolved);
    const userMessage: AgentTurnMessage = {
      id: createId(),
      role: 'user',
      turnId,
      text: prompt,
      createdAt: startedAt,
      attachments: [
        {
          id: createId(),
          name: path.basename(resolved),
          path: resolved,
          relativePath,
          size: fileContent.length
        }
      ]
    };

    let state: ConversationStateShape = {
      messages: [],
      eventsByTurn: {},
      activeTurnId: turnId,
      focusedTurnId: null,
      isBusy: true,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    };
    let status: AutomationRunStatus = 'pending';
    let errorMessage: string | null = null;

    const composeSessionSnapshot = (
      conversation: ConversationStateShape,
      completedAt: number | null
    ): { session: AgentSession; messages: AgentTurnMessage[] } => {
      const messages: AgentTurnMessage[] = [userMessage, ...conversation.messages];
      const updatedAt = deriveInteractionTimestamp(messages, completedAt ?? Date.now());
      const session: AgentSession = {
        id: sessionId,
        title: automation.name,
        createdAt: startedAt,
        updatedAt,
        messages,
        eventsByTurn: conversation.eventsByTurn,
        activeTurnId: conversation.activeTurnId,
        isBusy: conversation.isBusy,
        lastError: conversation.lastError,
        resolvedAt: completedAt,
        origin: 'automation',
        automationId: automation.id,
        automationRunId: runId
      };
      return { session, messages };
    };

    const stageSnapshot = (runStatus: AutomationRunStatus, completedAt: number | null = null) => {
      const { session, messages } = composeSessionSnapshot(state, completedAt);

      // Finalize session fields for terminal statuses so every persist is self-consistent.
      // Without this, the session could be persisted with isBusy=true / activeTurnId set
      // even though the run has finished, causing the conversation UI to show "in progress".
      if (TERMINAL_RUN_STATUSES.has(runStatus)) {
        session.activeTurnId = null;
        session.isBusy = false;
        session.resolvedAt = session.resolvedAt ?? completedAt;
        session.lastError = errorMessage;
      }
      
      // Persist to incremental session store so "View conversation" works.
      // Debounced: first write is immediate, subsequent intermediate writes are
      // batched to reduce disk I/O. Terminal writes are always immediate.
      this.debouncedSessionUpsert(session.id, session, TERMINAL_RUN_STATUSES.has(runStatus));
      
      this.stageRunSnapshot({
        id: runId,
        automationId: automation.id,
        startedAt,
        completedAt,
        status: runStatus,
        trigger,
        sessionId,
        error: state.lastError,
        eventsByTurn: state.eventsByTurn,
        messages,
        session,
        ...(targetPeriodStart != null ? { targetPeriodStart } : {}),
      });
    };

    let stoppedByUser = false;
    let lastErrorEvent: Extract<AgentEvent, { type: 'error' }> | null = null;
    let lastErrorKind: Extract<AgentEvent, { type: 'error' }>['errorKind'];
    let lastLimitScope: Extract<AgentEvent, { type: 'error' }>['limitScope'];
    let lastCredentialSource: Extract<AgentEvent, { type: 'error' }>['credentialSource'];
    let lastHeadlineClass: Extract<AgentEvent, { type: 'error' }>['headlineClass'];
    let lastRawError: string | undefined;
    let lastRateLimitResetAtMs: number | undefined;
    // Captured from the latest `result` event so we can classify all-tool-failure
    // AFTER security denial reconciliation (below). Doing the check in onEvent
    // would race with security reconciliation and misclassify blocked runs.
    let lastToolMetrics: { totalToolCalls: number; failedToolCalls: number } | undefined;

    const onEvent = (event: AgentEvent) => {
      // Sanitize events to prevent OOM from large tool outputs in automation state
      const sanitizedEvent = sanitizeEventForMainAccumulation(event);
      // Stage 2: thinking_delta is transient (manifest persistence.mainAccumulator:false);
      // don't fold it into the persisted automation conversation state. It derives no
      // message/liveness state and at high reasoning volume dominates persisted eventsByTurn.
      // (This automation path is what produced the original 44k-thinking_delta session.)
      if (event.type !== 'thinking_delta') {
        state = updateConversationWithEvent(state, turnId, sanitizedEvent);
      }
      if (event.type === 'status' && event.message?.toLowerCase().includes('stopped by user')) {
        stoppedByUser = true;
      } else if (event.type === 'result') {
        if (event.toolMetrics) {
          lastToolMetrics = {
            totalToolCalls: event.toolMetrics.totalToolCalls,
            failedToolCalls: event.toolMetrics.failedToolCalls,
          };
        }
        // Don't overwrite a prior failure from an `error` event. Turn recovery
        // (turnErrorRecovery.ts) dispatches `error` THEN a synthetic `result('error')`,
        // which without this guard silently turns failures back into success.
        if (status !== 'failure') {
          status = stoppedByUser ? 'cancelled' : 'success';
          if (stoppedByUser) {
            errorMessage = 'Automation was stopped by user before completion';
          } else {
            errorMessage = null;
          }
        }
      } else if (event.type === 'error') {
        status = 'failure';
        errorMessage = event.error;
        lastErrorEvent = event;
        lastErrorKind = event.errorKind;
        lastLimitScope = event.limitScope;
        lastCredentialSource = event.credentialSource;
        lastHeadlineClass = event.headlineClass;
        lastRawError = event.rawError;
        lastRateLimitResetAtMs = event.rateLimitMeta?.resetAtMs;
      }
      const snapshotStatus = status === 'pending' ? 'running' : status;
      stageSnapshot(snapshotStatus);
    };

    // Clear any stale tracker state from a previous run to prevent cross-run item mixing
    clearAutomation(automation.id);

    // Stage 2C — Source Capture provider-aware fire-time resolution.
    // Plan-doc: docs/plans/260514_openrouter_sonnet_bypass_remediation.md (L583).
    //
    // The fresh-install default (createDefaultAutomationState) and the
    // post-v26 migration both leave Source Capture's `model` unset. Resolving
    // here at fire-time guarantees the active provider's helper-resolved
    // background default is used — bypass-proof for OpenRouter / Codex users.
    // Other automations are unchanged: an unset `model` continues to mean
    // "inherit global settings" so the agent turn executor resolves it.
    let resolvedSourceCaptureModel: string | undefined;
    if (
      automation.isSystem &&
      automation.systemType === 'source-capture' &&
      !automation.model
    ) {
      const settings = this.deps.getSettings?.();
      if (settings) {
        try {
          resolvedSourceCaptureModel = getDefaultModelForProvider(settings, 'background');
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err), automationId: automation.id },
            'Source Capture fire-time helper failed — falling back to inherited global settings',
          );
        }
      }
    }

    const effectiveModel = automation.model ?? resolvedSourceCaptureModel;
    const hasModelOverride = !!effectiveModel;
    const hasThinkingOverride = !!automation.thinkingModel;
    // Derive model overrides:
    // - model only → single-model mode (suppress thinking via empty string)
    // - both → split mode with custom models
    // - thinkingModel only → keep global working model, override thinking
    // - neither → inherit global settings
    const modelOverrides: { modelOverride?: string; thinkingModelOverride?: string } =
      hasModelOverride && !hasThinkingOverride
        ? { modelOverride: effectiveModel, thinkingModelOverride: '' }
        : hasModelOverride && hasThinkingOverride
          ? { modelOverride: effectiveModel, thinkingModelOverride: automation.thinkingModel }
          : hasThinkingOverride
            ? { thinkingModelOverride: automation.thinkingModel }
            : {};

    await seedAutomationSessionFinishLine(sessionId, automation);

    stageSnapshot('running');
    await this.deps.executeAgentTurn(turnId, prompt, {
      sessionId,
      onEvent,
      ...modelOverrides,
    });

    const completedAt = Date.now();
    if (status === 'pending') {
      status = errorMessage ? 'failure' : 'success';
    }

    // Check for security denials and classify the final status:
    // - success + denials → completed_with_blocks (succeeded but some tools were denied)
    // - failure + circuit breaker denial → blocked_by_security (halted by safety circuit breaker)
    // - failure + other denials → stays 'failure' (failed for non-security reasons;
    //   denials are recorded in blockedActions for visibility and still trigger update_suggested)
    const securityDenials = agentTurnRegistry.getSecurityDenials(turnId);
    let blockedActions: import('@shared/types').BlockedAction[] | undefined;
    if (securityDenials.length > 0) {
      log.info(
        { turnId, denialCount: securityDenials.length, denials: securityDenials },
        'Security denials recorded during automation'
      );
      if (status === 'success') {
        status = 'completed_with_blocks';
      } else if (securityDenials.some((d) => d.reason?.startsWith(CIRCUIT_BREAKER_DENIAL_PREFIX))) {
        status = 'blocked_by_security';
      }
      blockedActions = securityDenials.map((d) => ({
        toolId: d.toolName,
        toolName: d.toolName,
        reason: d.reason,
        timestamp: d.timestamp,
      }));

      // Safety Prompt replaces per-automation access rules. Blocks were staged for user
      // approval via the staging flow (MCP staging, deny-then-retry, or CoS pending).
      // Register a simplified callback for when all staged items are resolved.
      const hasCircuitBreakerDenial = securityDenials.some((d) =>
        d.reason?.startsWith(CIRCUIT_BREAKER_DENIAL_PREFIX)
      );
      if (!hasCircuitBreakerDenial) {
        onAllResolved(automation.id, (result) => {
          log.info(
            { automationId: automation.id, approved: result.approved.length, rejected: result.rejected.length },
            'All staged items resolved for automation run'
          );
          if (result.rejected.length === 0 && result.approved.length > 0) {
            this.upgradeRunStatusAfterApproval(automation.id, runId);
          }
        });
        markRunComplete(automation.id);
      }

      agentTurnRegistry.clearSecurityDenials(turnId);
    }

    // Classify runs where every tool call failed as `failure`, not `success`.
    // Runs AFTER security denial reconciliation so `blocked_by_security` and
    // `completed_with_blocks` take precedence. Runs after the `onEvent` loop so
    // `cancelled` (stoppedByUser) takes precedence. Only triggers when status
    // is still 'success' — any upgraded/failed status is preserved.
    //
    // Fixes the root cause of REBEL-1BK where validator-stripped parameters
    // (e.g., `maxResults` vs `max_results`) caused 100% tool-call failure but
    // the automation was marked successful because the agent turn completed
    // without throwing.
    if (
      status === 'success' &&
      lastToolMetrics &&
      lastToolMetrics.totalToolCalls > 0 &&
      lastToolMetrics.failedToolCalls === lastToolMetrics.totalToolCalls
    ) {
      status = 'failure';
      errorMessage =
        lastToolMetrics.failedToolCalls === 1
          ? "The automation couldn't complete — its only tool call failed."
          : `The automation couldn't complete — all ${lastToolMetrics.failedToolCalls} tool calls failed.`;
      log.warn(
        {
          automationId: automation.id,
          runId,
          sessionId,
          failedToolCalls: lastToolMetrics.failedToolCalls,
          totalToolCalls: lastToolMetrics.totalToolCalls,
        },
        'Automation classified as failure: all tool calls failed',
      );
      // Sentry capture so ops can alert on this pattern (breadcrumbs aren't
      // enough for alert rules — a message creates an issue).
      try {
        getErrorReporter().captureMessage(
          'Automation classified as failure: all tool calls failed',
          {
            level: 'warning',
            tags: {
              classification: 'automation_all_tools_failed',
              automationId: automation.id,
            },
            extra: {
              runId,
              sessionId,
              failedToolCalls: lastToolMetrics.failedToolCalls,
              totalToolCalls: lastToolMetrics.totalToolCalls,
            },
          },
        );
      } catch (err) {
        log.debug({ err }, 'Failed to capture automation failure message to Sentry');
      }
    }

    // Fire OS notification with the final reconciled status. Scheduler owns
    // automation notifications (not the dispatcher) because only the scheduler
    // sees the authoritative post-reconciliation status. Fire-and-forget.
    fireAndForget(showAutomationOutcomeNotification({
      status,
      errorMessage,
      sessionId,
    }), 'automationScheduler.line3099');

    stageSnapshot(status, completedAt);
    // Dispatch terminal event to renderer so UI updates busy state.
    // Automations run with win: null, so dispatchAgentEvent alone won't reach the renderer —
    // we must broadcast via sendToAllWindows for the renderer to clear the conversation's busy state.
    // This must be done AFTER the final stageSnapshot call to ensure session state is persisted.
    const broadcastTerminalEvent = (event: AgentEvent) => {
      const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId, sessionId);
      let broadcastEvent: SequencedAgentEvent;

      if (event.type === 'error') {
        // Forward the original event timestamp via timestampOverride so the
        // helper-constructed event, the Posthog 'ai_error_shown' payload, and
        // the renderer broadcast below all agree on when the terminal error
        // occurred. Without this, the helper would stamp Date.now() at replay
        // time while sendToAllWindows below forwards the original timestamp,
        // producing inconsistent telemetry.
        dispatchAgentErrorEvent(null, turnId, event.error, {
          humanizedOverride: event.error,
          timestampOverride: event.timestamp,
          ...(event.errorKind ? { errorKindOverride: event.errorKind } : {}),
          ...(event.limitScope ? { limitScopeOverride: event.limitScope } : {}),
          ...(event.credentialSource ? { credentialSource: event.credentialSource } : {}),
          ...(event.errorKind === 'rate_limit'
            ? { intentionalCopyOverrideForKind: 'rate_limit' as const }
            : {}),
          ...(event.provider ? { providerOverride: event.provider } : {}),
          ...(event.isTransient !== undefined ? { isTransient: event.isTransient } : {}),
          ...(event.timeoutDiagnostic ? { timeoutDiagnostic: event.timeoutDiagnostic } : {}),
          ...(event.watchdogDiagnostic ? { watchdogDiagnostic: event.watchdogDiagnostic } : {}),
          // rateLimitMetaOverride preserves pre-computed retryAfterMs/resetAtMs
          // from rate-limit events across automation rebroadcast. Without this,
          // the helper would re-derive from the humanized copy string (failing)
          // and lose the exact reset timestamps the renderer needs to show
          // "Resets at 6:00 PM" for Codex 429s.
          ...(event.errorKind === 'rate_limit' && event.rateLimitMeta
            ? { rateLimitMetaOverride: event.rateLimitMeta }
            : {}),
        });
        const persistedTurnEvents = accumulator.getConversationShape().eventsByTurn[turnId] ?? [];
        const latestPersisted = persistedTurnEvents[persistedTurnEvents.length - 1];
        if (
          latestPersisted?.type === 'error'
          && assertEventHasSeq(latestPersisted, 'automationScheduler.persistedError')
        ) {
          broadcastEvent = latestPersisted;
        } else {
          broadcastEvent = accumulator.stampSeq(event, sessionId);
        }
      } else {
        broadcastEvent = accumulator.stampSeq(event, sessionId);
        dispatchAgentEvent(
          null,
          turnId,
          broadcastEvent as Exclude<AgentEvent, { type: 'error' | 'answer_phase_started' }>,
        );
      }
      broadcastSequencedAgentEvent({ turnId, event: broadcastEvent, sessionId });
    };

    if (status === 'blocked_by_security') {
      broadcastTerminalEvent({
        type: 'error',
        error: blockedActions?.length 
          ? `Automation blocked: ${blockedActions.length} action${blockedActions.length === 1 ? '' : 's'} require${blockedActions.length === 1 ? 's' : ''} approval`
          : 'Automation blocked by security policies',
        errorSource: 'main' as const,
        timestamp: completedAt,
      });
    } else if (status === 'success' || status === 'completed_with_blocks') {
      // mergeResultMessage() promotes the final assistant message to role:'result'
      // on turn completion, so we must check both roles to find the output text.
      // Scope to the automation's turnId for safety in future multi-turn automations.
      const lastOutputText = [...state.messages]
        .reverse()
        .find(m => m.turnId === turnId && (m.role === 'result' || m.role === 'assistant') && m.text.trim())
        ?.text;
      broadcastTerminalEvent({
        type: 'result',
        text: lastOutputText || 'Automation completed successfully',
        timestamp: completedAt,
      });
    } else if (status === 'failure' || status === 'cancelled') {
      broadcastTerminalEvent(
        lastErrorEvent ?? {
          type: 'error',
          error: errorMessage || (stoppedByUser ? 'Automation was cancelled' : 'Automation failed'),
          errorSource: 'main' as const,
          timestamp: completedAt,
        }
      );
    }

    // Build the final session for the return value (used by persistRun).
    // stageSnapshot above already persisted a finalized session to the incremental
    // session store, so no separate fixup persist is needed.
    const { session, messages } = composeSessionSnapshot(state, completedAt);
    session.activeTurnId = null;
    session.isBusy = false;
    session.lastError = errorMessage;
    session.resolvedAt = completedAt;

    agentTurnRegistry.clearToolCalls(turnId);

    // Extract token usage from result events for cost tracking
    const usageData = extractTokenUsageFromEvents(state.eventsByTurn);
    let tokenUsage: import('@shared/types').AutomationRunTokenUsage | undefined;
    let estimatedCostUsd: number | undefined;
    if (usageData) {
      tokenUsage = {
        inputTokens: usageData.inputTokens,
        outputTokens: usageData.outputTokens,
        ...(usageData.cacheReadTokens > 0 && { cacheReadTokens: usageData.cacheReadTokens }),
      };
      estimatedCostUsd = usageData.costUsd
        ?? (usageData.inputTokens * COST_PER_INPUT_TOKEN + usageData.outputTokens * COST_PER_OUTPUT_TOKEN);
    }

    return {
      status,
      error: errorMessage,
      ...(lastErrorKind ? { errorKind: lastErrorKind } : {}),
      ...(lastLimitScope ? { limitScope: lastLimitScope } : {}),
      ...(lastCredentialSource ? { credentialSource: lastCredentialSource } : {}),
      ...(lastHeadlineClass ? { headlineClass: lastHeadlineClass } : {}),
      ...(lastRawError ? { rawError: lastRawError } : {}),
      ...(lastRateLimitResetAtMs != null ? { rateLimitResetAtMs: lastRateLimitResetAtMs } : {}),
      session,
      eventsByTurn: state.eventsByTurn,
      messages,
      blockedActions,
      startedAt,
      completedAt,
      tokenUsage,
      estimatedCostUsd,
      ...(targetPeriodStart != null ? { targetPeriodStart } : {}),
    };
  }

  private async runScriptAutomationPipeline(
    automation: AutomationDefinition,
    trigger: AutomationTrigger,
    runId: string,
  ): Promise<AutomationExecutionResult> {
    const startedAt = Date.now();
    this.stageRunSnapshot({
      id: runId,
      automationId: automation.id,
      startedAt,
      completedAt: null,
      status: 'running',
      trigger,
      sessionId: null,
      error: null,
    });

    const scriptLog = createScopedLogger({
      service: 'automationScriptRunner',
      automationId: automation.id,
      runId,
    });

    const outcome = await runAutomationScript({
      automation,
      runId,
      trigger: this.mapTriggerToScriptTrigger(trigger),
      signal: undefined,
      log: {
        debug: (obj, message) => scriptLog.debug(obj, message),
        info: (obj, message) => scriptLog.info(obj, message),
        warn: (obj, message) => scriptLog.warn(obj, message),
        error: (obj, message) => scriptLog.error(obj, message),
      },
    });

    const completedAt = Date.now();
    if (outcome.status === 'success') {
      return {
        status: 'success',
        error: null,
        session: null,
        messages: [],
        eventsByTurn: {},
        summary: outcome.summary,
        startedAt,
        completedAt,
      };
    }

    return {
      status: 'failure',
      error: outcome.errorMessage,
      session: null,
      messages: [],
      eventsByTurn: {},
      startedAt,
      completedAt,
    };
  }

  /**
   * Resolve the automation skill file to an absolute path and read its content.
   * Handles directory paths, rebel-system fallback, and workspace symlinks.
   */
  private async resolveAutomationFile(
    automation: AutomationDefinition,
    coreDirectory: string
  ): Promise<{ resolved: string; root: string; fileContent: string }> {
    const libraryResult = resolveLibraryPath(automation.filePath, coreDirectory);
    let resolved = libraryResult.resolved;
    const root = libraryResult.root;
    log.debug({ automationId: automation.id, resolvedPath: resolved }, 'Resolved automation file path');

    // Handle directory paths - check for SKILL.md inside
    let stat = await fs.stat(resolved).catch((err) => {
      log.debug({ automationId: automation.id, resolved, err: err.code ?? err.message }, 'Stat failed for automation file');
      return null;
    });
    if (stat?.isDirectory()) {
      const skillPath = path.join(resolved, 'SKILL.md');
      const skillStat = await fs.stat(skillPath).catch(() => null);
      if (skillStat?.isFile()) {
        log.debug({ automationId: automation.id, originalPath: resolved, skillPath }, 'Path was a directory, using SKILL.md inside');
        resolved = skillPath;
        stat = skillStat;
      } else {
        throw new Error(`Automation path "${automation.filePath}" is a directory without a SKILL.md file. Please select a markdown file.`);
      }
    }

    // Fallback for rebel-system paths when workspace symlink not yet created
    // SECURITY: Only applies to paths prefixed with 'rebel-system/' (trusted system content)
    // and we validate the resolved path stays inside systemSettingsPath to prevent traversal
    if (!stat && automation.filePath.startsWith('rebel-system/')) {
      const systemSettingsPath = getSystemSettingsPath();
      const relativeSuffix = automation.filePath.slice('rebel-system/'.length);
      const fallbackPath = path.resolve(systemSettingsPath, relativeSuffix);

      // SECURITY: Prevent path traversal attacks (e.g., rebel-system/../../../etc/passwd)
      if (!isPathInsideLexical(fallbackPath, systemSettingsPath)) {
        throw new Error(`Automation file path escapes system settings: ${automation.filePath}`);
      }
      const fallbackStat = await fs.stat(fallbackPath).catch(() => null);

      if (fallbackStat?.isFile()) {
        log.debug(
          { automationId: automation.id, filePath: automation.filePath, fallbackPath },
          'Using system settings fallback for automation file (workspace symlink not yet created)'
        );
        resolved = fallbackPath;
        stat = fallbackStat;
      } else if (fallbackStat?.isDirectory()) {
        const fallbackSkillPath = path.join(fallbackPath, 'SKILL.md');
        const fallbackSkillStat = await fs.stat(fallbackSkillPath).catch(() => null);
        if (fallbackSkillStat?.isFile()) {
          log.debug(
            { automationId: automation.id, filePath: automation.filePath, fallbackSkillPath },
            'Using system settings fallback for automation directory (workspace symlink not yet created)'
          );
          resolved = fallbackSkillPath;
          stat = fallbackSkillStat;
        }
      }
    }

    if (!stat) {
      const fileName = path.basename(automation.filePath);
      throw new Error(
        `The skill file "${fileName}" could not be found in your workspace. ` +
        `It may have been moved, renamed, or deleted. ` +
        `You can update this automation to point to a new file, or delete it if it's no longer needed.\n\n` +
        `Missing path: ${automation.filePath}`
      );
    }

    const fileContent = await fs.readFile(resolved, 'utf8');
    return { resolved, root, fileContent };
  }

  /**
   * Build the final automation prompt from raw file content.
   * Strips YAML frontmatter, substitutes variables, and injects event context.
   */
  private buildAutomationPrompt(
    rawContent: string,
    automation: AutomationDefinition,
    eventContext?: Record<string, unknown>
  ): string {
    const rawPrompt = stripYamlFrontmatter(rawContent).trimStart();
    let prompt = substitutePromptVariables(rawPrompt, automation);

    if (automation.systemType === 'wins-learnings-uncover') {
      prompt = `${prompt}

[CURRENT ACTIONS POLICY]
Wins, learnings, reflections, recaps, and share-to-social suggestions belong in Coach/memory, not Actions.
Do not call rebel_inbox_add from this automation unless the user explicitly asked for a concrete task in the current interactive conversation.
If older instructions in this skill say to add wins or learnings to Actions, this policy overrides them.`;
    }

    if (eventContext && Object.keys(eventContext).length > 0) {
      prompt = injectEventContext(prompt, eventContext);
      log.debug({ automationId: automation.id, contextKeys: Object.keys(eventContext) }, 'Injected event context into prompt');
    }

    return prompt;
  }

  private async runUseCaseRefreshPipeline(
    automation: AutomationDefinition,
    runId: string
  ): Promise<AutomationExecutionResult> {
    const startedAt = Date.now();
    log.info({ automationId: automation.id, runId }, 'Starting use case refresh system automation');

    if (!this.deps.getSettings || !this.deps.updateSettings || !this.deps.generateUseCases) {
      throw new Error('Use case refresh requires settings and generation dependencies');
    }

    const settings = this.deps.getSettings();
    const result = await this.deps.generateUseCases(settings);

    const completedAt = Date.now();

    if (result.success && result.useCases && result.useCases.length > 0) {
      this.deps.updateSettings((current) => ({
        ...current,
        personalizedUseCases: result.useCases
      }));
      log.info(
        { automationId: automation.id, useCaseCount: result.useCases.length },
        'Use case refresh completed successfully'
      );
      return {
        status: 'success',
        error: null,
        session: null,
        startedAt,
        completedAt
      };
    }

    const errorMessage = result.error ?? 'No use cases were generated';
    log.warn({ automationId: automation.id, error: errorMessage }, 'Use case refresh failed');
    return {
      status: 'failure',
      error: errorMessage,
      session: null,
      startedAt,
      completedAt
    };
  }

  private async runCommunityHighlightsPipeline(
    automation: AutomationDefinition,
    runId: string
  ): Promise<AutomationExecutionResult> {
    const startedAt = Date.now();
    log.info({ automationId: automation.id, runId }, 'Starting community highlights sync');

    if (!this.deps.refreshCommunityHighlights) {
      throw new Error('Community highlights service not available');
    }

    const result = await this.deps.refreshCommunityHighlights();
    const completedAt = Date.now();

    if (result.success) {
      log.info({ automationId: automation.id }, 'Community highlights sync completed successfully');
      return {
        status: 'success',
        error: null,
        session: null,
        startedAt,
        completedAt
      };
    }

    const errorMessage = result.error ?? 'Failed to refresh community highlights';
    log.warn({ automationId: automation.id, error: errorMessage }, 'Community highlights sync failed');
    return {
      status: 'failure',
      error: errorMessage,
      session: null,
      startedAt,
      completedAt
    };
  }

  private async runCalendarSyncPipeline(
    automation: AutomationDefinition,
    runId: string
  ): Promise<AutomationExecutionResult> {
    const startedAt = Date.now();
    log.info({ automationId: automation.id, runId }, 'Starting calendar sync');

    if (!this.deps.syncCalendarCache) {
      throw new Error('Calendar sync service not available');
    }

    const result = await this.deps.syncCalendarCache();
    const completedAt = Date.now();

    if (result.success) {
      log.info(
        { automationId: automation.id, meetingCount: result.meetingCount },
        'Calendar sync completed successfully'
      );

      // Auto-schedule meeting bots if enabled (joinMode === 'auto')
      // This is best-effort - failures don't affect the sync result
      try {
        const { autoScheduleMeetingBots } = await import('./meetingBot/autoScheduleService');
        const scheduleResult = await autoScheduleMeetingBots();
        if (scheduleResult.scheduled > 0) {
          log.info(
            { scheduled: scheduleResult.scheduled, skipped: scheduleResult.skipped },
            'Auto-scheduled meeting bots after calendar sync'
          );
        }
      } catch (error) {
        log.warn({ error }, 'Auto-schedule after calendar sync failed');
      }

      return {
        status: 'success',
        error: null,
        session: null,
        startedAt,
        completedAt
      };
    }

    const errorMessage = result.error ?? 'Failed to sync calendar';
    log.warn({ automationId: automation.id, error: errorMessage }, 'Calendar sync failed');
    return {
      status: 'failure',
      error: errorMessage,
      session: null,
      startedAt,
      completedAt
    };
  }

  private async runCommunityVideoRecsPipeline(
    automation: AutomationDefinition,
    runId: string
  ): Promise<AutomationExecutionResult> {
    const startedAt = Date.now();
    log.info({ automationId: automation.id, runId }, 'Starting community video recs pipeline');

    if (!this.deps.refreshVideoRecs) {
      throw new Error('Video recommendations service not available');
    }

    const result = await this.deps.refreshVideoRecs();
    const completedAt = Date.now();

    if (result.success) {
      log.info({ automationId: automation.id }, 'Community video recs pipeline completed successfully');
      return {
        status: 'success',
        error: null,
        session: null,
        startedAt,
        completedAt
      };
    }

    const errorMessage = result.error ?? 'Failed to refresh video recommendations';
    log.warn({ automationId: automation.id, error: errorMessage }, 'Community video recs pipeline failed');
    return {
      status: 'failure',
      error: errorMessage,
      session: null,
      startedAt,
      completedAt
    };
  }

  private async runSpaceMaintenancePipeline(
    automation: AutomationDefinition,
    runId: string
  ): Promise<AutomationExecutionResult> {
    const startedAt = Date.now();
    log.info({ automationId: automation.id, runId }, 'Starting space maintenance pipeline');

    const settings = this.deps.getSettings?.();
    // Run-time gate: if no non-private shared spaces are configured, the
    // automation is a no-op — return success quickly without paying any
    // I/O or scheduling cost. The migration enables the automation for
    // all users so the `enabled` flag stays consistent across upgrades;
    // this run-time check is where we actually decide to skip.
    const hasSharedSpaces = (settings?.spaces ?? []).some(
      (space) => space.sharing != null && space.sharing !== 'private',
    );
    if (!hasSharedSpaces) {
      log.info(
        { automationId: automation.id, runId },
        'Space maintenance skipped — no non-private shared spaces configured',
      );
      return {
        status: 'success',
        error: null,
        session: null,
        startedAt,
        completedAt: Date.now(),
      };
    }

    const coreDir = this.deps.getCoreDirectory();
    if (!coreDir || !settings) {
      return {
        status: 'failure',
        error: 'Workspace directory is not configured.',
        session: null,
        startedAt,
        completedAt: Date.now(),
      };
    }

    if (!this.deps.runSpaceMaintenance) {
      return {
        status: 'failure',
        error: 'space-maintenance dep not wired',
        session: null,
        startedAt,
        completedAt: Date.now(),
      };
    }

    try {
      const result = await this.deps.runSpaceMaintenance(coreDir, settings);
      const completedAt = Date.now();
      const hasErrors = result.errors.length > 0;
      log.info(
        {
          automationId: automation.id,
          runId,
          scanned: result.scanned,
          mergedSuccessfully: result.mergedSuccessfully,
          mergeFailed: result.mergeFailed,
          errorCount: result.errors.length,
        },
        'Space maintenance pipeline completed',
      );
      return {
        status: hasErrors ? 'completed_with_blocks' : 'success',
        error: hasErrors ? result.errors.slice(0, 5).join('; ') : null,
        session: null,
        startedAt,
        completedAt,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(
        { automationId: automation.id, runId, err: errorMessage },
        'Space maintenance pipeline threw',
      );
      return {
        status: 'failure',
        error: errorMessage,
        session: null,
        startedAt,
        completedAt: Date.now(),
      };
    }
  }

  private async runChiefOfStaffHygienePipeline(
    automation: AutomationDefinition,
    runId: string,
  ): Promise<AutomationExecutionResult> {
    const startedAt = Date.now();
    log.info({ automationId: automation.id, runId }, 'Starting Chief-of-Staff hygiene pipeline');

    const coreDir = this.deps.getCoreDirectory();
    const settings = this.deps.getSettings?.();
    if (!coreDir || !settings) {
      return {
        status: 'failure',
        error: 'Workspace directory is not configured.',
        session: null,
        startedAt,
        completedAt: Date.now(),
      };
    }

    if (!this.deps.runChiefOfStaffHygiene) {
      return {
        status: 'failure',
        error: 'chief-of-staff-hygiene dep not wired',
        session: null,
        startedAt,
        completedAt: Date.now(),
      };
    }

    try {
      const result = await this.deps.runChiefOfStaffHygiene(coreDir, settings);
      const completedAt = Date.now();
      const hasErrors = result.errors.length > 0;
      log.info(
        {
          automationId: automation.id,
          runId,
          readmePath: result.readmePath,
          skippedReason: result.skippedReason,
          eligible: result.eligibility?.eligible ?? false,
          triggerReasons: result.eligibility?.triggerReasons ?? [],
          errorCount: result.errors.length,
          elapsedMs: result.elapsedMs,
        },
        'Chief-of-Staff hygiene pipeline completed',
      );
      return {
        status: hasErrors ? 'completed_with_blocks' : 'success',
        error: hasErrors ? result.errors.slice(0, 5).join('; ') : null,
        session: null,
        startedAt,
        completedAt,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(
        { automationId: automation.id, runId, err: errorMessage },
        'Chief-of-Staff hygiene pipeline threw',
      );
      return {
        status: 'failure',
        error: errorMessage,
        session: null,
        startedAt,
        completedAt: Date.now(),
      };
    }
  }

  private persistRun(
    automationId: string,
    runId: string,
    payload: AutomationExecutionResult & { trigger: AutomationTrigger; executor?: 'llm' | 'script' }
  ): AutomationRun {
    // Note: eventsByTurn, messages, and session are intentionally omitted
    // They are already stored in sessions/<sessionId>.json
    // Including them bloated automations.json to 20MB+ causing beach balls
    const run: AutomationRun = {
      id: runId,
      automationId,
      startedAt: payload.startedAt,
      completedAt: payload.completedAt,
      status: payload.status,
      trigger: payload.trigger,
      sessionId: payload.session?.id ?? null,
      error: payload.error,
      ...(payload.blockedActions?.length ? { blockedActions: payload.blockedActions } : {}),
      ...(payload.tokenUsage ? { tokenUsage: payload.tokenUsage } : {}),
      ...(payload.estimatedCostUsd != null ? { estimatedCostUsd: payload.estimatedCostUsd } : {}),
      ...(payload.targetPeriodStart != null ? { targetPeriodStart: payload.targetPeriodStart } : {}),
      ...(payload.admissionBlock ? { admissionBlock: payload.admissionBlock } : {}),
      ...(payload.errorKind ? { errorKind: payload.errorKind } : {}),
      ...(payload.limitScope ? { limitScope: payload.limitScope } : {}),
      ...(payload.credentialSource ? { credentialSource: payload.credentialSource } : {}),
      ...(payload.headlineClass ? { headlineClass: payload.headlineClass } : {}),
      ...(payload.rawError ? { rawError: payload.rawError } : {}),
      ...(payload.rateLimitResetAtMs != null ? { rateLimitResetAtMs: payload.rateLimitResetAtMs } : {}),
    };

    // Track automation run completion
    const durationMs = (payload.completedAt ?? Date.now()) - payload.startedAt;
    const turnCount = Object.keys(payload.eventsByTurn ?? {}).length;
    const messagesGenerated = payload.messages?.length ?? 0;

    if (payload.status === 'success' || payload.status === 'completed_with_blocks') {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Automation Run Completed',
        properties: {
          automationId,
          status: payload.status,
          durationMs,
          turnCount,
          messagesGenerated,
          outputSessionId: payload.session?.id ? hashSessionId(payload.session.id) : undefined,
          ...(payload.executor ? { executor: payload.executor } : {}),
        }
      });
    } else if (payload.status === 'provider_not_ready') {
      log.debug(
        {
          automationId,
          trigger: payload.trigger,
          admissionBlockCode: payload.admissionBlock?.code,
          provider: payload.admissionBlock?.provider,
        },
        'Skipping Automation Run Failed analytics for provider_not_ready run',
      );
    } else {
      const boundedRawError = payload.rawError?.slice(0, 200);
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Automation Run Failed',
        properties: {
          automationId,
          trigger: payload.trigger,
          errorCode: 'AUTOMATION_ERROR',
          errorType: payload.error ?? 'unknown',
          ...(payload.errorKind ? { errorKind: payload.errorKind } : {}),
          ...(payload.limitScope ? { limitScope: payload.limitScope } : {}),
          ...(payload.credentialSource ? { credentialSource: payload.credentialSource } : {}),
          ...(payload.headlineClass ? { headlineClass: payload.headlineClass } : {}),
          ...(boundedRawError ? { rawError: boundedRawError } : {}),
          durationMs,
          ...(payload.executor ? { executor: payload.executor } : {}),
        }
      });
    }

    // Fire cost tracking event when token usage is available
    if (payload.tokenUsage) {
      const automationName = this.stateSnapshot.definitions.find(d => d.id === automationId)?.name ?? 'unknown';
      const usageExtracted = extractTokenUsageFromEvents(payload.eventsByTurn);
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Automation Run Cost',
        properties: {
          automationId,
          automationName,
          trigger: payload.trigger,
          inputTokens: payload.tokenUsage.inputTokens,
          outputTokens: payload.tokenUsage.outputTokens,
          cacheReadTokens: payload.tokenUsage.cacheReadTokens ?? 0,
          estimatedCostUsd: payload.estimatedCostUsd ?? 0,
          durationMs,
          toolCallCount: usageExtracted?.toolCallCount ?? 0,
        }
      });
    }

    // Persist the lightweight run shape, then send the renderer one terminal
    // snapshot with the final session so App.tsx can ingest the completed
    // automation conversation without bloating automations.json.
    const shouldBroadcastTerminalSession = Boolean(payload.session);
    const runs = this.updateRunsCollection(this.stateSnapshot, run);
    const definitions = this.stateSnapshot.definitions.map((definition) => {
      if (definition.id !== automationId) {
        return definition;
      }
      const lastSuccessAt = (payload.status === 'success' || payload.status === 'completed_with_blocks') ? payload.completedAt : definition.lastSuccessAt;
      const shouldAdvanceScheduleSlot = payload.advanceScheduleSlot ?? true;
      const lastRunAt = shouldAdvanceScheduleSlot ? payload.completedAt : definition.lastRunAt;
      // Apply status BEFORE calculating nextRunAt so once-automations
      // with lastRunStatus='success' correctly return null.
      const updatedDef = {
        ...definition,
        lastRunAt,
        lastSuccessAt,
        lastRunStatus: payload.status,
      };
      const nextRunAt = this.calculateNextRunAt(updatedDef, payload.completedAt ?? Date.now());
      return {
        ...updatedDef,
        nextRunAt
      } satisfies AutomationDefinition;
    });
    const nextState = {
      ...this.stateSnapshot,
      definitions,
      runs
    };
    const stateToPersist = {
      ...nextState,
      runs: nextState.runs.map((item) => this.stripRunForStorage(item)),
    };

    this.commitState(nextState, {
      persist: true,
      suppressBroadcast: shouldBroadcastTerminalSession,
      persistState: stateToPersist,
    });

    if (payload.session) {
      this.broadcastTerminalRunWithSession(run, payload.session);
    }

    return run;
  }

  private broadcastTerminalRunWithSession(run: AutomationRun, session: AgentSession): void {
    this.cancelThrottledBroadcast();
    const snapshot = this.stateSnapshot;
    this.deps.notifyRenderer?.({
      ...snapshot,
      runs: snapshot.runs.map((item) => (
        item.id === run.id
          ? { ...run, session }
          : this.projectRunForBroadcast(item)
      )),
    });
  }

  /**
   * Retroactively upgrade a run from completed_with_blocks → success after all
   * staged approval items were approved by the user. Clears blockedActions from
   * the run and updates lastRunStatus on the definition.
   */
  private upgradeRunStatusAfterApproval(automationId: string, runId: string): void {
    const run = this.stateSnapshot.runs.find((r) => r.id === runId);
    if (!run || run.status !== 'completed_with_blocks') return;

    log.info({ automationId, runId }, 'Upgrading run status from completed_with_blocks to success after all approvals granted');

    this.updateState(
      (state) => {
        const runs = state.runs.map((r) => {
          if (r.id !== runId || r.status !== 'completed_with_blocks') return r;
          const { blockedActions: _, ...rest } = r;
          return { ...rest, status: 'success' as const };
        });
        const definitions = state.definitions.map((def) => {
          if (def.id !== automationId || def.lastRunStatus !== 'completed_with_blocks') return def;
          return { ...def, lastRunStatus: 'success' as const };
        });
        return { ...state, runs, definitions };
      },
      { persist: true }
    );
  }

  // Delegate to the exported standalone function for testability
  private calculateNextRunAt(definition: AutomationDefinition, from: number): number | null {
    return calculateNextRunAt(definition, from);
  }

  // Delegate to the exported standalone function for testability
  private calculateMostRecentScheduledTime(definition: AutomationDefinition, from: number): number | null {
    return calculateMostRecentScheduledTime(definition, from);
  }

  /**
   * Check if an automation is currently running.
   */
  private isAutomationRunning(automationId: string): boolean {
    return this.stateSnapshot.runs.some(
      (run) => run.automationId === automationId && run.status === 'running'
    );
  }

  private getAnalyticsExecutor(automation: AutomationDefinition): 'llm' | 'script' | undefined {
    if (
      !automation.filePath?.trim()
      && automation.isSystem
      && automation.systemType
      && DIRECT_SYSTEM_PIPELINE_TYPES.has(automation.systemType)
    ) {
      return undefined;
    }

    if (automation.executor === undefined) {
      return 'llm';
    }

    if (automation.executor === 'llm' || automation.executor === 'script') {
      return automation.executor;
    }

    return undefined;
  }

  private mapTriggerToScriptTrigger(trigger: AutomationTrigger): 'manual' | 'scheduled' | 'event' | 'catchup' {
    switch (trigger) {
      case 'manual':
        return 'manual';
      case 'schedule':
      case 'launch':
      case 'rules-update':
        return 'scheduled';
      case 'catch-up':
        return 'catchup';
      case 'event':
        return 'event';
    }
  }

  private isCloudActiveForScheduling(): boolean {
    const settings = this.deps.getSettings?.();
    if (!settings) return false;
    const ci = settings.cloudInstance;
    if (!ci || ci.mode !== 'cloud' || !ci.cloudUrl || !ci.cloudToken) return false;

    if (ci.lastKnownStatus === 'error' || !!ci.errorCategory) {
      log.info(
        {
          cloudUnreachable: true,
          lastKnownStatus: ci.lastKnownStatus,
          errorCategoryKind: ci.errorCategory?.kind,
        },
        'Cloud unreachable — desktop will execute automation as fallback',
      );
      return false;
    }

    return true;
  }

  /**
   * Check for missed automation runs and execute catch-up if needed.
   * Called on app launch and after system resume.
   *
   * NOTE: The catch-up decision uses `shouldHaveRunAt > lastRunAt` which compares
   * schedule time against completion time. A future improvement would be to track
   * `scheduledFor` on each run (the intended schedule slot) for deterministic dedup.
   * See docs/plans/partway/260103_automation_scheduler_robustness.md for details.
   */
  private checkForMissedRuns(context: 'launch' | 'resume'): void {
    const now = Date.now();
    const gracePeriodMs = 7 * 24 * 60 * 60 * 1000; // 7 days - covers typical weekend gaps
    const newUserGracePeriodMs = 24 * 60 * 60 * 1000; // 1 day - give new users time to settle in

    // Skip catch-up for brand new users (less than 1 day since onboarding completed)
    // This prevents system automations from running immediately on first launch
    // Note: If onboardingFirstCompletedAt is null/undefined (old users, migration not run),
    // we ALLOW catch-up - only skip for users with a RECENT timestamp
    const settings = this.deps.getSettings?.();
    const onboardingCompletedAt = settings?.onboardingFirstCompletedAt;
    if (onboardingCompletedAt && (now - onboardingCompletedAt) < newUserGracePeriodMs) {
      log.info(
        { onboardingCompletedAt, onboardingAgeHours: Math.round((now - onboardingCompletedAt) / 3600000) },
        'Catch-up skipped for all automations: new user grace period (< 24h since onboarding)'
      );
      return;
    }

    for (const def of this.stateSnapshot.definitions) {
      const automationId = def.id;

      if (!def.enabled) {
        log.debug({ automationId, reason: 'disabled' }, 'Catch-up skipped');
        continue;
      }
      if (def.catchUpIfMissed === false) {
        log.debug({ automationId, reason: 'catchUpIfMissed_false' }, 'Catch-up skipped');
        continue;
      }
      // Cloud-selected automations catch up on cloud when cloud is active
      if (def.executeIn === 'cloud' && this.isCloudActiveForScheduling()) {
        log.debug({ automationId, reason: 'cloud_active' }, 'Catch-up skipped — cloud will handle');
        continue;
      }
      if (shouldSkipDueToActiveRun(this.isAutomationRunning(def.id))) {
        log.debug({ automationId, reason: 'already_running' }, 'Catch-up skipped');
        continue;
      }
      // Once-automations that already ran successfully don't need catch-up
      if (def.schedule.type === 'once' &&
          (def.lastRunStatus === 'success' || def.lastRunStatus === 'completed_with_blocks')) {
        log.debug({ automationId, reason: 'once_already_completed' }, 'Catch-up skipped');
        continue;
      }

      const shouldHaveRunAt = this.calculateMostRecentScheduledTime(def, now);
      if (!shouldHaveRunAt) {
        log.debug({ automationId, reason: 'no_scheduled_time' }, 'Catch-up skipped');
        continue;
      }

      const lastRun = def.lastRunAt ?? 0;
      const missedRun = shouldHaveRunAt > lastRun;
      const missedBy = now - shouldHaveRunAt;
      const withinGrace = missedBy < gracePeriodMs;

      if (!withinGrace) {
        log.debug(
          { automationId, reason: 'grace_period_expired', missedByMinutes: Math.round(missedBy / 60000), gracePeriodHours: 168 },
          'Catch-up skipped'
        );
        continue;
      }

      if (!missedRun) {
        log.debug(
          {
            automationId,
            reason: 'not_missed',
            lastRunAt: lastRun ? new Date(lastRun).toISOString() : 'never',
            shouldHaveRunAt: new Date(shouldHaveRunAt).toISOString()
          },
          'Catch-up skipped'
        );
        continue;
      }

      log.info(
        {
          automationId,
          automationName: def.name,
          shouldHaveRunAt: new Date(shouldHaveRunAt).toISOString(),
          lastRunAt: lastRun ? new Date(lastRun).toISOString() : 'never',
          missedByMinutes: Math.round(missedBy / 60000),
          context
        },
        'Catching up missed automation run'
      );
      fireAndForget(this.executeAutomation(def, 'catch-up'), 'automationScheduler.line4069');
    }
  }

  private scheduleAutomation(definition: AutomationDefinition): void {
    if (this.lowPowerModeReason) {
      log.debug({ id: definition.id, reason: this.lowPowerModeReason }, 'Skipping automation scheduling due to low-power mode');
      return;
    }
    this.clearTimer(definition.id);
    if (!definition.enabled) {
      return;
    }
    // Event-triggered automations don't use timers; they fire when events occur
    if (definition.schedule.type === 'event') {
      return;
    }

    const scheduled = scheduleDefinitionWithMaxTimeout<AutomationDefinition>({
      definitionId: definition.id,
      timers: this.timers,
      scheduler: this.scheduler,
      getDefinitionById: (id) => this.stateSnapshot.definitions.find((d) => d.id === id && d.enabled),
      calculateNextRunAt: (freshDefinition, fromMs) => {
        if (freshDefinition.schedule.type === 'event') return null;
        return this.calculateNextRunAt(freshDefinition, fromMs);
      },
      onFire: (freshDefinition) => {
        fireAndForget(this.executeAutomation(freshDefinition, 'schedule'), 'automationScheduler.line4097');
      },
      onDropped: (id) => {
        this.timers.delete(id);
      },
    });

    if (!scheduled) {
      return;
    }

    log.debug(
      {
        automationId: definition.id,
        nextRunAt: scheduled.nextRunAt,
        delayMs: scheduled.delayMs,
        chained: scheduled.chained,
      },
      'Timer scheduled',
    );
  }

  private deferAutomationToRetrySameOccurrence(args: {
    automation: AutomationDefinition;
    trigger: Extract<AutomationTrigger, 'schedule' | 'catch-up'>;
    delayMs: number;
    reason: string;
  }): void {
    this.clearTimer(args.automation.id);

    const delay = Math.max(0, args.delayMs);
    const timer = this.scheduler.registerTimeout(() => {
      const currentDefinition = this.stateSnapshot.definitions.find((def) => def.id === args.automation.id);
      if (!currentDefinition || !currentDefinition.enabled) {
        this.timers.delete(args.automation.id);
        log.info(
          {
            automationId: args.automation.id,
            trigger: args.trigger,
            reason: 'no-longer-enabled',
          },
          'Deferred automation skipped',
        );
        return;
      }

      fireAndForget(
        this.executeAutomation(currentDefinition, args.trigger),
        'automationScheduler.deferredCooldownRetry',
      );
    }, delay);

    this.timers.set(args.automation.id, timer);
    log.info(
      {
        automationId: args.automation.id,
        trigger: args.trigger,
        delayMs: delay,
        reason: args.reason,
      },
      'API rate-limit cooldown active — deferred automation to retry the same occurrence',
    );
  }

  private clearAllTimers(): void {
    for (const timer of this.timers.values()) {
      this.scheduler.clear(timer);
    }
    this.timers.clear();
    this.cancelThrottledBroadcast();
    this.cancelSessionUpsertTimers();
  }

  private rescheduleAll(reason: string): void {
    this.clearAllTimers();
    for (const definition of this.stateSnapshot.definitions) {
      this.scheduleAutomation(definition);
    }
    log.info({ reason }, 'Automation scheduler timers rescheduled');
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      this.scheduler.clear(timer);
      this.timers.delete(id);
    }
  }

  enterLowPowerMode(reason: string): void {
    if (this.lowPowerModeReason) {
      return;
    }
    this.lowPowerModeReason = reason;
    this.clearAllTimers();
    log.info({ reason }, 'Automation scheduler paused for low-power mode');
  }

  exitLowPowerMode(
    reason: string,
    queueCatchUp?: (automationId: string, execute: () => Promise<void>) => void
  ): void {
    if (!this.lowPowerModeReason) {
      return;
    }
    this.lowPowerModeReason = null;
    this.rescheduleAll(reason);
    // Use staggered catch-up if callback provided, otherwise fall back to immediate
    if (queueCatchUp) {
      this.checkForMissedRunsStaggered('resume', queueCatchUp);
    } else {
      this.checkForMissedRuns('resume');
    }
    log.info({ reason }, 'Automation scheduler resumed after low-power mode');
  }

  private broadcast(mode: 'full' | 'projection' = 'full'): void {
    if (mode === 'full') {
      this.cancelThrottledBroadcast();
    }
    const snapshot = this.stateSnapshot;
    log.debug(
      {
        mode,
        definitionCount: snapshot.definitions.length,
        runCount: snapshot.runs.length,
        sessionTypeFilter: snapshot.sessionTypeFilter
      },
      'Broadcasting automation state to renderer'
    );
    if (mode === 'projection') {
      const projected: AutomationStoreState = {
        ...snapshot,
        runs: snapshot.runs.map((run) => this.projectRunForBroadcast(run)),
      };
      this.deps.notifyRenderer?.(projected);
    } else {
      this.deps.notifyRenderer?.(snapshot);
    }
  }

  private getEffectiveThrottleMs(): number {
    const runningCount = this.stateSnapshot.runs.filter(r => r.status === 'running').length;
    return runningCount >= 3
      ? AutomationScheduler.BROADCAST_THROTTLE_HIGH_CONCURRENCY_MS
      : AutomationScheduler.BROADCAST_THROTTLE_MS;
  }

  private scheduleThrottledBroadcast(): void {
    if (this._throttledBroadcastTimer !== null) return;
    this._throttledBroadcastTimer = setTimeout(() => {
      this._throttledBroadcastTimer = null;
      this.broadcast('projection');
    }, this.getEffectiveThrottleMs());
  }

  private cancelThrottledBroadcast(): void {
    if (this._throttledBroadcastTimer !== null) {
      clearTimeout(this._throttledBroadcastTimer);
      this._throttledBroadcastTimer = null;
    }
  }

  private persistAutomationSessionSnapshot(
    sessionId: string,
    session: AgentSession,
    phase: 'terminal' | 'initial' | 'debounced',
  ): void {
    getIncrementalSessionStore().updateSession(sessionId, (existing) => {
      if (!existing) {
        return session;
      }
      return {
        ...existing,
        ...session,
        memoryUpdateStatusByTurn: {
          ...(existing.memoryUpdateStatusByTurn ?? {}),
          ...(session.memoryUpdateStatusByTurn ?? {}),
        },
        timeSavedStatusByTurn: {
          ...(existing.timeSavedStatusByTurn ?? {}),
          ...(session.timeSavedStatusByTurn ?? {}),
        },
        updatedAt: nextContentUpdatedAt(existing.updatedAt),
      };
    }).catch((err) => {
      log.warn({ err, sessionId, phase }, 'Failed to persist automation session');
    });
  }

  private debouncedSessionUpsert(sessionId: string, session: AgentSession, isTerminal: boolean): void {
    if (isTerminal) {
      const timer = this._sessionUpsertTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      this._sessionUpsertTimers.delete(sessionId);
      this._pendingSessionUpserts.delete(sessionId);
      this.persistAutomationSessionSnapshot(sessionId, session, 'terminal');
      return;
    }

    const isFirstUpsert = !this._pendingSessionUpserts.has(sessionId);
    this._pendingSessionUpserts.set(sessionId, session);

    if (isFirstUpsert) {
      this.persistAutomationSessionSnapshot(sessionId, session, 'initial');
    }

    if (!this._sessionUpsertTimers.has(sessionId)) {
      this._sessionUpsertTimers.set(sessionId, setTimeout(() => {
        this._sessionUpsertTimers.delete(sessionId);
        const latest = this._pendingSessionUpserts.get(sessionId);
        if (latest) {
          this.persistAutomationSessionSnapshot(sessionId, latest, 'debounced');
        }
      }, AutomationScheduler.SESSION_UPSERT_DEBOUNCE_MS));
    }
  }

  private cancelSessionUpsertTimers(): void {
    for (const timer of this._sessionUpsertTimers.values()) {
      clearTimeout(timer);
    }
    this._sessionUpsertTimers.clear();
    this._pendingSessionUpserts.clear();
  }

  private cancelSessionUpsertTimersForAutomation(automationId: string): void {
    const sessionIds = this.stateSnapshot.runs
      .filter(r => r.automationId === automationId && r.sessionId)
      .map(r => r.sessionId as string);
    for (const sid of sessionIds) {
      const timer = this._sessionUpsertTimers.get(sid);
      if (timer) clearTimeout(timer);
      this._sessionUpsertTimers.delete(sid);
      this._pendingSessionUpserts.delete(sid);
    }
  }

  /**
   * Set the calendar sync automation enabled state.
   * Called when user toggles settings.calendar.useOtherCalendarProvider.
   */
  setCalendarSyncAutomationEnabled(enabled: boolean): void {
    const calendarSyncDef = this.stateSnapshot.definitions.find(
      def => def.isSystem && def.systemType === 'calendar-sync'
    );
    if (!calendarSyncDef) {
      log.warn('Calendar sync automation not found');
      return;
    }
    if (calendarSyncDef.enabled === enabled) {
      return; // No change needed
    }
    log.info({ enabled }, 'Setting calendar sync automation enabled state');
    this.upsertDefinition({
      id: calendarSyncDef.id,
      schedule: calendarSyncDef.schedule,
      enabled
    });
  }

}

// The automation-level criterion is captured at session creation time and does
// not retroactively update existing sessions — same semantics as a user manually
// setting a session's finish line. Pre-writing the session record (rather than
// threading the criterion through `executeAgentTurn` options) lets the
// executor's session-fallback path resolve the criterion on the spawn turn AND
// on any subsequent user-reply turns within that session. Per-session edits
// (e.g. the composer's FinishLineEditor) always win over the automation seed.
//
// Extracting a shared `src/main/services/seedSessionFinishLine.ts` is queued as
// a follow-on planning doc — see `docs/plans/260515_finish_line.md`.
async function seedAutomationSessionFinishLine(
  sessionId: string,
  automation: AutomationDefinition,
): Promise<void> {
  const finishLine = normalizeFinishLine(automation.finishLine);
  if (!finishLine) return;
  try {
    const now = Date.now();
    await getIncrementalSessionStore().updateSession(sessionId, (existing) => {
      if (existing) {
        if (existing.finishLine !== undefined) {
          return null;
        }
        return {
          ...existing,
          finishLine,
          updatedAt: now,
        };
      }
      const shell: AgentSession = {
        id: sessionId,
        title: automation.name,
        createdAt: now,
        updatedAt: now,
        messages: [],
        eventsByTurn: {},
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        resolvedAt: null,
        origin: 'automation',
        automationId: automation.id,
        finishLine,
      };
      return shell;
    });
  } catch (err) {
    log.warn(
      { err, sessionId, automationId: automation.id },
      'Failed to seed automation finish line on session record',
    );
  }
}
