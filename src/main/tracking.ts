import { getPlatformConfig } from '@core/platform';
import { getOrGenerateAnonymousId, trackMainEvent, identifyMainUser } from './analytics';
import { settingsStore } from './settingsStore';
import { getBuildChannel } from '@main/utils/buildChannel';
import { getExtendedContext, getPermissionMode, getPlanMode } from '@core/rebelCore/settingsAccessors';
import type { AppSettings, McpMode } from '@shared/types';
import { isSubAgentTool } from '@shared/utils/eventSanitization';
import { safeParseDetailRecord } from '@shared/utils/safeParseDetail';
import {
  deriveToolCategory,
  deriveFileOperation,
  isMemoryFile,
  isSkillFile,
  getFileExtension,
  extractMcpServer,
  hashSessionId,
  buildAnalyticsAttributionProperties,
  type TurnToolMetrics,
  type TurnSubAgentMetrics,
  type ToolUsageMap,
  type ToolUsageByCategory,
  type McpServerUsage,
  type UserTraits,
  type SubscriptionTraits,
  type SubscriptionTraitTier,
  type SubscriptionTraitStatus,
  type CouncilSkipReason,
  type CouncilBlockedReason,
  type CouncilTrackingEventName,
} from '@shared/trackingTypes';
import type { SubscriptionCheckoutOrigin } from '@shared/ipc/channels/subscription';

const COUNCIL_SKIPPED_MEMBER_EVENT: CouncilTrackingEventName = 'Council Skipped Member';
const COUNCIL_BLOCKED_EVENT: CouncilTrackingEventName = 'Council Blocked';

type WorkArtifactType = 'draft' | 'brief' | 'report' | 'doc' | 'presentation' | 'spreadsheet' | 'automation' | 'shared_output' | 'file' | 'skill';
type PendingFileOperation = { operation: 'create' | 'edit'; filePath: string };
type CreatedWorkArtifact = { filePath: string; artifactType: WorkArtifactType; shared: boolean };

const workArtifactToOutputType = (artifactType: WorkArtifactType): string => {
  if (['shared_output', 'doc', 'draft', 'brief', 'report', 'file'].includes(artifactType)) return 'document';
  return artifactType;
};

const DOCUMENT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'html', 'htm', 'docx', 'pdf', 'rtf']);
const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx']);
const SPREADSHEET_EXTENSIONS = new Set(['csv', 'xls', 'xlsx']);
const INTERNAL_OUTPUT_PATH_SEGMENTS = new Set(['.rebel', 'memory']);

const deriveWorkArtifactType = (filePath: string): WorkArtifactType => {
  const normalized = filePath.toLowerCase();
  if (isSkillFile(filePath)) return 'skill';
  const extension = getFileExtension(filePath);
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    if (normalized.includes('brief')) return 'brief';
    if (normalized.includes('report')) return 'report';
    if (normalized.includes('draft')) return 'draft';
    return 'doc';
  }
  if (PRESENTATION_EXTENSIONS.has(extension)) return 'presentation';
  if (SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
  return 'file';
};

const isInternalOutputPath = (filePath: string): boolean => {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some(part => INTERNAL_OUTPUT_PATH_SEGMENTS.has(part.toLowerCase()));
};

const isTrackableWorkArtifact = (filePath: string): boolean => {
  if (isInternalOutputPath(filePath)) return false;
  if (isSkillFile(filePath)) return true;

  const artifactType = deriveWorkArtifactType(filePath);
  return artifactType !== 'file';
};

const extractWriteResultOperation = (detail: string | undefined): PendingFileOperation['operation'] | null => {
  if (!detail) return null;
  if (/^Created \d+ characters to .+$/i.test(detail.trim())) return 'create';
  if (/^Updated \d+ characters to .+$/i.test(detail.trim())) return 'edit';
  return null;
};

const extractWriteResultPath = (detail: string | undefined): string | null => {
  if (!detail) return null;
  const match = detail.trim().match(/^(?:Created|Updated) \d+ characters to (.+)$/i);
  return match?.[1]?.trim() || null;
};

