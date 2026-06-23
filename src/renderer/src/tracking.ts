import { analytics } from './analytics';
import { captureRendererMessage } from './sentry';
import {
  buildAnalyticsAttributionProperties,
  hashSessionId,
  sanitizeServerIdForAnalytics,
  TUTORIAL_STEP_NAMES,
  type OnboardingStep,
  type OnboardingStage,
  type TutorialStepName,
  type MilestoneType,
  type TurnToolMetrics,
  type TurnSubAgentMetrics,
  type SubscriptionTraitTier,
  type SubscriptionTraitStatus,
  type UserTraits
} from '@shared/trackingTypes';
import type { SubscriptionCheckoutOrigin } from '@shared/ipc/channels/subscription';
import type { DailySparkFormat } from '@core/dailySparkTypes';
import type { ModelUsageEntry } from '@shared/types/agent';
import type { OutputShapeMetrics } from '@shared/utils/outputShapeMetrics';
import { getModelPricing } from '@shared/utils/pricingCalculator';
import type { LibraryFilter, LibraryView } from '@renderer/features/library/types/lens';

let milestonesReached: Set<MilestoneType> = new Set();

const loadMilestones = (): void => {
  try {
    const stored = localStorage.getItem('analytics_milestones');
    if (stored) {
      milestonesReached = new Set(JSON.parse(stored) as MilestoneType[]);
    }
  } catch {
    // Ignore parse errors
  }
};

const saveMilestones = (): void => {
  try {
    localStorage.setItem('analytics_milestones', JSON.stringify([...milestonesReached]));
  } catch {
    // Ignore storage errors
  }
};

loadMilestones();

// First action after onboarding funnel tracking
const ONBOARDING_COMPLETION_KEY = 'analytics_onboarding_completed_at';
const FIRST_ACTION_TRACKED_KEY = 'analytics_first_action_tracked';
const FIRST_REAL_TASK_TRACKED_KEY = 'analytics_first_real_task_tracked';
const SPARK_STAGE_TRACKED_KEY = 'analytics_spark_stage_tracked';

type FirstActionType = 
  | 'sent_message' 
  | 'opened_spark' 
  | 'opened_library' 
  | 'opened_settings' 
  | 'clicked_use_case'
  | 'clicked_skill'
  | 'opened_automations'
  | 'opened_inbox'
  | 'watched_tutorial';

let onboardingCompletedAt: number | null = null;
let firstActionTracked = false;
let firstRealTaskTracked = false;
let sparkStageTracked = false;

const loadOnboardingState = (): void => {
  try {
    const storedTime = localStorage.getItem(ONBOARDING_COMPLETION_KEY);
    if (storedTime) {
      onboardingCompletedAt = parseInt(storedTime, 10);
    }
    const storedTracked = localStorage.getItem(FIRST_ACTION_TRACKED_KEY);
    firstActionTracked = storedTracked === 'true';
    const storedRealTask = localStorage.getItem(FIRST_REAL_TASK_TRACKED_KEY);
    firstRealTaskTracked = storedRealTask === 'true';
    const storedSpark = localStorage.getItem(SPARK_STAGE_TRACKED_KEY);
    sparkStageTracked = storedSpark === 'true';
  } catch {
    // Ignore errors
  }
};

loadOnboardingState();

/** Record when onboarding completes (called from onboarding flow) */
export const recordOnboardingCompletion = (): void => {
  onboardingCompletedAt = Date.now();
  firstActionTracked = false;
  try {
    localStorage.setItem(ONBOARDING_COMPLETION_KEY, String(onboardingCompletedAt));
    localStorage.removeItem(FIRST_ACTION_TRACKED_KEY);
  } catch {
    // Ignore errors
  }
};

/** Track first action after onboarding (called from various action handlers) */
export const trackFirstActionIfNeeded = (action: FirstActionType): void => {
  // Only track if:
  // 1. Onboarding has completed
  // 2. First action hasn't been tracked yet
  // 3. It's within 24 hours of onboarding completion (reasonable window)
  if (!onboardingCompletedAt || firstActionTracked) return;
  
  const timeAfterOnboardingMs = Date.now() - onboardingCompletedAt;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  
  if (timeAfterOnboardingMs > TWENTY_FOUR_HOURS) {
    // Too long after onboarding, mark as tracked to stop checking
    firstActionTracked = true;
    try {
      localStorage.setItem(FIRST_ACTION_TRACKED_KEY, 'true');
    } catch {
      // Ignore errors
    }
    return;
  }
  
  // Track the first action!
  firstActionTracked = true;
  try {
    localStorage.setItem(FIRST_ACTION_TRACKED_KEY, 'true');
  } catch {
    // Ignore errors
  }
  
  analytics.track('First Action After Onboarding', { action, timeAfterOnboardingMs });
};

const normalizeSkillPathForAnalytics = (skillPath: string): string => skillPath.replace(/\\/g, '/').replace(/\/+/g, '/');

const humanizeSkillSlugForAnalytics = (slug: string): string =>
  slug
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const deriveSkillSlugForAnalytics = (skillPath: string, fallbackName: string): string => {
  const normalized = normalizeSkillPathForAnalytics(skillPath);
  const parts = normalized.split('/').filter(Boolean);
  const fileName = parts.at(-1) ?? fallbackName;
  if (fileName.toLowerCase() === 'skill.md' && parts.length >= 2) {
    return parts.at(-2) ?? fallbackName.replace(/\.md$/i, '');
  }
  return fileName.replace(/\.md$/i, '') || fallbackName.replace(/\.md$/i, '');
};

const deriveSkillScopeForAnalytics = (skillPath: string): 'system' | 'shared' | 'private' => {
  const normalized = normalizeSkillPathForAnalytics(skillPath).toLowerCase();
  if (normalized.includes('rebel-system/skills/')) return 'system';
  if (normalized.includes('/company memories/skills/') || normalized.includes('company memories/skills/')) return 'shared';
  return 'private';
};

const buildSkillUseProperties = (skillPath: string, rawSkillName: string) => {
  const normalizedPath = normalizeSkillPathForAnalytics(skillPath);
  const skillSlug = deriveSkillSlugForAnalytics(normalizedPath, rawSkillName);
  const normalizedName = rawSkillName.trim();
  const skillTitle = normalizedName && normalizedName.toLowerCase() !== 'skill'
    ? normalizedName.replace(/\.md$/i, '')
    : humanizeSkillSlugForAnalytics(skillSlug);

  return {
    skillPath: normalizedPath,
    rawSkillName,
    skillName: skillTitle,
    skillTitle,
    skillSlug,
    skillScope: deriveSkillScopeForAnalytics(normalizedPath),
  };
};

type LensChangedAxis = 'filter' | 'view' | 'both';