const extractFilePathFromToolDetail = (detail: string): string | null => {
  if (!detail) return null;
  // BOUNDED via safeParseDetailRecord: an over-budget, malformed, OR non-object
  // valid JSON detail falls back to the cheap regex path extractor — matching
  // the pre-migration try/catch fallback for ≤budget input.
  const result = safeParseDetailRecord(detail);
  if (!result.ok) {
    return extractWriteResultPath(detail);
  }
  const parsed = result.value;
  const candidate = parsed.path ?? parsed.file_path ?? parsed.filepath;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
};

const humanizeSkillSlugForTracking = (slug: string): string => slug
  .replace(/[_-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/\b\w/g, (char) => char.toUpperCase());

const deriveSkillSlugForTracking = (skillPath: string): string => {
  const normalizedPath = skillPath.replace(/\\/g, '/');
  const fileName = normalizedPath.split('/').pop() ?? 'skill';
  if (fileName.toLowerCase() === 'skill.md') {
    return normalizedPath.split('/').at(-2) ?? 'skill';
  }
  return fileName.replace(/\.md$/i, '') || 'skill';
};

export const mainTracking = {
  identifyUser: (
    settings: AppSettings | null,
    subscription?: SubscriptionTraits,
    analyticsIdentity?: {
      organizationId?: string;
      organizationSlug?: string;
      organizationName?: string;
      teamId?: string | null;
      teamName?: string | null;
    },
  ) => {
    const anonymousId = getOrGenerateAnonymousId();
    const traits: Partial<UserTraits> = {
      appVersion: getPlatformConfig().version,
      buildChannel: getBuildChannel(),
      platform: process.platform,
      arch: process.arch,
      voiceProvider: settings?.voice?.provider ?? null,
      permissionMode: (settings ? getPermissionMode(settings) : undefined) ?? 'bypassPermissions',
      mcpMode: 'none',
      hasWorkspace: Boolean(settings?.coreDirectory),
      hasMcpConfig: Boolean(settings?.mcpConfigFile),
      planMode: (settings ? getPlanMode(settings) : undefined) ?? false,
      extendedContext: (settings ? getExtendedContext(settings) : undefined) ?? true,
      onboardingCompleted: settings?.onboardingCompleted ?? false,
      onboardingFirstCompletedAt: null,
      ...buildAnalyticsAttributionProperties({
        companyName: settings?.companyName ?? analyticsIdentity?.organizationName ?? null,
        source: settings?.companyName || analyticsIdentity?.organizationName ? 'settings.companyName' : null,
        organizationId: analyticsIdentity?.organizationId ?? null,
        organizationSlug: analyticsIdentity?.organizationSlug ?? null,
        organizationName: analyticsIdentity?.organizationName ?? null,
        teamId: analyticsIdentity?.teamId ?? null,
        teamName: analyticsIdentity?.teamName ?? null,
      }),
    };

    if (subscription) {
      traits.subscription = subscription;
    }

    const userEmail = settings?.userEmail ?? settingsStore.store.userEmail ?? null;
    const mergedTraits: Partial<UserTraits> & { email?: string } = { ...traits };
    if (userEmail) {
      mergedTraits.email = userEmail;
    }

    identifyMainUser({
      anonymousId,
      ...(userEmail ? { userId: userEmail } : {}),
      traits: mergedTraits as Parameters<typeof identifyMainUser>[0]['traits']
    });
  },

  updateMcpMode: (mode: McpMode) => {
    const anonymousId = getOrGenerateAnonymousId();
    const userEmail = settingsStore.store.userEmail ?? null;
    identifyMainUser({
      anonymousId,
      ...(userEmail ? { userId: userEmail } : {}),
      traits: {
        mcpMode: mode,
        ...(userEmail ? { email: userEmail } : {})
      }
    });
  },

  // Application lifecycle
  applicationOpened: (coldStart: boolean, launchDurationMs: number) => {
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Application Opened',
      properties: {
        version: getPlatformConfig().version,
        coldStart,
        launchDurationMs,
        platform: process.platform,
        arch: process.arch
      }
    });
  },

  applicationQuit: (sessionDurationMs: number, sessionsCount: number) => {
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Application Quit',
      properties: {
        version: getPlatformConfig().version,
        sessionDurationMs,
        sessionsCount
      }
    });
  },

  // Agent File Operations (creates/edits only)
  chatSessionCreated: (params: {
    sessionId: string;
    origin: 'manual' | 'automation';
    isFirstSession: boolean;
  }) => {
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Chat Session Created',
      properties: {
        sessionId: hashSessionId(params.sessionId),
        origin: params.origin,
        isFirstSession: params.isFirstSession,
      }
    });
  },

  agentFileOperation: (params: {
    turnId: string;
    sessionId: string;
    operation: 'create' | 'edit';
    filePath: string;
  }) => {
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Agent File Operation',
      properties: {
        turnId: params.turnId,
        sessionId: hashSessionId(params.sessionId),
        operation: params.operation,
        fileExtension: getFileExtension(params.filePath),
        isMemoryFile: isMemoryFile(params.filePath),
        isSkillFile: isSkillFile(params.filePath)
      }
    });
  },

  workArtifactCreated: (params: {
    filePath: string;
    source: string;
    shared?: boolean;
    sessionId?: string;
    turnId?: string;
  }) => {
    if (!isTrackableWorkArtifact(params.filePath)) {
      return;
    }
    const artifactType = deriveWorkArtifactType(params.filePath);
    const fileExtension = getFileExtension(params.filePath);
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Work Output Created',
      properties: {
        output_id: hashSessionId(params.filePath),
        output_type: workArtifactToOutputType(artifactType),
        output_format: fileExtension.replace(/^\./, '') || artifactType,
        source_surface: params.source,
        shared: params.shared ?? false,
        ...(params.sessionId ? { sessionId: hashSessionId(params.sessionId) } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
      }
    });
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'Work Artifact Created',
      properties: {
        artifactType,
        source: params.source,
        shared: params.shared ?? false,
        ...(params.sessionId ? { sessionId: hashSessionId(params.sessionId) } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        fileExtension,
      }
    });
  },

  skillCreated: (params: {
    skillPath: string;
    skillScope: 'private' | 'shared';
    source: string;
    creatorId?: string | null;
    creatorEmail?: string | null;
    creatorName?: string | null;
    skillTitle?: string | null;
    emitWorkOutput?: boolean;
  }) => {
    const skillSlug = deriveSkillSlugForTracking(params.skillPath);
    const skillTitle = params.skillTitle?.trim() || humanizeSkillSlugForTracking(skillSlug);
    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      ...(params.creatorId ? { userId: params.creatorId } : {}),
      event: 'Skill Created',
      properties: {
        skillId: params.skillPath,
        skillPath: params.skillPath,
        skillSlug,
        skillTitle,
        skillScope: params.skillScope,
        source: params.source,
        creatorId: params.creatorId ?? null,
        creator_id: params.creatorId ?? null,
        creatorUserId: params.creatorId ?? null,
        creator_user_id: params.creatorId ?? null,
        creatorName: params.creatorName ?? null,
        creator_name: params.creatorName ?? null,
        creatorEmail: params.creatorEmail ?? null,
        creator_email: params.creatorEmail ?? null,
        user_id: params.creatorId ?? null,
        user_email: params.creatorEmail ?? null,
        email: params.creatorEmail ?? null,
      }
    });
    if (params.emitWorkOutput ?? true) {
      mainTracking.workArtifactCreated({
        filePath: params.skillPath,
        source: params.source,
        shared: params.skillScope === 'shared',
      });
    }
  },

  // Subscription lifecycle events. Property allow-list is strictly
  // {tier, status, cancelAtPeriodEnd, routingAvailable, origin, subtype, from, to}.
  // Never include keys, key hashes, customer ids, or PII.
  subscription: {
    checkoutStarted: (params: { tier: SubscriptionTraitTier; origin: SubscriptionCheckoutOrigin }) => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Subscription Checkout Started',
        properties: {
          tier: params.tier,
          origin: params.origin
        }
      });
    },

    checkoutCallbackReceived: (params: { status: 'success' | 'cancel'; tier?: SubscriptionTraitTier }) => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Subscription Checkout Callback Received',
        properties: {
          status: params.status,
          ...(params.tier ? { tier: params.tier } : {})
        }
      });
    },

    managedKeyProvisioned: (params: { tier: SubscriptionTraitTier; routingAvailable?: boolean }) => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Subscription Managed Key Provisioned',
        properties: {
          tier: params.tier,
          ...(typeof params.routingAvailable === 'boolean' ? { routingAvailable: params.routingAvailable } : {})
        }
      });
    },

    managedKeyActivated: (params: { tier: SubscriptionTraitTier }) => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Subscription Managed Key Activated',
        properties: {
          tier: params.tier
        }
      });
    },

    stateTransition: (params: {
      from: SubscriptionTraitStatus | 'none';
      to: SubscriptionTraitStatus | 'none';
      tier: SubscriptionTraitTier;
    }) => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Subscription State Transition',
        properties: {
          from: params.from,
          to: params.to,
          tier: params.tier
        }
      });
    },

    portalOpened: () => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Subscription Portal Opened',
        properties: {}
      });
    },

    creditLimitHit: (params: { tier: SubscriptionTraitTier; subtype: 'allowance' | 'spend_cap' }) => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Subscription Credit Limit Hit',
        properties: {
          tier: params.tier,
          subtype: params.subtype
        }
      });
    },

    tierModelsUpdated: (params: { tier: SubscriptionTraitTier; added: string[]; removed: string[] }) => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: 'Subscription Tier Models Updated',
        properties: {
          tier: params.tier,
          added: params.added,
          removed: params.removed
        }
      });
    }
  },

  // Council analytics. Property allow-list is strict and intentionally tiny
  // to avoid leaking model/profile/user/key details.
  council: {
    skippedMember: (params: { skipReason: CouncilSkipReason }) => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: COUNCIL_SKIPPED_MEMBER_EVENT,
        properties: {
          skipReason: params.skipReason,
        },
      });
    },

    blocked: (params: {
      reason: CouncilBlockedReason;
      hadAnthropicKey: boolean;
      candidateCount: number;
    }) => {
      trackMainEvent({
        anonymousId: getOrGenerateAnonymousId(),
        event: COUNCIL_BLOCKED_EVENT,
        properties: {
          reason: params.reason,
          hadAnthropicKey: params.hadAnthropicKey,
          candidateCount: params.candidateCount,
        },
      });
    },
  }
};

// Tool metrics aggregator for a turn
class TurnMetricsAggregator {
  private toolCounts: ToolUsageMap = {};
  private categoryCounts: ToolUsageByCategory = {};
  private mcpServerCounts: McpServerUsage = {};
  private totalCalls = 0;
  private failedCalls = 0;
  private filesCreated = 0;
  private filesEdited = 0;
  private memoryFilesModified = 0;
  private skillFilesModified = 0;
  private subAgentTypes: Set<string> = new Set();
  private subAgentToolCount = 0;
  private currentSubAgentId: string | null = null;
  // Track max output size per tool for context overflow recovery
  private toolMaxOutputSizes: Map<string, number> = new Map();
  // Map tool_use_id to tool_name for correlating results with their tool calls
  private toolUseIdToName: Map<string, string> = new Map();
  private pendingFileOperations: Map<string, PendingFileOperation> = new Map();
  private createdWorkArtifacts: CreatedWorkArtifact[] = [];
  private workArtifactsCreatedByType: Record<string, number> = {};
  // Track total output chars for token usage proxy
  private totalToolOutputChars = 0;
  private mcpToolOutputChars = 0;
  private builtinToolOutputChars = 0;

  recordToolStart(toolName: string, toolUseId?: string, parentToolUseId?: string | null): void {
    this.totalCalls++;
    this.toolCounts[toolName] = (this.toolCounts[toolName] || 0) + 1;
    
    const category = deriveToolCategory(toolName);
    this.categoryCounts[category] = (this.categoryCounts[category] || 0) + 1;

    // Track MCP server usage
    const mcpServer = extractMcpServer(toolName);
    if (mcpServer) {
      this.mcpServerCounts[mcpServer] = (this.mcpServerCounts[mcpServer] || 0) + 1;
    }

    // Track if this is inside a subagent
    if (parentToolUseId) {
      this.subAgentToolCount++;
    }

    // Track subagent invocation - extract type from tool input detail
    if (isSubAgentTool(toolName)) {
      this.currentSubAgentId = toolUseId ?? null;
    }

    // Store tool_use_id → tool_name mapping for result correlation
    if (toolUseId) {
      this.toolUseIdToName.set(toolUseId, toolName);
    }
  }