export const tracking = {
  // Identity & Traits
  identifyUser: (traits: Partial<UserTraits>) => {
    const anonymousId = window.electronEnv?.anonymousId;
    if (!anonymousId) return;

    analytics.setAccountContext(buildAnalyticsAttributionProperties({
      companyName: traits.companyName,
      accountId: traits.accountId,
      accountName: traits.accountName,
      source: traits.accountAttributionSource,
      licenseTier: traits.licenseTier,
    }));

    // Use email as userId when available (from preload, traits, or previously identified)
    const email = window.electronEnv?.userEmail ?? (traits as { email?: string }).email ?? analytics.getIdentifiedEmail();

    if (email) {
      // Use identifyEmail which handles alias() internally
      analytics.identifyEmail(email, { traits });
    } else {
      // No email yet, identify with anonymousId
      analytics.identify(anonymousId, traits);
    }
  },

  setAccountContext: (context: {
    companyName?: string | null;
    accountId?: string | null;
    accountName?: string | null;
    source?: string | null;
    licenseTier?: string | null;
  }) => {
    analytics.setAccountContext(buildAnalyticsAttributionProperties(context));
  },

  // Milestones
  trackMilestone: (milestone: MilestoneType) => {
    if (milestonesReached.has(milestone)) return;
    milestonesReached.add(milestone);
    saveMilestones();
    analytics.track('Milestone Reached', { milestone, timestamp: Date.now() });
  },

  checkMilestone: (milestone: MilestoneType): boolean => {
    return milestonesReached.has(milestone);
  },

  // Onboarding Events
  onboarding: {
    started: (isRelaunch: boolean) => {
      analytics.track('Onboarding Started', { isRelaunch });
    },
    stepViewed: (step: OnboardingStep, stepIndex: number, isBackNavigation: boolean) => {
      analytics.track('Onboarding Step Viewed', { step, stepIndex, isBackNavigation });
    },
    stepCompleted: (step: OnboardingStep, durationOnStepMs: number, usedDefaults: boolean) => {
      analytics.track('Onboarding Step Completed', { step, durationOnStepMs, usedDefaults });
    },
    stepError: (step: OnboardingStep, errorType: string, errorField?: string) => {
      analytics.track('Onboarding Step Error', { step, errorType, errorField });
    },
    completed: (totalDurationMs: number, stepsCompleted: OnboardingStep[]) => {
      analytics.track('Onboarding Completed', { totalDurationMs, stepsCompleted });
      recordOnboardingCompletion();
    },
    abandoned: (lastStep: OnboardingStep, stepReached: number, timeSpentMs?: number) => {
      analytics.track('Onboarding Abandoned', { lastStep, stepReached, timeSpentMs });
      if (timeSpentMs !== undefined) {
        tracking.onboarding.stageAbandoned('wizard', timeSpentMs / 1000);
      }
    },

    // Onboarding stage lifecycle (high-level funnel: wizard → coach → ui_reveal → tutorial → spark)
    stageEntered: (stage: OnboardingStage) => {
      analytics.track('Onboarding Stage Entered', { stage });
    },
    stageCompleted: (stage: OnboardingStage, durationSeconds: number) => {
      analytics.track('Onboarding Stage Completed', { stage, durationSeconds });
    },
    stageAbandoned: (stage: OnboardingStage, timeSpentSeconds: number) => {
      analytics.track('Onboarding Stage Abandoned', { stage, timeSpentSeconds });
    },

    // Checklist (post-wizard) step tracking
    checklistStepStarted: (step: number, sessionId?: string) => {
      const stepName = TUTORIAL_STEP_NAMES[step] as TutorialStepName | undefined;
      analytics.track('Onboarding Checklist Step Started', {
        step,
        stepName: stepName ?? `step_${step}`,
        sessionId: sessionId ? hashSessionId(sessionId) : undefined
      });
    },
    checklistStepCompleted: (step: number, sessionId?: string, durationSeconds?: number) => {
      const stepName = TUTORIAL_STEP_NAMES[step] as TutorialStepName | undefined;
      analytics.track('Onboarding Checklist Step Completed', {
        step,
        stepName: stepName ?? `step_${step}`,
        sessionId: sessionId ? hashSessionId(sessionId) : undefined,
        ...(durationSeconds !== undefined && { durationSeconds })
      });
    },

    // Library Step
    librarySelected: (isDefault: boolean, isCustomPath: boolean) => {
      analytics.track('Workspace Directory Selected', { isDefault, isCustomPath }); // Event name preserved for dashboard compatibility
    },
    eulaAccepted: () => {
      analytics.track('EULA Accepted', { timestamp: Date.now() });
    },
    eulaDeclined: () => {
      analytics.track('EULA Declined', { timestamp: Date.now() });
    },

    // API Step
    claudeKeyEntered: () => {
      analytics.track('Claude API Key Entered', {});
    },
    voiceProviderSelected: (provider: string) => {
      analytics.track('Voice Provider Selected', { provider });
    },
    voiceKeyEntered: (provider: string) => {
      analytics.track('Voice API Key Entered', { provider });
    },
    apiStepSkipped: (provider: string) => {
      analytics.track('API Step Skipped', { provider });
    },
    spacesStepSkipped: (reason: string) => {
      analytics.track('Spaces Step Skipped', { reason });
    },
    apiStepValidationFailed: (reason: string) => {
      analytics.track('API Step Validation Failed', { reason });
    },

    // MCP Config Discovery
    mcpConfigDiscovered: (configCount: number) => {
      analytics.track('MCP Config Discovered', { configCount });
    },
    mcpConfigSelected: (source: string, serverCount: number) => {
      analytics.track('MCP Config Selected', { source, serverCount });
    },

    // Tool Auth Step
    toolAuthLinkGenerated: (tool: 'email' | 'calendar' | 'chat') => {
      analytics.track('Tool Auth Link Generated', { tool });
    },
    toolAuthVerified: (tool: 'email' | 'calendar' | 'chat', isAuthenticated: boolean) => {
      analytics.track('Tool Auth Verified', { tool, isAuthenticated });
    },
    toolAuthError: (tool: 'email' | 'calendar' | 'chat', error: string) => {
      analytics.track('Tool Auth Error', { tool, error });
    },
    toolAuthClicked: (tool: 'email' | 'calendar' | 'chat') => {
      analytics.track('Tool Auth Clicked', { tool });
    },

    // Escape Hatch (emergency skip)
    escapeHatchTriggered: (step: OnboardingStep, stepIndex: number, timeSpentMs: number) => {
      analytics.track('Onboarding Escape Hatch Triggered', { step, stepIndex, timeSpentMs });
    },
    escapeHatchConfirmed: (step: OnboardingStep, stepIndex: number, timeSpentMs: number, completedSteps: OnboardingStep[]) => {
      analytics.track('Onboarding Escape Hatch Confirmed', { step, stepIndex, timeSpentMs, completedSteps });
    },
    escapeHatchCancelled: (step: OnboardingStep, stepIndex: number) => {
      analytics.track('Onboarding Escape Hatch Cancelled', { step, stepIndex });
    },

    // Permissions Step
    microphonePermissionRequested: (attemptNumber: number) => {
      analytics.track('Microphone Permission Requested', { attemptNumber });
    },
    microphonePermissionGranted: (attemptNumber: number) => {
      analytics.track('Microphone Permission Granted', { attemptNumber });
    },
    microphonePermissionDenied: (attemptNumber: number) => {
      analytics.track('Microphone Permission Denied', { attemptNumber });
    },
    fileAccessRequested: (attemptNumber: number) => {
      analytics.track('File Access Requested', { attemptNumber });
    },
    fileAccessGranted: (attemptNumber: number) => {
      analytics.track('File Access Granted', { attemptNumber });
    },
    fileAccessDenied: (errorMessage: string, errorCode?: string) => {
      analytics.track('File Access Denied', { errorMessage, errorCode });
    },
    // First action after onboarding funnel
    firstActionAfterOnboarding: (action: 
      | 'sent_message' 
      | 'opened_spark' 
      | 'opened_library' 
      | 'opened_settings' 
      | 'clicked_use_case'
      | 'clicked_skill'
      | 'opened_automations'
      | 'opened_inbox'
      | 'watched_tutorial',
      timeAfterOnboardingMs: number
    ) => {
      analytics.track('First Action After Onboarding', { action, timeAfterOnboardingMs });
    },
  },

  // Chat Interactions
  chat: {
    sessionCreated: (sessionId: string, origin: 'manual' | 'automation', isFirstSession: boolean) => {
      analytics.track('Chat Session Created', {
        sessionId: hashSessionId(sessionId),
        origin,
        isFirstSession
      });
      if (isFirstSession) {
        tracking.trackMilestone('first_message_sent');
      }
    },
    sessionResumed: (sessionId: string, messageCount: number, ageMs: number, source?: 'sidebar' | 'collapsed_tabs' | 'keyboard_shortcut' | 'homepage' | 'inbox' | 'rebel_link' | 'notification' | 'library' | 'meeting' | 'mcp' | 'task' | 'time_saved' | 'achievement' | 'atlas' | 'restore' | 'onboarding') => {
      analytics.track('Chat Session Resumed', {
        sessionId: hashSessionId(sessionId),
        messageCount,
        ageMs,
        source: source ?? 'unknown'
      });
    },
    sessionResolved: (sessionId: string, durationMs: number, turnCount: number, messageCount: number) => {
      analytics.track('Chat Session Resolved', {
        sessionId: hashSessionId(sessionId),
        durationMs,
        turnCount,
        messageCount
      });
    },
    sessionDeleted: (sessionId: string, wasActive: boolean, messageCount: number) => {
      analytics.track('Chat Session Deleted', {
        sessionId: hashSessionId(sessionId),
        wasActive,
        messageCount
      });
    },
    messageSent: (params: {
      source: 'text' | 'voice';
      sessionId: string;
      hasAttachments: boolean;
      attachmentCount: number;
      isEdit: boolean;
      charCount: number;
    }) => {
      analytics.track('Chat Message Sent', {
        ...params,
        sessionId: hashSessionId(params.sessionId)
      });
      if (params.source === 'voice' && !tracking.checkMilestone('first_voice_message')) {
        tracking.trackMilestone('first_voice_message');
      }
      trackFirstActionIfNeeded('sent_message');
    },
    messageQueued: (sessionId: string, queuePosition: number) => {
      analytics.track('Chat Message Queued', {
        sessionId: hashSessionId(sessionId),
        queuePosition
      });
    },
    agentReplyStarted: (turnId: string, sessionId: string) => {
      analytics.track('Agent Reply Started', {
        turnId,
        sessionId: hashSessionId(sessionId)
      });
    },
    agentReplyDelivered: (turnId: string, sessionId: string, timeToFirstResponseMs: number, totalDurationMs: number) => {
      analytics.track('Agent Reply Delivered', {
        turnId,
        sessionId: hashSessionId(sessionId),
        timeToFirstResponseMs,
        totalDurationMs
      });
    },
    turnCompleted: (params: {
      turnId: string;
      sessionId: string;
      durationMs: number;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
      modelUsage?: Record<string, ModelUsageEntry>;
      toolMetrics?: TurnToolMetrics;
      subAgentMetrics?: TurnSubAgentMetrics;
      authMethod?: string;
      fallbacks?: Array<{ type: string; from: string; to: string; reason: string }>;
      outputShapeMetrics?: OutputShapeMetrics;
    }) => {
      const { toolMetrics, subAgentMetrics, modelUsage, outputShapeMetrics, ...rest } = params;
      // Compute derived cache/prompt metrics for cost analysis
      const inputTokens = params.inputTokens ?? 0;
      const cacheReadTokens = params.cacheReadTokens ?? 0;
      const cacheCreationTokens = params.cacheCreationTokens ?? 0;
      const totalPromptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
      const cacheHitRatio = totalPromptTokens > 0
        ? Math.round((cacheReadTokens / totalPromptTokens) * 1000) / 1000
        : 0;

      // Multi-model analytics properties
      const modelCount = modelUsage ? Object.keys(modelUsage).length : (params.model ? 1 : 0);
      const isMultiModel = modelCount >= 2;
      let primaryModel: string | null = null;
      let modelBreakdownJson: string | null = null;

      if (isMultiModel && modelUsage) {
        try {
          // Find most expensive model by pricing table estimation
          let maxEstimate = -1;
          for (const [model, usage] of Object.entries(modelUsage)) {
            if (usage.costUsd != null && usage.costUsd > maxEstimate) {
              maxEstimate = usage.costUsd;
              primaryModel = model;
            } else {
              const pricing = getModelPricing(model);
              if (pricing) {
                const estimate = (pricing.output * usage.outputTokens) + (pricing.input * usage.inputTokens);
                if (estimate > maxEstimate) {
                  maxEstimate = estimate;
                  primaryModel = model;
                }
              }
            }
          }
          modelBreakdownJson = JSON.stringify(modelUsage);
        } catch {
          // No-throw: analytics enrichment must not fail the turn tracking
        }
      }

      // Resolve pricing rates for cost audit trail
      // For multi-model turns, set pricingModelResolved to null
      const pricingModelStr = isMultiModel
        ? null
        : (params.model && params.model.includes(' + ')
          ? params.model.split(' + ')[0]
          : params.model) ?? null;
      const pricing = (pricingModelStr ?? primaryModel)
        ? getModelPricing(pricingModelStr ?? primaryModel ?? '')
        : null;
      analytics.track('Agent Turn Completed', {
        ...rest,
        sessionId: hashSessionId(params.sessionId),
        totalPromptTokens,
        cacheHitRatio,
        pricingInputUsdPerMTok: pricing?.input ?? null,
        pricingOutputUsdPerMTok: pricing?.output ?? null,
        pricingCacheReadUsdPerMTok: pricing?.cacheRead ?? null,
        pricingCacheCreationUsdPerMTok: pricing?.cacheCreation ?? null,
        pricingKnown: pricing !== null,
        pricingModelResolved: pricingModelStr,
        ...(isMultiModel ? {
          primaryModel,
          modelCount,
          modelBreakdownJson,
        } : {}),
        // Flatten tool metrics for analytics queryability
        ...(toolMetrics && {
          totalToolCalls: toolMetrics.totalToolCalls,
          failedToolCalls: toolMetrics.failedToolCalls,
          filesCreated: toolMetrics.filesCreated,
          filesEdited: toolMetrics.filesEdited,
          workArtifactsCreated: toolMetrics.workArtifactsCreated ?? 0,
          workArtifactsCreatedByType: toolMetrics.workArtifactsCreatedByType ?? {},
          memoryFilesModified: toolMetrics.memoryFilesModified,
          skillFilesModified: toolMetrics.skillFilesModified,
          // Flatten category counts with prefix
          toolCalls_filesystem: toolMetrics.toolUsageByCategory.filesystem ?? 0,
          toolCalls_shell: toolMetrics.toolUsageByCategory.shell ?? 0,
          toolCalls_network: toolMetrics.toolUsageByCategory.network ?? 0,
          toolCalls_integration: toolMetrics.toolUsageByCategory.integration ?? 0,
          toolCalls_planning: toolMetrics.toolUsageByCategory.planning ?? 0,
          toolCalls_builtin: toolMetrics.toolUsageByCategory.builtin ?? 0,
          // Flatten MCP server usage with prefix
          mcp_gmail: toolMetrics.mcpServerUsage?.gmail ?? 0,
          mcp_google_calendar: toolMetrics.mcpServerUsage?.['google-calendar'] ?? 0,
          mcp_outlook: toolMetrics.mcpServerUsage?.outlook ?? 0,
          mcp_outlook_calendar: toolMetrics.mcpServerUsage?.['outlook-calendar'] ?? 0,
          mcp_notion: toolMetrics.mcpServerUsage?.notion ?? 0,
          mcp_slack: toolMetrics.mcpServerUsage?.slack ?? 0,
          mcp_teams: toolMetrics.mcpServerUsage?.teams ?? 0,
          // Total MCP calls (sum of all MCP servers)
          mcp_total: Object.values(toolMetrics.mcpServerUsage ?? {}).reduce((sum, count) => sum + count, 0),
          // All MCP servers used this turn (sorted, deduped) — queryable via analytics "contains"
          mcp_servers_used: Object.entries(toolMetrics.mcpServerUsage ?? {})
            .filter(([, count]) => count > 0)
            .map(([server]) => sanitizeServerIdForAnalytics(server))
            .sort(),
          // Full per-server breakdown for detailed analysis
          mcp_server_usage_json: JSON.stringify(
            Object.fromEntries(
              Object.entries(toolMetrics.mcpServerUsage ?? {}).map(
                ([server, count]) => [sanitizeServerIdForAnalytics(server), count]
              )
            )
          ),
          // Tool output sizes (proxy for token usage by source)
          totalToolOutputChars: toolMetrics.totalToolOutputChars ?? 0,
          mcpToolOutputChars: toolMetrics.mcpToolOutputChars ?? 0,
          builtinToolOutputChars: toolMetrics.builtinToolOutputChars ?? 0,
        }),
        // Flatten subagent metrics
        ...(subAgentMetrics && {
          usedSubAgents: subAgentMetrics.usedSubAgents,
          subAgentCount: subAgentMetrics.subAgentCount,
          subAgentToolCount: subAgentMetrics.subAgentToolCount,
        }),
        ...(outputShapeMetrics && {
          finalWordCount: outputShapeMetrics.wordCount,
          finalHeadingCount: outputShapeMetrics.headingCount,
          finalBulletCount: outputShapeMetrics.bulletCount,
          finalNumberedListCount: outputShapeMetrics.numberedListCount,
          finalCodeBlockCount: outputShapeMetrics.codeBlockCount,
          finalTableLineCount: outputShapeMetrics.tableLineCount,
          finalLinkCount: outputShapeMetrics.linkCount,
          finalHasSourceSection: outputShapeMetrics.hasSourceSection,
          finalShapeBucket: outputShapeMetrics.shapeBucket,
        }),
        // Auth method and fallback chain tracking
        authMethod: params.authMethod ?? null,
        fallbacks: params.fallbacks ?? null,
        fallbackCount: params.fallbacks?.length ?? 0,
        hadFallback: (params.fallbacks?.length ?? 0) > 0,
      });
    },
    turnError: (params: {
      turnId: string;
      sessionId: string;
      errorType: string;
      errorCode?: string;
      isRetryable: boolean;
      inputTokens?: number;
      outputTokens?: number;
    }) => {
      analytics.track('Agent Turn Error', {
        ...params,
        sessionId: hashSessionId(params.sessionId)
      });
    },
    turnInterrupted: (params: {
      turnId: string;
      sessionId: string;
      elapsedMs: number;
      reason: 'user' | 'timeout' | 'error';
      inputTokens?: number;
      outputTokens?: number;
    }) => {
      analytics.track('Agent Turn Interrupted', {
        ...params,
        sessionId: hashSessionId(params.sessionId)
      });
    },
    messageEditStarted: (messageId: string, sessionId: string) => {
      analytics.track('Message Edit Started', {
        messageId,
        sessionId: hashSessionId(sessionId)
      });
    },
    messageEditCancelled: (messageId: string, sessionId: string) => {
      analytics.track('Message Edit Cancelled', {
        messageId,
        sessionId: hashSessionId(sessionId)
      });
    },
    messageEditSubmitted: (messageId: string, sessionId: string, charDelta: number) => {
      analytics.track('Message Edit Submitted', {
        messageId,
        sessionId: hashSessionId(sessionId),
        charDelta
      });
    },
    attachmentAdded: (sessionId: string, fileExtension: string, sizeBytes: number) => {
      analytics.track('Attachment Added', {
        sessionId: hashSessionId(sessionId),
        fileExtension,
        sizeBytes
      });
    },
    fileMentioned: (sessionId: string, fileCount: number) => {
      analytics.track('File Mentioned', {
        sessionId: hashSessionId(sessionId),
        fileCount
      });
    }
  },

  // Custom MCP Server Connections (manual JSON config via useSettingsFeature)
  // Note: For UI connector cards (95%+ of connections), see tracking.settings.connector* events
  tools: {
    connected: (serverName: string, transport: string, configType: 'managed' | 'custom', isBuiltIn: boolean) => {
      analytics.track('Custom MCP Connected', { serverName, transport, configType, isBuiltIn });
      if (!tracking.checkMilestone('first_tool_connected')) {
        tracking.trackMilestone('first_tool_connected');
      }
    },
    connectionFailed: (serverName: string, transport: string, errorCode: string, errorType: string) => {
      analytics.track('Custom MCP Connection Failed', { serverName, transport, errorCode, errorType });
      captureRendererMessage('Custom MCP Connection Failed', {
        level: 'warning',
        tags: { serverName, transport, errorCode, errorType },
      });
    },
    disconnected: (serverName: string, configType: 'managed' | 'custom') => {
      analytics.track('Custom MCP Disconnected', { serverName, configType });
    },
    inboxConnected: () => {
      analytics.track('Inbox Connected', {});
    },
    /** @deprecated Use inboxConnected */
    taskQueueConnected: () => {
      analytics.track('Inbox Connected', {});
    },
    mcpSummaryLoaded: (status: string, mode: string, serverCount: number, upstreamCount: number, managedConfigActive: boolean) => {
      analytics.track('MCP Summary Loaded', { status, mode, serverCount, upstreamCount, managedConfigActive });
    },
    mcpConfigError: (errorType: string, errorCode?: string) => {
      analytics.track('MCP Config Error', { errorType, errorCode });
      // "Super-MCP not running" is now captured with richer diagnostics in the
      // main process (resolveSuperMcpRouterEntry). Skip renderer Sentry for that
      // case to avoid duplicate noise; keep it for other config errors.
      const isSuperMcpNotRunning =
        errorType === 'load_error' &&
        typeof errorCode === 'string' &&
        (
          errorCode.startsWith('Tools are temporarily unavailable') ||
          errorCode.includes('Super-MCP HTTP server is not running')
        );
      if (!isSuperMcpNotRunning) {
        captureRendererMessage('MCP Config Error', {
          level: 'warning',
          tags: { errorType, ...(errorCode && { errorCode }) },
        });
      }
    }
  },

  // Automations
  automations: {
    created: (scheduleType: string, hasWorkspaceFile: boolean, catchUpIfMissed: boolean, isFirstAutomation: boolean, automationId?: string) => {
      analytics.track('Automation Created', { scheduleType, hasWorkspaceFile, catchUpIfMissed, isFirstAutomation, automationId });
      tracking.workArtifacts.created({
        artifactType: 'automation',
        source: 'automation_builder',
        shared: false,
        automationId,
      });
      if (isFirstAutomation) {
        tracking.trackMilestone('first_automation_created');
      }
    },
    updated: (automationId: string, scheduleType: string, fieldsChanged: string[], enabledChanged: boolean) => {
      analytics.track('Automation Updated', { automationId, scheduleType, fieldsChanged, enabledChanged });
    },
    deleted: (automationId: string, hadRuns: boolean) => {
      analytics.track('Automation Deleted', { automationId, hadRuns });
    },
    enabled: (automationId: string) => {
      analytics.track('Automation Enabled', { automationId });
    },
    disabled: (automationId: string, runCount: number) => {
      analytics.track('Automation Disabled', { automationId, runCount });
    },
    runStarted: (automationId: string, trigger: 'manual' | 'schedule' | 'launch', isFirstRun: boolean) => {
      analytics.track('Automation Run Started', { automationId, trigger, isFirstRun });
    },
    runCompleted: (params: {
      automationId: string;
      status: 'success' | 'failure';
      durationMs: number;
      turnCount: number;
      messagesGenerated: number;
      outputSessionId?: string;
    }) => {
      analytics.track('Automation Run Completed', {
        ...params,
        outputSessionId: params.outputSessionId ? hashSessionId(params.outputSessionId) : undefined
      });
      if (params.status === 'success' && !tracking.checkMilestone('first_automation_run_success')) {
        tracking.trackMilestone('first_automation_run_success');
      }
    },
    runCost: (params: {
      automationId: string;
      automationName: string;
      trigger: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      estimatedCostUsd: number;
      durationMs: number;
      toolCallCount: number;
    }) => {
      analytics.track('Automation Run Cost', params);
    }
  },

  // Voice Interactions
  voice: {
    recordingStarted: (mode: 'voiceMode' | 'textMode', inputMethod: 'tap' | 'hold' | 'hotkey') => {
      analytics.track('Voice Recording Started', { mode, inputMethod });
    },
    recordingStopped: (durationMs: number, stopReason: 'user' | 'timeout' | 'error') => {
      analytics.track('Voice Recording Stopped', { durationMs, stopReason });
    },
    recordingCancelled: (durationMs: number) => {
      analytics.track('Voice Recording Cancelled', { durationMs });
    },
    transcriptionCompleted: (
      latencyMs: number,
      wordCount: number,
      provider: string,
      audioLengthMs: number,
      costProps?: { costUsd: number | null; model: string; source: string; inputSizeBytes: number }
    ) => {
      analytics.track('Voice Transcription Completed', {
        latencyMs,
        wordCount,
        provider,
        audioLengthMs,
        ...(costProps && {
          costUsd: costProps.costUsd,
          model: costProps.model,
          source: costProps.source,
          inputSizeBytes: costProps.inputSizeBytes,
        }),
      });
    },
    transcriptionError: (errorType: string, errorCode: string, provider: string, audioLengthMs: number) => {
      analytics.track('Voice Transcription Error', { errorType, errorCode, provider, audioLengthMs });
    },
    modeActivated: (activationMethod: 'button' | 'hotkey' | 'auto') => {
      analytics.track('Voice Mode Activated', { activationMethod });
    },
    modeDeactivated: (durationMs: number, messagesSpoken: number) => {
      analytics.track('Voice Mode Deactivated', { durationMs, messagesSpoken });
    },
    hotkeyUsed: (accelerator: string, wasRecording: boolean) => {
      analytics.track('Voice Hotkey Used', { accelerator, wasRecording });
    },
    ttsPlaybackStarted: (charCount: number) => {
      analytics.track('TTS Playback Started', { charCount });
    },
    ttsPlaybackCompleted: (durationMs: number, charCount: number) => {
      analytics.track('TTS Playback Completed', { durationMs, charCount });
    },
    ttsPlaybackError: (errorType: string) => {
      analytics.track('TTS Playback Error', { errorType });
    },
    ttsPlaybackInterrupted: (elapsedMs: number, percentPlayed: number) => {
      analytics.track('TTS Playback Interrupted', { elapsedMs, percentPlayed });
    }
  },

  // Inbox
  inbox: {
    itemAdded: (hasReferences: boolean, referenceCount: number, source: string, isFirstItem: boolean, category?: string) => {
      analytics.track('Inbox Item Added', { hasReferences, referenceCount, source, isFirstItem, category: category ?? 'uncategorized' });
    },
    itemExecuted: (itemId: string, mode: 'execute' | 'execute_with_context', outputSessionId: string, isFirstExecution: boolean, ctaLabel?: string) => {
      analytics.track('Inbox Item Executed', {
        itemId,
        mode,
        outputSessionId: hashSessionId(outputSessionId),
        isFirstExecution,
        ...(ctaLabel ? { ctaLabel } : {}),
      });
      if (isFirstExecution) {
        tracking.trackMilestone('first_inbox_item_executed');
      }
    },
    itemExecutionCompleted: (itemId: string, status: 'success' | 'error', durationMs: number, turnCount: number) => {
      analytics.track('Inbox Item Execution Completed', { itemId, status, durationMs, turnCount });
    },
    itemExecutionError: (itemId: string, errorType: string, errorCode: string, durationMs: number) => {
      analytics.track('Inbox Item Execution Error', { itemId, errorType, errorCode, durationMs });
    },
    itemDeleted: (itemId: string, wasExecuted: boolean) => {
      analytics.track('Inbox Item Deleted', { itemId, wasExecuted });
    },
    itemArchived: (itemId: string, ageMs: number, quadrant: string, wasViewed: boolean) => {
      analytics.track('Inbox Item Archived', { itemId, ageMs, quadrant, wasViewed });
    },
    itemRestored: (itemId: string) => {
      analytics.track('Inbox Item Restored', { itemId });
    },
    quadrantChanged: (itemId: string, fromQuadrant: string, toQuadrant: string, method: 'drag' | 'menu' | 'keyboard') => {
      analytics.track('Inbox Quadrant Changed', { itemId, fromQuadrant, toQuadrant, method });
    },
    viewModeSwitched: (mode: string, previousMode: string) => {
      analytics.track('Inbox View Mode Switched', { mode, previousMode });
    },
    emptyStateCtaClicked: (cta: string) => {
      analytics.track('Inbox Empty State CTA Clicked', { cta });
    },
  },
  /** @deprecated Use inbox */
  taskQueue: {
    taskQueued: (hasReferences: boolean, referenceCount: number, source: string, isFirstTask: boolean, category?: string) => {
      analytics.track('Inbox Item Added', { hasReferences, referenceCount, source, isFirstItem: isFirstTask, category: category ?? 'uncategorized' });
    },
    taskExecuted: (itemId: string, mode: 'execute' | 'execute_with_context', outputSessionId: string, isFirstExecution: boolean) => {
      analytics.track('Inbox Item Executed', {
        itemId,
        mode,
        outputSessionId: hashSessionId(outputSessionId),
        isFirstExecution
      });
      if (isFirstExecution) {
        tracking.trackMilestone('first_inbox_item_executed');
      }
    },
    taskExecutionCompleted: (itemId: string, status: 'success' | 'error', durationMs: number, turnCount: number) => {
      analytics.track('Inbox Item Execution Completed', { itemId, status, durationMs, turnCount });
    },
    taskExecutionError: (itemId: string, errorType: string, errorCode: string, durationMs: number) => {
      analytics.track('Inbox Item Execution Error', { itemId, errorType, errorCode, durationMs });
    },
    taskDeleted: (itemId: string, wasExecuted: boolean) => {
      analytics.track('Inbox Item Deleted', { itemId, wasExecuted });
    }
  },

  // Contextual Dashboard
  contextualDashboard: {
    revealOpened: () => {
      analytics.track('Contextual Reveal Opened', {});
    },
    revealClosed: (durationOpenMs: number) => {
      analytics.track('Contextual Reveal Closed', { durationOpenMs });
    },
    suggestionClicked: (suggestionId: string, type: string, urgency: string) => {
      analytics.track('Suggestion Clicked', { suggestionId, type, urgency });
    },
    suggestionsLoaded: (count: number, durationMs: number) => {
      analytics.track('Suggestions Loaded', { count, durationMs });
    }
  },

  // Settings & Configuration
  settings: {
    opened: (source?: 'nav_click' | 'link' | 'keyboard' | 'auto' | 'deep_link') => {
      analytics.track('Settings Opened', { source: source ?? 'nav_click' });
    },
    saved: (changedFields: string[]) => {
      analytics.track('Settings Saved', { changedFields });
    },
    tabSwitched: (tab: string, previousTab?: string) => {
      analytics.track('Settings Tab Switched', { tab, previousTab });
    },
    destinationSwitched: (payload: {
      destination: string;
      interactionType: 'sidebar' | 'search' | 'deep_link' | 'programmatic';
      leafTab: string;
      section?: string;
      redirectedFrom?: { tab?: string; section?: string };
    }) => {
      analytics.track('Settings Destination Switched', payload);
    },
    libraryDirectoryChanged: () => {
      analytics.track('Workspace Directory Changed', {}); // Event name preserved for dashboard compatibility
    },
    modelChanged: (model: string) => {
      analytics.track('Model Changed', { model });
    },
    permissionModeChanged: (mode: string) => {
      analytics.track('Permission Mode Changed', { mode });
    },
    // Safety settings (granular)
    toolPermissionChanged: (level: string, previousLevel: string) => {
      analytics.track('Tool Permission Level Changed', { level, previousLevel });
      if (!tracking.checkMilestone('safety_settings_customized')) {
        tracking.trackMilestone('safety_settings_customized');
      }
    },
    memoryPermissionChanged: (level: string, previousLevel: string) => {
      analytics.track('Memory Permission Level Changed', { level, previousLevel });
      if (!tracking.checkMilestone('memory_settings_customized')) {
        tracking.trackMilestone('memory_settings_customized');
      }
    },
    privacyModeToggled: (enabled: boolean) => {
      analytics.track('Privacy Mode Toggled', { enabled });
    },
    efficiencyModeToggled: (enabled: boolean, source: 'settings' | 'home_offer') => {
      analytics.track('Efficiency Mode Toggled', { enabled, source });
    },
    efficiencyModeOfferDismissed: () => {
      analytics.track('Efficiency Mode Offer Dismissed', {});
    },
    // Connector interactions
    connectorViewed: (connectorName: string, category: string) => {
      analytics.track('Connector Viewed', { connectorName, category });
    },
    connectorConnectStarted: (connectorName: string, category: string, opts?: { connectorType?: 'bundled' | 'custom'; source?: string; isReconnect?: boolean }) => {
      analytics.track('Connector Connect Started', { connectorName, category, ...opts });
    },
    connectorConnected: (connectorName: string, category: string, method: 'oauth' | 'api_key' | 'rebel_assist' | 'manual') => {
      analytics.track('Connector Connected', { connectorName, category, method });
      if (!tracking.checkMilestone('first_connector_connected')) {
        tracking.trackMilestone('first_connector_connected');
      }
    },
    connectorDisconnected: (connectorName: string, wasActive: boolean) => {
      analytics.track('Connector Disconnected', { connectorName, wasActive });
    },
    connectorConnectionFailed: (connectorName: string, category: string, errorType: string, errorMessage?: string, opts?: { connectorType?: 'bundled' | 'custom'; durationMs?: number; lastOauthStep?: string; source?: string }) => {
      analytics.track('Connector Connection Failed', { connectorName, category, errorType, errorMessage, ...opts });
      captureRendererMessage('Connector Connection Failed', {
        level: 'warning',
        tags: { connectorName, category, errorType },
        extra: { errorMessage }
      });
    },
    connectorConfigureWithRebelClicked: (connectorName: string) => {
      analytics.track('Connector Configure With Rebel Clicked', { connectorName });
    },
    messagingPanelConnectCtaClicked: () => {
      analytics.track('Messaging Panel Connect CTA Clicked', { source: 'messaging-panel' });
    },
    messagingChannelInterestClicked: (params: { channel: 'telegram' | 'whatsapp' | 'teams' }) => {
      analytics.track('Messaging Channel Interest Clicked', { channel: params.channel });
    },
    connectorRequestClicked: (source: 'button_row' | 'empty_search' | 'hero_link') => {
      analytics.track('Connector Request Clicked', { source });
    },
    customMcpServerClicked: () => {
      analytics.track('Custom MCP Server Clicked');
    },
    // Spaces management
    spaceAdded: (spaceName: string, spaceType: 'private' | 'shared') => {
      analytics.track('Space Added', { spaceName, spaceType });
    },
    spaceRenamed: (oldName: string, newName: string) => {
      analytics.track('Space Renamed', { oldName, newName });
    },
    spaceDeleted: (spaceName: string) => {
      analytics.track('Space Deleted', { spaceName });
    },
  },

  // Subscription
  subscription: {
    subscribeClicked: (params: { tier: SubscriptionTraitTier; origin: SubscriptionCheckoutOrigin }) => {
      analytics.track('Subscription Subscribe Clicked', params);
    },
    resubscribeClicked: (params: { tier: SubscriptionTraitTier; origin: SubscriptionCheckoutOrigin }) => {
      analytics.track('Subscription Resubscribe Clicked', params);
    },
    upgradeToRogueClicked: (params: { origin: SubscriptionCheckoutOrigin }) => {
      analytics.track('Subscription Upgrade To Rogue Clicked', params);
    },
    manageClicked: (params: { origin: 'settings' | 'resubscribe' }) => {
      analytics.track('Subscription Manage Clicked', params);
    },
    useThisClicked: (params: { target: 'mindstone' | 'byo' }) => {
      analytics.track('Subscription Use This Clicked', params);
    },
    stateTransition: (params: {
      from: SubscriptionTraitStatus | 'none';
      to: SubscriptionTraitStatus | 'none';
      tier: SubscriptionTraitTier;
    }) => {
      analytics.track('Subscription State Transition', params);
    },
    creditMeterThresholdHit: (params: {
      threshold: '80' | '95';
      tier: SubscriptionTraitTier;
    }) => {
      analytics.track('Subscription Credit Meter Threshold Hit', params);
    },
    allowanceThresholdHit: (params: {
      threshold: '75' | '90';
      tier: SubscriptionTraitTier;
    }) => {
      analytics.track('Subscription Allowance Threshold Hit', params);
    },
  },

  // Meeting Bot
  meetingBot: {
    promptShown: (meetingUrl: string, meetingTitle: string) => {
      analytics.track('Meeting Bot Prompt Shown', { meetingUrl, meetingTitle });
    },
    sendClicked: (meetingUrl: string, meetingTitle: string, source: 'indicator' | 'notification' | 'spark' | 'dedup_override') => {
      analytics.track('Meeting Bot Send Clicked', { meetingUrl, meetingTitle, source });
    },
    sendResult: (success: boolean, errorCode?: string) => {
      analytics.track('Meeting Bot Send Result', { success, errorCode });
    },
    skipped: (meetingUrl: string) => {
      analytics.track('Meeting Bot Skipped', { meetingUrl });
    },
    recordingStopped: (botId: string, source: 'cloud' | 'local', reason: 'user' | 'error' | 'meeting_ended') => {
      analytics.track('Meeting Bot Recording Stopped', { botId, source, reason });
    },
    transcriptReady: (source: 'rebel' | 'external' | 'physical', meetingTitle?: string) => {
      analytics.track('Meeting Transcript Ready', { source, meetingTitle });
    },
    dismissed: () => {
      analytics.track('Meeting Bot Dismissed', {});
    },
    prepMeClicked: (meetingTitle: string, hasExistingPrep: boolean) => {
      analytics.track('Meeting Prep Clicked', { meetingTitle, hasExistingPrep });
    },
  },

  // Library / File Operations
  library: {
    opened: (source?: 'nav_click' | 'link' | 'keyboard' | 'auto' | 'deep_link') => {
      analytics.track('Library Opened', { source: source ?? 'nav_click' });
      trackFirstActionIfNeeded('opened_library');
    },
    lensChanged: (payload: { filter: LibraryFilter; view: LibraryView; axis: LensChangedAxis }) => {
      analytics.track('Library Lens Changed', payload);
    },
    fileOpened: (fileExtension: string, source: 'tree' | 'search' | 'quick_open' | 'mention' | 'link') => {
      analytics.track('Library File Opened', { fileExtension, source });
    },
    fileSaved: (fileExtension: string, charCount: number) => {
      analytics.track('Library File Saved', { fileExtension, charCount });
    },
    exported: (format: 'pdf' | 'docx', success: boolean) => {
      analytics.track('Library Exported', { format, success });
    },
    chiefOfStaffOpened: () => {
      analytics.track('Chief of Staff Opened', {});
    },
    profileCtaClicked: (cta: 'interview' | 'view_files', profileCompletionPercent: number) => {
      analytics.track('Profile CTA Clicked', { cta, profileCompletionPercent });
    },
    profileSectionEdited: (section: string, charCount: number, isFirstEdit: boolean, profileCompletionPercent: number) => {
      analytics.track('Profile Section Edited', { section, charCount, isFirstEdit, profileCompletionPercent });
    },
    profileCompletionChanged: (previousPercent: number, newPercent: number, trigger: 'section_edit' | 'conversation') => {
      analytics.track('Profile Completion Changed', { previousPercent, newPercent, trigger });
    },
    profileTimeSpent: (durationMs: number, sectionsViewed: number, sectionsEdited: number) => {
      analytics.track('Profile Time Spent', { durationMs, sectionsViewed, sectionsEdited });
    },
    profileInterviewStarted: () => {
      analytics.track('Profile Interview Started', {});
    },
    fileSortChanged: (sortOrder: 'name' | 'modified') => {
      analytics.track('Library Sort Changed', { sortOrder });
    },
    createFileClicked: () => {
      analytics.track('Library Create File Clicked', {});
    },
    createFolderClicked: () => {
      analytics.track('Library Create Folder Clicked', {});
    },
    skillCardClicked: (skillName: string, skillPath: string) => {
      analytics.track('Library Skill Card Clicked', { skillName, skillPath });
    },
    filePinToggled: (pinned: boolean, itemType: 'file' | 'directory', fileExtension?: string) => {
      analytics.track('Library Item Pin Toggled', { pinned, itemType, fileExtension: fileExtension ?? '' });
    },
    atlas: {
      viewed: (nodeCount: number) => {
        analytics.track('Atlas Viewed', { nodeCount });
      },
      fileOpened: (fileExtension: string) => {
        analytics.track('Atlas File Opened', { fileExtension });
      },
      conversationStarted: (fileCount: number) => {
        analytics.track('Atlas Conversation Started', { fileCount });
      },
      searchUsed: (resultCount: number) => {
        analytics.track('Atlas Search Used', { resultCount });
      },
      spaceIsolated: (spaceName: string) => {
        analytics.track('Atlas Space Isolated', { spaceName });
      },
    },
  },

  // Mind Map (rendered in conversations by the agent)
  mindMap: {
    rendered: (nodeCount: number) => {
      analytics.track('Mind Map Rendered', { nodeCount });
    },
  },

  // Spark / Use Cases
  spark: {
    opened: (source?: 'nav_click' | 'link' | 'keyboard' | 'auto' | 'deep_link') => {
      analytics.track('Spark Opened', { source: source ?? 'nav_click' });
      // Track spark as an onboarding stage on first open (once per install)
      if (!sparkStageTracked) {
        sparkStageTracked = true;
        try { localStorage.setItem(SPARK_STAGE_TRACKED_KEY, 'true'); } catch { /* ignore */ }
        tracking.onboarding.stageEntered('spark');
      }
    },
    useCaseSelected: (useCaseId: string, useCaseTitle: string, isNew: boolean) => {
      analytics.track('Use Case Selected', { useCaseId, useCaseTitle, isNew });
      trackFirstActionIfNeeded('clicked_use_case');
    },
    useCasesGenerated: (count: number, success: boolean) => {
      analytics.track('Use Cases Generated', { count, success });
    },
    skillUsed: (skillPath: string, skillName: string) => {
      analytics.track('Skill Used', buildSkillUseProperties(skillPath, skillName));
      trackFirstActionIfNeeded('clicked_skill');
    },
    // Coaching insights
    coachingInsightViewed: (sessionId: string, category: string, insightAgeHours?: number) => {
      analytics.track('Coaching Insight Viewed', { 
        sessionId: hashSessionId(sessionId), 
        category,
        insightAgeHours,
      });
    },
    coachingInsightActed: (sessionId: string, category: string, insightAgeHours?: number) => {
      analytics.track('Coaching Insight Acted', { 
        sessionId: hashSessionId(sessionId), 
        category,
        insightAgeHours,
      });
      if (!tracking.checkMilestone('first_coaching_acted')) {
        tracking.trackMilestone('first_coaching_acted');
      }
    },
    coachingInsightDismissed: (sessionId: string, category: string, insightAgeHours?: number) => {
      analytics.track('Coaching Insight Dismissed', { 
        sessionId: hashSessionId(sessionId), 
        category,
        insightAgeHours,
      });
    },
    coachingFeedback: (sessionId: string, category: string, feedback: 'helpful' | 'not_helpful', insightAgeHours?: number) => {
      analytics.track('Coaching Insight Feedback', {
        sessionId: hashSessionId(sessionId),
        category,
        feedback,
        insightAgeHours,
      });
    },
    // System improvement suggestions
    systemImprovementActed: (targetType: string, targetName: string) => {
      analytics.track('System Improvement Acted', { targetType, targetName });
    },
    systemImprovementDismissed: (targetType: string, targetName: string) => {
      analytics.track('System Improvement Dismissed', { targetType, targetName });
    },
    // Community highlights
    communityHighlightClicked: (topicTitle: string, topicId: string) => {
      analytics.track('Community Highlight Clicked', { topicTitle, topicId });
    },
    // Meeting prep from Spark
    meetingPrepClicked: (meetingTitle: string, hasPrepFile: boolean) => {
      analytics.track('Meeting Prep Clicked From Spark', { meetingTitle, hasPrepFile });
    },
    // Workflows section
    workflowsSectionExpanded: (totalWorkflows: number) => {
      analytics.track('Workflows Section Expanded', { totalWorkflows });
    },
    workflowsRegenerateClicked: () => {
      analytics.track('Workflows Regenerate Clicked', {});
    },
    // Help topics (Curious? section)
    helpTopicClicked: (topicId: string, topicLabel: string) => {
      analytics.track('Help Topic Clicked', { topicId, topicLabel });
    },
    // Personal goals
    personalGoalsCardClicked: (status: 'not_set' | 'stale') => {
      analytics.track('Personal Goals Card Clicked', { status });
    },
    goalsExpanded: () => {
      analytics.track('Goals Header Expanded', {});
    },
    goalsDismissed: () => {
      analytics.track('Goals Header Dismissed', {});
    },
    // Missed meetings
    missedMeetingsCardClicked: (missedCount: number) => {
      analytics.track('Missed Meetings Card Clicked', { missedCount });
    },
    // Meeting card (individual meeting clicked, not prep)
    meetingCardClicked: (meetingTitle: string, meetingId?: string) => {
      analytics.track('Meeting Card Clicked', { meetingTitle, meetingId });
    },
    // Inbox section in Spark
    inboxSectionClicked: () => {
      analytics.track('Inbox Section Clicked', {});
    },
    // Tutorials footer link
    tutorialsFooterClicked: () => {
      analytics.track('Tutorials Footer Clicked', {});
    },
    // Spaces synthesis
    spacesSynthesisExpanded: () => {
      analytics.track('Spaces Synthesis Expanded', {});
    },
    spacesSynthesisRefreshed: () => {
      analytics.track('Spaces Synthesis Refreshed', {});
    },
    // Community video recommendations
    communityVideoRecs: {
      shown: () => {
        analytics.track('Video Recs Shown', {});
      },
      videoClicked: (videoId: string, headline: string) => {
        analytics.track('Video Rec Clicked', { videoId, headline });
      },
      suppressed: () => {
        analytics.track('Video Recs Suppressed', {});
      },
      unsuppressed: () => {
        analytics.track('Video Recs Unsuppressed', {});
      },
    },
    // Community events nearby
    communityEvent: {
      shown: (type: 'nearby-event' | 'no-event') => {
        analytics.track('Community Event Shown', { type });
      },
      clicked: (eventId: string) => {
        analytics.track('Community Event Clicked', { eventId });
      },
      dismissed: (eventId: string) => {
        analytics.track('Community Event Dismissed', { eventId });
      },
      suppressed: () => {
        analytics.track('Community Event Suppressed', {});
      },
      unsuppressed: () => {
        analytics.track('Community Event Unsuppressed', {});
      },
      speakerCtaClicked: (isPersonalized: boolean) => {
        analytics.track('Community Event Speaker CTA Clicked', { isPersonalized });
      },
      organizerCtaClicked: () => {
        analytics.track('Community Event Organizer CTA Clicked', {});
      },
    },
  },

  heroChoice: {
    generated: (candidateCount: number) => {
      analytics.track('hero_choice_generated', { candidate_count: candidateCount });
    },
    acted: (candidateType: string, headline: string) => {
      analytics.track('hero_choice_acted', { candidate_type: candidateType, headline });
    },
    dismissed: (candidateType: string) => {
      analytics.track('hero_choice_dismissed', { candidate_type: candidateType });
    },
    feedback: (candidateType: string, feedback: string) => {
      analytics.track('hero_choice_feedback', { candidate_type: candidateType, feedback });
    },
  },

  // Tutorials
  tutorials: {
    modalOpened: (source: 'spark_whisper' | 'help_menu' | 'spark_footer' | 'empty_state_whisper') => {
      analytics.track('Tutorials Modal Opened', { source });
    },
    modalClosed: (videosWatchedDuringSession: number, timeSpentMs: number) => {
      analytics.track('Tutorials Modal Closed', { videosWatchedDuringSession, timeSpentMs });
    },
    videoStarted: (videoId: string, videoTitle: string, learningPath: string) => {
      analytics.track('Tutorial Video Started', { videoId, videoTitle, learningPath });
    },
    videoCompleted: (videoId: string, videoTitle: string, learningPath: string) => {
      analytics.track('Tutorial Video Completed', { videoId, videoTitle, learningPath });
      if (!tracking.checkMilestone('first_tutorial_watched')) {
        tracking.trackMilestone('first_tutorial_watched');
      }
      trackFirstActionIfNeeded('watched_tutorial');
    },
    learningPathExpanded: (pathId: string, pathTitle: string) => {
      analytics.track('Learning Path Expanded', { pathId, pathTitle });
    },
    learningPathCompleted: (pathId: string, pathTitle: string, videosInPath: number) => {
      analytics.track('Learning Path Completed', { pathId, pathTitle, videosInPath });
    },
    openedOnYoutube: (videoId?: string) => {
      analytics.track('Tutorial Opened On YouTube', { videoId: videoId ?? 'playlist' });
    },
    whisperShown: (videoId: string, videoTitle: string) => {
      analytics.track('Tutorial Whisper Shown', { videoId, videoTitle });
    },
    whisperClicked: (videoId: string, videoTitle: string) => {
      analytics.track('Tutorial Whisper Clicked', { videoId, videoTitle });
    },
    nudgeShown: (videoId: string, videoTitle: string) => {
      analytics.track('Tutorial Nudge Shown', { videoId, videoTitle, source: 'progress_card' });
    },
    nudgeClicked: (videoId: string, videoTitle: string) => {
      analytics.track('Tutorial Nudge Clicked', { videoId, videoTitle });
    },
    nudgeDismissed: (videoId: string, videoTitle: string) => {
      analytics.track('Tutorial Nudge Dismissed', { videoId, videoTitle });
    },
    emptyStateWhisperShown: (videoId: string, videoTitle: string) => {
      analytics.track('Empty State Whisper Shown', { videoId, videoTitle });
    },
    emptyStateWhisperClicked: (videoId: string, videoTitle: string) => {
      analytics.track('Empty State Whisper Clicked', { videoId, videoTitle });
    },
  },

  // Empty conversation state
  emptyState: {
    shown: () => {
      analytics.track('Empty State Shown');
    },
    starterClicked: (useCaseId: string, useCaseTitle: string) => {
      analytics.track('Empty State Starter Clicked', { useCaseId, useCaseTitle });
    },
  },

  // Unified discovery slot (tutorials + changelog highlights surfaced as one item
  // per slot, alternating per session). These events are additive — the original
  // `tutorials.*` whisper/nudge events still fire for tutorial items so existing
  // dashboards don't regress.
  discovery: {
    whisperShown: (type: 'tutorial' | 'changelog' | 'community-video', itemId: string, itemTitle: string) => {
      analytics.track('discovery_whisper_shown', { type, item_id: itemId, item_title: itemTitle });
    },
    whisperClicked: (type: 'tutorial' | 'changelog' | 'community-video', itemId: string, itemTitle: string) => {
      analytics.track('discovery_whisper_clicked', { type, item_id: itemId, item_title: itemTitle });
    },
    nudgeShown: (type: 'tutorial' | 'changelog' | 'community-video', itemId: string, itemTitle: string) => {
      analytics.track('discovery_nudge_shown', { type, item_id: itemId, item_title: itemTitle });
    },
    nudgeClicked: (type: 'tutorial' | 'changelog' | 'community-video', itemId: string, itemTitle: string) => {
      analytics.track('discovery_nudge_clicked', { type, item_id: itemId, item_title: itemTitle });
    },
    nudgeDismissed: (type: 'tutorial' | 'changelog' | 'community-video', itemId: string, itemTitle: string) => {
      analytics.track('discovery_nudge_dismissed', { type, item_id: itemId, item_title: itemTitle });
    },
  },

  // What's New
  whatsNew: {
    opened: (source: 'spark_quick_link' | 'help_menu' | 'auto_prompt') => {
      analytics.track('Whats New Opened', { source });
    },
    featureClicked: (featureTitle: string, featureId: string) => {
      analytics.track('Whats New Feature Clicked', { featureTitle, featureId });
    },
    closed: (featuresViewed: number, timeSpentMs: number) => {
      analytics.track('Whats New Closed', { featuresViewed, timeSpentMs });
    },
  },

  // Tool & Memory Approvals
  approvals: {
    toolPromptShown: (toolName: string, count: number) => {
      analytics.track('Tool Approval Prompt Shown', { toolName, count });
    },
    toolDecision: (decision: 'allow' | 'deny' | 'allow_session' | 'allow_automation' | 'trust_always', toolName: string) => {
      analytics.track('Tool Approval Decision', { decision, toolName });
    },
    memoryPromptShown: (spaceName: string, count: number) => {
      analytics.track('Memory Approval Prompt Shown', { spaceName, count });
    },
    memoryDecision: (decision: 'save' | 'skip' | 'save_session' | 'save_with_override', spaceName: string, overrideLevel?: string) => {
      analytics.track('Memory Approval Decision', { decision, spaceName, overrideLevel });
    },
    /**
     * Approval-card instrumentation (Phase 1 of approval-card clarity plan).
     *
     * Fires when a given approvalId is first rendered as a card — de-duped per
     * approvalId via `useApprovalInteractionTally.recordFirstSeen`, NOT per
     * component mount. Denominator for the "View Conversation" hypothesis
     * metric. `thinFacets` segments the R17 promotion gate.
     *
     * Properties are metadata only — never `contentPreview` string, tool args,
     * file paths, or raw space names.
     */
    cardViewed: (params: {
      approvalType: 'tool' | 'memory' | 'staged-tool' | 'staged-file';
      blockedBy?: string;
      riskLevel?: 'low' | 'medium' | 'high' | 'needs-review' | 'unrated';
      sharing?: 'private' | 'restricted' | 'company-wide' | 'public' | 'unclear';
      hasContentPreview: boolean;
      hasWithheldPreview: boolean;
      hasWhyFacets: boolean;
      thinFacets: boolean;
    }) => {
      analytics.track('Approval Card Viewed', params);
    },
    /**
     * Fires when the user clicks "View conversation" on an approval card.
     * Primary numerator for the Phase 1 hypothesis metric.
     */
    viewConversationClicked: (params: {
      approvalType: 'tool' | 'memory' | 'staged-tool' | 'staged-file';
      blockedBy?: string;
      riskLevel?: 'low' | 'medium' | 'high' | 'needs-review' | 'unrated';
      sharing?: 'private' | 'restricted' | 'company-wide' | 'public' | 'unclear';
      hasContentPreview: boolean;
      hasWithheldPreview: boolean;
      thinFacets: boolean;
      secondsSinceCardViewed?: number;
    }) => {
      analytics.track('Approval View Conversation Clicked', params);
    },
    /**
     * Fires when the user opens a preview — today always `previewSource:
     * 'dialog'` (MemoryPreviewDialog / StagedFilePreviewDialog). Phase 1 R3
     * will add an inline-expand path that reports `previewSource:
     * 'inline-expand'`.
     */
    previewContentClicked: (params: {
      approvalType: 'tool' | 'memory' | 'staged-tool' | 'staged-file';
      previewSource: 'inline-expand' | 'dialog';
    }) => {
      analytics.track('Approval Preview Content Clicked', params);
    },
    /**
     * Fires when the user expands the "Why?" toggle on an approval card.
     * Tells us whether the Phase 2 R4 structured-facets work is still needed.
     */
    whyExpanded: (params: {
      approvalType: 'tool' | 'memory' | 'staged-tool' | 'staged-file';
      blockedBy?: string;
      reasonLength: number;
    }) => {
      analytics.track('Approval Why Expanded', params);
    },
  },

  // Shared skill collaboration
  skillCollaboration: {
    nudgeShown: (params: {
      skillId: string;
      surface: 'chat_checkpoint' | 'direct_editor';
    }) => {
      analytics.track('skill_nudge_shown', {
        skill_id: params.skillId,
        surface: params.surface,
      });
    },
    nudgeDecision: (params: {
      skillId: string;
      surface: 'chat_checkpoint' | 'direct_editor';
      decision: 'confirmed' | 'declined';
    }) => {
      analytics.track(`skill_nudge_${params.decision}`, {
        skill_id: params.skillId,
        surface: params.surface,
      });
    },
    notificationViewed: (params: {
      skillId: string;
      recipientReason: 'previous_editor' | 'creator_fallback';
    }) => {
      analytics.track('skill_notification_viewed', {
        skill_id: params.skillId,
        recipient_reason: params.recipientReason,
      });
    },
    notificationDismissed: (params: {
      skillId: string;
      recipientReason: 'previous_editor' | 'creator_fallback';
    }) => {
      analytics.track('skill_notification_dismissed', {
        skill_id: params.skillId,
        recipient_reason: params.recipientReason,
      });
    },
  },

  // NPS Survey
  nps: {
    surveyShown: (showCount: number, daysSinceOnboarding: number) => {
      analytics.track('NPS Survey Shown', { showCount, daysSinceOnboarding });
    },
    surveyDismissed: (showCount: number, snoozeDays: number) => {
      analytics.track('NPS Survey Dismissed', { showCount, snoozeDays });
    },
    surveySubmitted: (score: number, promoterType: string, feedbackLength: number) => {
      analytics.track('NPS Survey Submitted', { score, promoterType, feedbackLength });
      tracking.customerFeedback.submitted({
        feedbackType: 'nps',
        score,
        sentiment: promoterType,
        surface: 'nps_survey',
        feedbackLength,
      });
    },
  },

  // Pull-friendly company dashboard metrics
  workArtifacts: {
    created: (params: {
      artifactType: 'draft' | 'brief' | 'report' | 'doc' | 'presentation' | 'spreadsheet' | 'automation' | 'shared_output' | 'file' | 'skill';
      source: string;
      shared?: boolean;
      sessionId?: string;
      turnId?: string;
      automationId?: string;
      fileExtension?: string;
    }) => {
      const outputId = params.automationId
        ?? params.turnId
        ?? params.sessionId
        ?? `${params.source}:${params.artifactType}`;
      const outputType = ['shared_output', 'doc', 'draft', 'brief', 'report', 'file'].includes(params.artifactType)
        ? 'document'
        : params.artifactType;
      analytics.track('Work Output Created', {
        output_id: hashSessionId(outputId),
        output_type: outputType,
        output_format: params.fileExtension?.replace(/^\./, '').toLowerCase() ?? outputType,
        source_surface: params.source,
        shared: params.shared ?? false,
      });
      analytics.track('Work Artifact Created', {
        ...params,
        shared: params.shared ?? false,
        sessionId: params.sessionId ? hashSessionId(params.sessionId) : undefined,
      });
    },
  },

  skills: {
    created: (params: {
      skillId: string;
      skillScope: 'private' | 'shared';
      source: string;
      creatorId?: string | null;
    }) => {
      analytics.track('Skill Created', {
        skillId: params.skillId,
        skillScope: params.skillScope,
        source: params.source,
        creatorId: params.creatorId ?? null,
      });
      tracking.workArtifacts.created({
        artifactType: 'skill',
        source: params.source,
        shared: params.skillScope === 'shared',
        turnId: params.skillId,
      });
    },
  },

  impactStories: {
    submitted: (params: {
      storyId: string;
      workflowType: string;
      impactType: string;
      sourceSessionId?: string;
    }) => {
      analytics.track('Impact Story Submitted', {
        storyId: params.storyId,
        workflowType: params.workflowType,
        impactType: params.impactType,
        approvalStatus: 'pending',
        sourceSessionId: params.sourceSessionId ? hashSessionId(params.sourceSessionId) : undefined,
      });
    },
    approved: (params: {
      storyId: string;
      workflowType?: string;
      impactType?: string;
      approvedBy?: string | null;
    }) => {
      analytics.track('Impact Story Approved', {
        storyId: params.storyId,
        workflowType: params.workflowType,
        impactType: params.impactType,
        approvalStatus: 'approved',
        approvedBy: params.approvedBy ?? null,
        approvedAt: Date.now(),
      });
    },
  },

  customerFeedback: {
    submitted: (params: {
      feedbackType: 'nps' | 'csat' | 'value_checkin' | 'sentiment';
      score?: number;
      sentiment?: string;
      surface: string;
      feedbackLength?: number;
    }) => {
      analytics.track('Customer Feedback Submitted', params);
    },
  },

  // In-app surveys
  survey: {
    shown: (surveyId: string, showCount: number, daysSinceOnboarding: number) => {
      analytics.track('Survey Shown', { surveyId, showCount, daysSinceOnboarding });
    },
    dismissed: (surveyId: string, dismissCount: number, questionReached: number, snoozeDays: number | null) => {
      analytics.track('Survey Dismissed', { surveyId, dismissCount, questionReached, snoozeDays });
    },
    completed: (surveyId: string, questionCount: number, answersGiven: number, totalDurationMs: number, answers: Array<{ questionIndex: number; questionType: string; answer: string | number | null; comment?: string }>) => {
      const truncatedAnswers = answers.map(a => ({
        ...a,
        answer: typeof a.answer === 'string' && a.answer.length > 1000
          ? a.answer.slice(0, 1000)
          : a.answer,
        ...(a.comment ? { comment: a.comment.length > 1000 ? a.comment.slice(0, 1000) : a.comment } : {}),
      }));
      analytics.track('Survey Completed', { surveyId, questionCount, answersGiven, totalDurationMs, answers: truncatedAnswers });
    },
  },

  // Desktop notification prompt
  notificationsPrompt: {
    shown: (daysSinceOnboarding: number) => {
      analytics.track('Desktop Notification Prompt Shown', { daysSinceOnboarding });
    },
    enabled: (daysSinceOnboarding: number) => {
      analytics.track('Desktop Notification Prompt Enabled', { daysSinceOnboarding });
    },
    dismissed: (source: 'secondary_button' | 'dialog_close', daysSinceOnboarding: number) => {
      analytics.track('Desktop Notification Prompt Dismissed', { source, daysSinceOnboarding });
    },
  },

  // Homepage
  homepage: {
    viewed: (userState: string, connectorCount: number, sessionCount: number) => {
      analytics.track('Homepage Viewed', { userState, connectorCount, sessionCount });
    },
    // Chat section
    messageSubmitted: (charCount: number, hasMentions: boolean) => {
      analytics.track('Homepage Message Submitted', { charCount, hasMentions });
    },
    recentSessionClicked: (position: number) => {
      analytics.track('Homepage Recent Session Clicked', { position });
    },
    historyLinkClicked: () => {
      analytics.track('Homepage History Link Clicked', {});
    },
    // Today section
    todayCardCtaClicked: (itemType: 'meeting' | 'inbox' | 'automation' | 'role', action: string, itemId: string) => {
      analytics.track('Homepage Today Card CTA Clicked', { itemType, action, itemId });
    },
    todayCardDismissed: (itemType: 'meeting' | 'inbox' | 'automation' | 'role', itemId: string) => {
      analytics.track('Homepage Today Card Dismissed', { itemType, itemId });
    },
    todayCardUndoDismiss: (itemType: 'meeting' | 'inbox' | 'automation' | 'role', itemId: string) => {
      analytics.track('Homepage Today Card Undo Dismiss', { itemType, itemId });
    },
    todayCardAutoHidden: (itemType: 'meeting' | 'inbox' | 'automation' | 'role', itemId: string) => {
      analytics.track('Homepage Today Card Auto Hidden', { itemType, itemId });
    },
    todayEmptyCtaClicked: (userState: string) => {
      analytics.track('Homepage Today Empty CTA Clicked', { userState });
    },
    todayShowAllClicked: (totalCount: number) => {
      analytics.track('Homepage Today Show All Clicked', { totalCount });
    },
    todayOnboardingContinueClicked: () => {
      analytics.track('Homepage Today Onboarding Continue Clicked', {});
    },
    connectorNudgeShown: (tier: 'zero' | 'below-baseline' | 'enrichment', userAddedCount: number) => {
      analytics.track('Homepage Connector Nudge Shown', { tier, userAddedCount });
    },
    connectorNudgeClicked: (tier: 'zero' | 'below-baseline' | 'enrichment', userAddedCount: number) => {
      analytics.track('Homepage Connector Nudge Clicked', { tier, userAddedCount });
    },
    connectorNudgeDismissed: (tier: 'zero' | 'below-baseline' | 'enrichment', userAddedCount: number) => {
      analytics.track('Homepage Connector Nudge Dismissed', { tier, userAddedCount });
    },
    focusNudgeShown: (meetingCount: number) => {
      analytics.track('Homepage Focus Nudge Shown', { meetingCount });
    },
    focusNudgeClicked: (meetingCount: number) => {
      analytics.track('Homepage Focus Nudge Clicked', { meetingCount });
    },
    focusNudgeDismissed: (dismissCount: number) => {
      analytics.track('Homepage Focus Nudge Dismissed', { dismissCount });
    },
    // Coach section
    coachSuggestionActed: (suggestionId: string, suggestionTitle: string) => {
      analytics.track('Homepage Coach Suggestion Acted', { suggestionId, suggestionTitle });
    },
    coachSuggestionDismissed: (suggestionId: string) => {
      analytics.track('Homepage Coach Suggestion Dismissed', { suggestionId });
    },
    coachCarouselNavigated: (direction: 'prev' | 'next', newIndex: number, totalItems: number) => {
      analytics.track('Homepage Coach Carousel Navigated', { direction, newIndex, totalItems });
    },
    // Daily Spark
    // IMPORTANT: payload may include only the format name and primitive flags.
    // Never include `body`, `captionOverride`, or any spark text — see
    // docs/plans/260512_daily_spark.md § Tracking events (no spark text).
    dailySparkShown: (format: DailySparkFormat) => {
      analytics.track('Daily Spark Shown', { format });
    },
    dailySparkHiddenToday: (format: DailySparkFormat) => {
      analytics.track('Daily Spark Hidden Today', { format });
    },
    dailySparkLessLikeThis: (format: DailySparkFormat) => {
      analytics.track('Daily Spark Less Like This', { format });
    },
    dailySparkSettingsOpened: () => {
      analytics.track('Daily Spark Settings Opened', {});
    },
    // Inactivity return
    inactivityReturnTriggered: (previousSurface: string, idleDurationMs: number) => {
      analytics.track('Homepage Inactivity Return Triggered', {
        previousSurface,
        idleDurationMs,
        idleDurationMinutes: Math.round(idleDurationMs / 60_000),
      });
    },
    userReturnedAfterIdle: (totalAbsenceDurationMs: number, previousSurface: string) => {
      analytics.track('Homepage User Returned After Idle', {
        totalAbsenceDurationMs,
        totalAbsenceDurationMinutes: Math.round(totalAbsenceDurationMs / 60_000),
        previousSurface,
      });
    },
  },

  // Focus surface
  focus: {
    conversationStarted: (promptType: string, meetingCount: number, goalCount: number, isCustom: boolean) => {
      analytics.track('Focus Conversation Started', { promptType, meetingCount, goalCount, isCustom });
    },
  },

  // Navigation & UI Interactions
  navigation: {
    // Tab navigation clicks (main navigation bar)
    tabClicked: (tab: 'home' | 'focus' | 'conversations' | 'spark' | 'library' | 'automations' | 'inbox' | 'team' | 'settings', previousTab?: string) => {
      analytics.track('Navigation Tab Clicked', { tab, previousTab });
      // Track first action after onboarding for relevant tabs
      const tabToAction: Record<string, FirstActionType | undefined> = {
        spark: 'opened_spark',
        library: 'opened_library',
        automations: 'opened_automations',
        inbox: 'opened_inbox',
        settings: 'opened_settings',
      };
      const action = tabToAction[tab];
      if (action) {
        trackFirstActionIfNeeded(action);
      }
    },
    // Top bar element clicks
    scratchpadOpened: () => {
      analytics.track('Scratchpad Opened', {});
    },
    newConversationClicked: (source?: 'header_button' | 'sidebar_button' | 'brand_button' | 'collapsed_tabs' | 'keyboard_shortcut') => {
      analytics.track('New Chat Button Clicked', { source: source ?? 'unknown' });
    },
    quickOpenOpened: () => {
      analytics.track('Quick Open Opened', {});
    },
    // Help menu interactions
    helpMenuOpened: () => {
      analytics.track('Help Menu Opened', {});
    },
    helpMenuItemClicked: (item: 'ask_rebel' | 'community' | 'tutorials' | 'shortcuts' | 'feedback' | 'diagnostics_standard' | 'diagnostics_detailed' | 'check_updates' | 'setup_wizard' | 'troubleshoot') => {
      analytics.track('Help Menu Item Clicked', { item });
    },
    // Onboarding wizard relaunch
    onboardingWizardRelaunched: (source: 'settings' | 'help_menu') => {
      analytics.track('Onboarding Wizard Relaunched', { source });
    },
    // Conversation sidebar actions
    conversationStarred: (sessionId: string) => {
      analytics.track('Conversation Starred', { sessionId: hashSessionId(sessionId) });
    },
    conversationUnstarred: (sessionId: string) => {
      analytics.track('Conversation Unstarred', { sessionId: hashSessionId(sessionId) });
    },
    conversationMarkedDone: (sessionId: string) => {
      analytics.track('Conversation Marked Done', { sessionId: hashSessionId(sessionId) });
    },
    conversationActivated: (sessionId: string) => {
      analytics.track('Conversation Activated', { sessionId: hashSessionId(sessionId) });
    },
    conversationSearchPerformed: (queryLength: number, resultCount: number) => {
      analytics.track('Conversation Search Performed', { queryLength, resultCount });
    },
    sidebarFilterChanged: (filter: string, previousFilter: string) => {
      analytics.track('Sidebar Filter Changed', { filter, previousFilter });
    },
    recencyFilterChanged: (filter: string, previousFilter?: string) => {
      analytics.track('Recency Filter Changed', { filter, previousFilter });
    },
    automationSessionsToggled: (enabled: boolean) => {
      analytics.track('Automation Sessions Toggled', { enabled });
    },
    selectionMenuReply: (source: 'chat' | 'library' | 'document-preview') => {
      analytics.track('Selection Menu Reply Clicked', { source });
    },
    selectionMenuReplyNewChat: (source: 'chat' | 'library' | 'document-preview') => {
      analytics.track('Selection Menu Reply New Chat Clicked', { source });
    },
  },

  /** Conversation sidebar folders (FOX-2987) */
  folders: {
    created: (folderId: string) => {
      analytics.track('folder.created', { folderId });
    },
    deleted: (folderId: string) => {
      analytics.track('folder.deleted', { folderId });
    },
    renamed: (folderId: string) => {
      analytics.track('folder.renamed', { folderId });
    },
  },

  sessionFolder: {
    movedToFolder: (sessionId: string, folderId: string) => {
      analytics.track('session.movedToFolder', {
        sessionId: hashSessionId(sessionId),
        folderId,
      });
    },
    removedFromFolder: (sessionId: string) => {
      analytics.track('session.removedFromFolder', { sessionId: hashSessionId(sessionId) });
    },
  },

  // Conversation interaction strip
  conversation: {
    voiceRepliesToggled: (enabled: boolean) => {
      analytics.track('Voice Replies Toggled', { enabled });
    },
    autoDoneToggled: (enabled: boolean, source: 'click' | 'keyboard' | 'long_press' | 'menu', hasTurnInProgress: boolean) => {
      analytics.track('Auto-Done Toggled', { enabled, source, hasTurnInProgress });
    },
    markDoneNow: (source: 'long_press' | 'keyboard' | 'menu') => {
      analytics.track('Mark Done Now Triggered', { source });
    },
    feedbackSubmitted: (
      sessionId: string,
      rating: number,
      props: {
        voteSequence: number;
        sentiment: 'positive' | 'neutral' | 'negative';
        chips: string[];
        hasComment: true;
        includeDiagnostics: boolean;
        messageCountBucket: string;
      },
    ) => {
      analytics.track('Conversation Feedback Submitted', {
        sessionId: hashSessionId(sessionId),
        rating,
        voteSequence: props.voteSequence,
        sentiment: props.sentiment,
        chips: props.chips,
        hasComment: props.hasComment,
        includeDiagnostics: props.includeDiagnostics,
        messageCountBucket: props.messageCountBucket,
      });
    },
  },

  // Gamification & Achievements
  gamification: {
    // Streaks
    streakMilestoneReached: (days: number, isPersonalBest: boolean) => {
      analytics.track('Streak Milestone Reached', { days, isPersonalBest });
    },
    // Badges
    badgeUnlocked: (badgeId: string, badgeName: string, category: string) => {
      analytics.track('Badge Unlocked', { badgeId, badgeName, category });
    },
    // Fluency Tiers
    tierUnlocked: (tier: string, tierName: string, previousTier?: string) => {
      analytics.track('Tier Unlocked', { tier, tierName, previousTier });
    },
    // Achievement Hub
    achievementHubOpened: (source: 'streak_indicator' | 'time_saved_indicator' | 'badge_toast' | 'spark') => {
      analytics.track('Achievement Hub Opened', { source });
    },
    achievementHubTabSwitched: (tab: 'overview' | 'time' | 'badges' | 'journey', previousTab?: string) => {
      analytics.track('Achievement Hub Tab Switched', { tab, previousTab });
    },
    achievementHubClosed: (activeTab: string, timeSpentMs: number) => {
      analytics.track('Achievement Hub Closed', { activeTab, timeSpentMs });
    },
  },

  // 14-Day Onboarding Journey (post-wizard)
  journey: {
    dayViewed: (day: number, completedDays: number, isComplete: boolean) => {
      analytics.track('Journey Day Viewed', { day, completedDays, isComplete });
    },
    dayStarted: (day: number, dayTitle: string) => {
      analytics.track('Journey Day Started', { day, dayTitle });
    },
    dayCompleted: (day: number, dayTitle: string, totalCompleted: number) => {
      analytics.track('Journey Day Completed', { day, dayTitle, totalCompleted });
      // Track milestones
      if (day === 7 && !tracking.checkMilestone('journey_week_1_complete')) {
        tracking.trackMilestone('journey_week_1_complete');
      }
      if (day === 14 && !tracking.checkMilestone('journey_graduated')) {
        tracking.trackMilestone('journey_graduated');
      }
    },
    graduationShown: (badgeCount: number, totalMinutesSaved: number) => {
      analytics.track('Journey Graduation Shown', { badgeCount, totalMinutesSaved });
    },
    graduationCelebrated: (badgeCount: number, totalMinutesSaved: number) => {
      analytics.track('Journey Graduation Celebrated', { badgeCount, totalMinutesSaved });
    },
  },

  // Onboarding Reveal Tour (post-coach guided tour)
  revealTour: {
    started: () => {
      analytics.track('Reveal Tour Started', {});
    },
    stepViewed: (stepIndex: number, stepTitle: string) => {
      analytics.track('Reveal Tour Step Viewed', { stepIndex, stepTitle });
    },
    completed: (totalSteps: number, timeSpentMs: number) => {
      analytics.track('Reveal Tour Completed', { totalSteps, timeSpentMs });
    },
    skipped: (atStepIndex: number, stepTitle: string) => {
      analytics.track('Reveal Tour Skipped', { atStepIndex, stepTitle });
    },
  },

  // First real task (post-tutorial, non-onboarding task)
  firstRealTask: {
    attempted: (params: {
      taskType: string;
      connectorsUsed: string[];
      success: boolean;
    }) => {
      analytics.track('First Real Task Attempted', {
        taskType: params.taskType,
        connectorsUsed: params.connectorsUsed,
        connectorCount: params.connectorsUsed.length,
        success: params.success,
      });
    },
  },

  // Cost awareness (tracking user engagement with cost-related UI)
  cost: {
    warningShown: (currentCostUsd: number, thresholdUsd: number) => {
      analytics.track('Cost Warning Shown', { currentCostUsd, thresholdUsd });
    },
    limitSet: (limitUsd: number, previousLimitUsd?: number) => {
      analytics.track('Cost Limit Set', { limitUsd, previousLimitUsd });
    },
  },

  // Privacy awareness (tracking engagement with privacy UI elements)
  privacy: {
    indicatorViewed: (privacyLevel: 'private' | 'shared', source: string) => {
      analytics.track('Privacy Indicator Viewed', { privacyLevel, source });
    },
  },

  // User Questions (AskUserQuestion tool)
  userQuestions: {
    shown: (batchId: string, questionCount: number, sessionId: string, purpose?: 'approval_clarification') => {
      analytics.track('User Question Shown', {
        batchId,
        questionCount,
        sessionId: hashSessionId(sessionId),
        purpose,
      });
    },
    answered: (batchId: string, questionCount: number, sessionId: string, purpose?: 'approval_clarification') => {
      analytics.track('User Question Answered', {
        batchId,
        questionCount,
        sessionId: hashSessionId(sessionId),
        purpose,
      });
    },
    skipped: (batchId: string, questionCount: number, sessionId: string, purpose?: 'approval_clarification') => {
      analytics.track('User Question Skipped', {
        batchId,
        questionCount,
        sessionId: hashSessionId(sessionId),
        purpose,
      });
    },
    dismissed: (batchId: string, questionCount: number, sessionId: string, purpose?: 'approval_clarification') => {
      analytics.track('User Question Dismissed', {
        batchId,
        questionCount,
        sessionId: hashSessionId(sessionId),
        purpose,
      });
    },
  },

  // App lifecycle — positive interactivity signal (Class A / C2).
  app: {
    // Fires once per renderer session the first time the UI reaches an
    // interactive state (settings loaded, not blocked by login/onboarding/
    // recovery). `Application Opened` (main process, did-finish-load) fires
    // when the page *loads*, which over-counts blank/stuck renderers as
    // healthy; this event lets a blank/stuck cohort be detected by the
    // event's ABSENCE relative to `Application Opened`. Low-cardinality props
    // only (the same phase/blockingReason already computed for the e2e harness).
    reachedInteractive: (props: { msSinceBoot: number | null; safeMode: boolean }) => {
      analytics.track('App Reached Interactive', props);
    },
  },

};

/**
 * Track the first real (non-tutorial) task attempt after onboarding.
 * Called from turn completion when a successful turn happens outside tutorial sessions.
 */
export const trackFirstRealTaskIfNeeded = (params: {
  taskType: string;
  connectorsUsed: string[];
  success: boolean;
}): void => {
  if (!onboardingCompletedAt || firstRealTaskTracked) return;

  // Only track within 7 days of onboarding completion
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - onboardingCompletedAt > SEVEN_DAYS) {
    firstRealTaskTracked = true;
    try {
      localStorage.setItem(FIRST_REAL_TASK_TRACKED_KEY, 'true');
    } catch {
      // Ignore errors
    }
    return;
  }

  firstRealTaskTracked = true;
  try {
    localStorage.setItem(FIRST_REAL_TASK_TRACKED_KEY, 'true');
  } catch {
    // Ignore errors
  }

  tracking.firstRealTask.attempted(params);
};