  /**
   * Record tool start with input detail for subagent type extraction.
   * Called when we have the tool input JSON available.
   */
  recordToolStartWithDetail(toolName: string, toolUseId: string | undefined, parentToolUseId: string | null | undefined, inputDetail: string): void {
    this.recordToolStart(toolName, toolUseId, parentToolUseId);

    const operation = deriveFileOperation(toolName);
    const filePath = operation ? extractFilePathFromToolDetail(inputDetail) : null;
    if (toolUseId && operation && filePath) {
      this.pendingFileOperations.set(toolUseId, { operation, filePath });
    }
    
    // Extract subagent type from Task/Agent tool INPUT (not output).
    // BOUNDED via safeParseDetail: skip the whole-input parse for an over-budget
    // detail (the agent's composed prompt can be huge) — same effect as a parse
    // failure (no subagent type recorded). The subagent type is always small.
    if (isSubAgentTool(toolName) && inputDetail) {
      const result = safeParseDetailRecord(inputDetail);
      if (result.ok) {
        const parsed = result.value;
        const subagentType = parsed.subagent_type ?? parsed.agent;
        if (typeof subagentType === 'string' && subagentType.trim()) {
          this.subAgentTypes.add(subagentType.trim());
        }
      }
    }
  }

  /**
   * Look up tool name by tool_use_id (used when processing tool results)
   */
  getToolNameByUseId(toolUseId: string): string | undefined {
    return this.toolUseIdToName.get(toolUseId);
  }

  recordToolEnd(toolName: string, detail: string, isError: boolean, toolUseId?: string): void {
    this.recordToolEndWithSize(toolName, detail?.length ?? 0, isError, toolUseId, detail);
  }

  /**
   * Record tool completion with explicit output size.
   * Used when we have accurate size info (e.g., from Super-MCP telemetry).
   */
  recordToolEndWithSize(toolName: string, outputSize: number, isError: boolean, toolUseId?: string, detail?: string): void {
    if (isError) {
      this.failedCalls++;
    }

    // Track max output size for this tool (for context overflow recovery)
    const currentMax = this.toolMaxOutputSizes.get(toolName) ?? 0;
    if (outputSize > currentMax) {
      this.toolMaxOutputSizes.set(toolName, outputSize);
    }

    // Track total output chars (proxy for token usage)
    this.totalToolOutputChars += outputSize;
    const mcpServer = extractMcpServer(toolName);
    if (mcpServer) {
      this.mcpToolOutputChars += outputSize;
    } else {
      this.builtinToolOutputChars += outputSize;
    }

    // Track successful file operations (creates/edits only). Prefer the input
    // path captured at tool start; tool results often omit it.
    const operation = deriveFileOperation(toolName);
    const pending = toolUseId ? this.pendingFileOperations.get(toolUseId) : undefined;
    const detailFilePath = detail ? extractFilePathFromToolDetail(detail) : null;
    const filePath = detailFilePath ?? pending?.filePath ?? null;
    const detailOperation = extractWriteResultOperation(detail);
    const resolvedOperation = detailOperation ?? pending?.operation ?? operation;
    if (!isError && resolvedOperation && filePath) {
      if (resolvedOperation === 'create') {
        this.filesCreated++;
        if (isTrackableWorkArtifact(filePath)) {
          const artifactType = deriveWorkArtifactType(filePath);
          this.createdWorkArtifacts.push({
            filePath,
            artifactType,
            shared: isSkillFile(filePath),
          });
          this.workArtifactsCreatedByType[artifactType] = (this.workArtifactsCreatedByType[artifactType] ?? 0) + 1;
        }
      } else if (resolvedOperation === 'edit') {
        this.filesEdited++;
      }

      if (isMemoryFile(filePath)) {
        this.memoryFilesModified++;
      }
      if (isSkillFile(filePath)) {
        this.skillFilesModified++;
      }
    }
    if (toolUseId) {
      this.pendingFileOperations.delete(toolUseId);
    }
  }

  getToolMetrics(): TurnToolMetrics {
    return {
      toolUsage: { ...this.toolCounts },
      toolUsageByCategory: { ...this.categoryCounts },
      mcpServerUsage: { ...this.mcpServerCounts },
      totalToolCalls: this.totalCalls,
      failedToolCalls: this.failedCalls,
      filesCreated: this.filesCreated,
      filesEdited: this.filesEdited,
      workArtifactsCreated: this.createdWorkArtifacts.length,
      workArtifactsCreatedByType: { ...this.workArtifactsCreatedByType },
      memoryFilesModified: this.memoryFilesModified,
      skillFilesModified: this.skillFilesModified,
      totalToolOutputChars: this.totalToolOutputChars,
      mcpToolOutputChars: this.mcpToolOutputChars,
      builtinToolOutputChars: this.builtinToolOutputChars
    };
  }

  getSubAgentMetrics(): TurnSubAgentMetrics {
    return {
      usedSubAgents: this.subAgentTypes.size > 0,
      subAgentCount: this.subAgentTypes.size,
      subAgentTypes: [...this.subAgentTypes],
      subAgentToolCount: this.subAgentToolCount
    };
  }

  getCreatedWorkArtifacts(): CreatedWorkArtifact[] {
    return [...this.createdWorkArtifacts];
  }

  /**
   * Get suggested output limits for tools based on compaction depth.
   * Progressive escalation: deeper compaction = more tools limited more aggressively.
   * 
   * - Depth 1: Top 2 tools, cut to 50%
   * - Depth 2+: Top 5 tools, cut to 25%
   * 
   * @param depth - compaction depth (1 = first retry, 2 = second retry)
   * @returns Array of {toolName, currentSize, suggestedLimit} sorted by size descending
   */
  getToolLimitSuggestions(depth: number): Array<{ toolName: string; currentSize: number; suggestedLimit: number }> {
    const config = depth >= 2 
      ? { topN: 5, divisor: 4 }   // Depth 2+: top 5 tools, cut to 25%
      : { topN: 2, divisor: 2 };  // Depth 1: top 2 tools, cut to 50%
    
    const tools = Array.from(this.toolMaxOutputSizes.entries())
      .map(([name, size]) => ({ name, size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, config.topN);
    
    // Minimum useful limit (10k chars ≈ 2.5k tokens)
    const MIN_LIMIT = 10000;
    
    return tools.map(t => ({
      toolName: t.name,
      currentSize: t.size,
      suggestedLimit: Math.max(Math.floor(t.size / config.divisor), MIN_LIMIT),
    }));
  }

  reset(): void {
    this.toolCounts = {};
    this.categoryCounts = {};
    this.mcpServerCounts = {};
    this.totalCalls = 0;
    this.failedCalls = 0;
    this.filesCreated = 0;
    this.filesEdited = 0;
    this.memoryFilesModified = 0;
    this.skillFilesModified = 0;
    this.subAgentTypes.clear();
    this.subAgentToolCount = 0;
    this.currentSubAgentId = null;
    this.toolMaxOutputSizes.clear();
    this.toolUseIdToName.clear();
    this.pendingFileOperations.clear();
    this.createdWorkArtifacts = [];
    this.workArtifactsCreatedByType = {};
    this.totalToolOutputChars = 0;
    this.mcpToolOutputChars = 0;
    this.builtinToolOutputChars = 0;
  }
}

// Store aggregators by turn ID
const turnAggregators = new Map<string, TurnMetricsAggregator>();

export const getTurnAggregator = (turnId: string): TurnMetricsAggregator => {
  let aggregator = turnAggregators.get(turnId);
  if (!aggregator) {
    aggregator = new TurnMetricsAggregator();
    turnAggregators.set(turnId, aggregator);
  }
  return aggregator;
};

export const cleanupTurnAggregator = (turnId: string): void => {
  turnAggregators.delete(turnId);
};
