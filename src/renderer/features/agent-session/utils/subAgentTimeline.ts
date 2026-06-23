import type { AgentEvent } from '@shared/types';
import { createMessageSnippet } from '@renderer/utils/formatters';
import { createId } from '@renderer/utils/stringUtils';
import { summarizeFileOperations, type FileOperation } from '@renderer/utils/fileOperations';
import { humanizeToolActivity } from '@rebel/shared';
import {
  formatSubAgentName as coreFormatSubAgentName,
  isSubAgentToolName as coreIsSubAgentToolName,
} from '@core/services/agentTurnReducer/subAgents';
import type { StepToolSummary } from './toolChips';
import type { TaskProgressItem, TurnStepContext } from './turnStepContext';
import { extractTaskProgress } from './turnStepContext';
import { safeParseDetail } from './safeParseDetail';

export const SUB_AGENT_TOOL_NAME = 'Task';
export const AGENT_TOOL_NAME = 'Agent';
export const AGENT_OUTPUT_TOOL_NAME = 'AgentOutputTool';
const SUBAGENT_ROUTING_STATUS_PREFIX = 'routing:subagent:';

const isSubAgentToolName = coreIsSubAgentToolName;

/** Strip leading "ultrathink" keyword from prompt text (redundant noise in display). */
const stripUltrathink = (text: string): string =>
  text.replace(/^\s*ultrathink[\s.,;:!?\n]*/i, '').trim() || text;

export type SubAgentEntryStatus = 'running' | 'completed';

type SubAgentMetadata = {
  label: string;
  subagentType?: string;
  summary?: string;
  prompt?: string;
  model?: string;
  contextMode?: 'scoped' | 'contextual';
  routingEffort?: string;
};

type SubAgentRoutingMetadata = Pick<SubAgentMetadata, 'model' | 'contextMode' | 'routingEffort'>;

type SubAgentInvocation = SubAgentMetadata & {
  id: string;
  toolUseId?: string;
  agentId?: string;
  /** True if this is a background/async agent (won't stream tool events) */
  isBackground: boolean;
  startedAt: number;
  completedAt?: number;
  result?: string;
};

export type SubAgentStepRange = {
  start: number;
  end: number;
};

export type SubAgentTimelineItem = {
  id: string;
  toolUseId?: string;
  label: string;
  subagentType?: string;
  summary?: string;
  prompt?: string;
  result?: string;
  status: SubAgentEntryStatus;
  /** True if this is a background/async agent (won't stream tool events) */
  isBackground: boolean;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  toolSummaries: StepToolSummary[];
  fileSummary?: string | null;
  stepRange: SubAgentStepRange | null;
  /** Human-readable description of what the sub-agent is currently doing */
  currentActivity?: string;
  /** Task progress from this sub-agent's task board (filtered by parentToolUseId) */
  taskProgress?: TaskProgressItem[];
  /** Model used for this sub-agent, when supplied by adaptive routing metadata. */
  model?: string;
  /** Context mode supplied by adaptive routing metadata. */
  contextMode?: 'scoped' | 'contextual';
  /** Effort level supplied by adaptive routing metadata. */
  routingEffort?: string;
};

export type SubAgentTimeline = {
  items: SubAgentTimelineItem[];
  summaryLabel: string;
  tooltip: string;
  totalCount: number;
  runningCount: number;
  toolCount: number;
};

export const formatSubAgentName = coreFormatSubAgentName;

const buildSubAgentSummary = (payload: Record<string, unknown>): string | undefined => {
  const description = typeof payload.description === 'string' ? payload.description.trim() : '';
  if (description) {
    return description;
  }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) {
    return undefined;
  }
  return createMessageSnippet(prompt, 96);
};

const extractRoutingMetadata = (
  payload: Record<string, unknown>,
): SubAgentRoutingMetadata => {
  const routingMeta = payload._routingMeta;
  if (!routingMeta || typeof routingMeta !== 'object') {
    return {};
  }

  const meta = routingMeta as Record<string, unknown>;
  const model = typeof meta.model === 'string' && meta.model.trim()
    ? meta.model
    : undefined;
  const contextMode = meta.contextMode === 'scoped' || meta.contextMode === 'contextual'
    ? meta.contextMode
    : undefined;
  const routingEffort = typeof meta.effort === 'string' && meta.effort.trim()
    ? meta.effort
    : undefined;

  return {
    ...(model ? { model } : {}),
    ...(contextMode ? { contextMode } : {}),
    ...(routingEffort ? { routingEffort } : {}),
  };
};

const parseSubAgentRoutingStatus = (message: string): { toolUseId: string; meta: SubAgentRoutingMetadata } | null => {
  if (!message.startsWith(SUBAGENT_ROUTING_STATUS_PREFIX)) {
    return null;
  }

  const encodedParts = message.slice(SUBAGENT_ROUTING_STATUS_PREFIX.length).split(':');
  if (encodedParts.length < 4) {
    return null;
  }

  try {
    const [encodedToolUseId, encodedModel, encodedContextMode, encodedEffort] = encodedParts;
    const toolUseId = decodeURIComponent(encodedToolUseId);
    const model = decodeURIComponent(encodedModel);
    const contextModeRaw = decodeURIComponent(encodedContextMode);
    const effort = decodeURIComponent(encodedEffort);
    const contextMode = contextModeRaw === 'scoped' || contextModeRaw === 'contextual'
      ? contextModeRaw
      : undefined;

    if (!toolUseId || !model) {
      return null;
    }

    return {
      toolUseId,
      meta: {
        model,
        ...(contextMode ? { contextMode } : {}),
        ...(effort && effort !== 'default' ? { routingEffort: effort } : {}),
      },
    };
  } catch {
    return null;
  }
};

const buildSubAgentRoutingByToolUseId = (events: AgentEvent[]): Map<string, SubAgentRoutingMetadata> => {
  const routingByToolUseId = new Map<string, SubAgentRoutingMetadata>();
  for (const event of events) {
    if (event.type !== 'status' || typeof event.message !== 'string') {
      continue;
    }
    const parsed = parseSubAgentRoutingStatus(event.message);
    if (parsed) {
      routingByToolUseId.set(parsed.toolUseId, parsed.meta);
    }
  }
  return routingByToolUseId;
};

/**
 * Maximum length (in UTF-16 code units) of a single captured field we are
 * willing to hand to `JSON.parse`. The over-budget fallback
 * ({@link extractSubAgentMetadataFromRawDetail}) runs on details that
 * `safeParseDetail` already declined as too large, so an unbounded
 * `JSON.parse("...")` of a huge captured `prompt`/`description` would re-open
 * the very OOM hole Stage 1 closes. Sub-agent metadata we display (type name,
 * short summary) is always small; a field larger than this is never useful
 * here, so we skip it rather than decode it. (Stage 1 F1 — see
 * docs/plans/260616_stuck-library-renderer-oom/PLAN.md.)
 */
const MAX_RAW_FIELD_PARSE_CHARS = 16 * 1024;

const extractJsonStringField = (detail: string, key: string): string | undefined => {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = detail.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match?.[1]) {
    return undefined;
  }

  // BOUNDED: never JSON.parse an oversized captured field. The fallback only
  // runs on already-over-budget details, so a huge prompt/description would
  // otherwise allocate a large decoded copy and defeat the Stage 1 invariant.
  if (match[1].length > MAX_RAW_FIELD_PARSE_CHARS) {
    return undefined;
  }

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
};

const extractSubAgentMetadataFromRawDetail = (detail: string): SubAgentMetadata | null => {
  // Try Task format first: subagent_type
  const subAgentTypeRaw = extractJsonStringField(detail, 'subagent_type');
  if (subAgentTypeRaw?.trim()) {
    const label = formatSubAgentName(subAgentTypeRaw);
    const description = extractJsonStringField(detail, 'description')?.trim();
    const promptRaw = extractJsonStringField(detail, 'prompt');
    const prompt = promptRaw?.trim() ? stripUltrathink(promptRaw.trim()) : undefined;
    const summary = description || (prompt ? createMessageSnippet(prompt, 96) : undefined);

    return { label, subagentType: subAgentTypeRaw, summary, prompt } satisfies SubAgentMetadata;
  }

  // Try Agent format: agent
  const agentNameRaw = extractJsonStringField(detail, 'agent');
  if (agentNameRaw?.trim()) {
    const label = formatSubAgentName(agentNameRaw);
    const promptRaw = extractJsonStringField(detail, 'prompt');
    const prompt = promptRaw?.trim() ? stripUltrathink(promptRaw.trim()) : undefined;
    const summary = prompt ? createMessageSnippet(prompt, 96) : undefined;

    return { label, subagentType: agentNameRaw, summary, prompt } satisfies SubAgentMetadata;
  }

  return null;
};

const extractSubAgentMetadata = (event: AgentEvent): SubAgentMetadata | null => {
  if (
    event.type !== 'tool' ||
    !isSubAgentToolName(event.toolName) ||
    event.stage !== 'start' ||
    !event.detail
  ) {
    return null;
  }

  const parseResult = safeParseDetail(event.detail);
  if (!parseResult.ok) {
    // too-large / malformed → regex-based fallback (bounded work)
    return extractSubAgentMetadataFromRawDetail(event.detail);
  }
  try {
    const parsedDetail = parseResult.value as Record<string, unknown> | null;
    if (parsedDetail && typeof parsedDetail === 'object') {
      const routingMetadata = extractRoutingMetadata(parsedDetail);

      // Task tool format: { subagent_type, description?, prompt? }
      const subAgentTypeRaw = parsedDetail.subagent_type;
      if (typeof subAgentTypeRaw === 'string' && subAgentTypeRaw.trim()) {
        const label = formatSubAgentName(subAgentTypeRaw);
        const summary = buildSubAgentSummary(parsedDetail);
        const promptRaw = typeof parsedDetail.prompt === 'string' ? parsedDetail.prompt : '';
        const prompt = promptRaw.trim() ? stripUltrathink(promptRaw.trim()) : undefined;
        return { label, subagentType: subAgentTypeRaw, summary, prompt, ...routingMetadata } satisfies SubAgentMetadata;
      }

      // Agent tool format: { agent, prompt }
      const agentNameRaw = parsedDetail.agent;
      if (typeof agentNameRaw === 'string' && agentNameRaw.trim()) {
        const label = formatSubAgentName(agentNameRaw);
        const promptRaw = typeof parsedDetail.prompt === 'string' ? parsedDetail.prompt : '';
        const prompt = promptRaw.trim() ? stripUltrathink(promptRaw.trim()) : undefined;
        const summary = prompt ? createMessageSnippet(prompt, 96) : undefined;
        return { label, subagentType: agentNameRaw, summary, prompt, ...routingMetadata } satisfies SubAgentMetadata;
      }
    }
  } catch {
    return extractSubAgentMetadataFromRawDetail(event.detail);
  }

  return extractSubAgentMetadataFromRawDetail(event.detail);
};

const extractAgentIdFromAsyncAck = (detail: string): string | null => {
  const match = detail.match(/agentId:\s*([^\s),;]+)/i);
  return match ? match[1] : null;
};

/**
 * Infer the start time of an orphaned subagent from its earliest child tool event.
 * Returns the timestamp of the first event whose parentToolUseId matches, or null.
 */
const inferSubAgentStartFromChildren = (
  events: AgentEvent[],
  subAgentToolUseId: string,
): number | null => {
  for (const event of events) {
    if (event.type === 'tool' && event.parentToolUseId === subAgentToolUseId) {
      return event.timestamp;
    }
  }
  return null;
};

const buildSubAgentEntries = (events: AgentEvent[]): SubAgentInvocation[] => {
  const invocations: SubAgentInvocation[] = [];
  const pendingByToolUseId = new Map<string, number>();
  const pendingByAgentId = new Map<string, number>();

  events.forEach((event) => {
    if (event.type !== 'tool') {
      return;
    }

    if (event.stage === 'start' && isSubAgentToolName(event.toolName)) {
      const metadata = extractSubAgentMetadata(event) ?? {
        label: 'Sub-agent',
        subagentType: undefined,
        summary: undefined,
        prompt: undefined,
      };

      const invocation: SubAgentInvocation = {
        ...metadata,
        id: event.toolUseId || createId(),
        toolUseId: event.toolUseId,
        isBackground: false,
        startedAt: event.timestamp
      } satisfies SubAgentInvocation;

      invocations.push(invocation);
      if (event.toolUseId) {
        pendingByToolUseId.set(event.toolUseId, invocations.length - 1);
      }
      return;
    }

    // Handle Task tool end events
    if (event.stage === 'end' && event.toolUseId && isSubAgentToolName(event.toolName)) {
      const targetIndex = pendingByToolUseId.get(event.toolUseId);
      if (typeof targetIndex === 'number' && invocations[targetIndex]) {
        // Check if this is a background task acknowledgment, not actual completion.
        // The runtime returns "Async agent launched successfully" immediately for background tasks,
        // but the actual work continues. Don't mark as completed in this case.
        const isBackgroundAcknowledgment = event.detail?.includes('Async agent launched successfully') ||
          event.detail?.includes('working in the background');
        
        if (isBackgroundAcknowledgment) {
          // Extract agentId for tracking async completion via AgentOutputTool
          const agentId = event.detail ? extractAgentIdFromAsyncAck(event.detail) : null;
          // Mark as background agent - won't stream tool events
          invocations[targetIndex] = {
            ...invocations[targetIndex],
            isBackground: true,
            agentId: agentId ?? invocations[targetIndex].agentId
          };
          if (agentId) {
            pendingByAgentId.set(agentId, targetIndex);
          }
          // Leave as running - timer continues until AgentOutputTool reports completion
        } else {
          // Synchronous completion
          invocations[targetIndex] = {
            ...invocations[targetIndex],
            completedAt: event.timestamp,
            result: event.detail || undefined
          } satisfies SubAgentInvocation;
          pendingByToolUseId.delete(event.toolUseId);
        }
      } else {
        // Orphaned end event — no matching start event was found.
        // This can happen when the start event was dropped (e.g., Rebel Core
        // streaming edge case, event compaction, or message processing error).
        // Create a retroactive invocation so the UI still shows a SubAgentPill.
        const inferredStartedAt = inferSubAgentStartFromChildren(events, event.toolUseId);
        invocations.push({
          id: event.toolUseId,
          toolUseId: event.toolUseId,
          label: formatSubAgentName(event.toolName),
          subagentType: undefined,
          summary: undefined,
          prompt: undefined,
          isBackground: false,
          startedAt: inferredStartedAt ?? event.timestamp,
          completedAt: event.timestamp,
          result: event.detail || undefined,
        });
      }
      return;
    }

    // Handle AgentOutputTool end events - these signal async sub-agent completion
    if (event.stage === 'end' && event.toolName === AGENT_OUTPUT_TOOL_NAME && event.detail) {
      const parseResult = safeParseDetail(event.detail);
      if (!parseResult.ok) {
        // too-large / malformed AgentOutputTool detail — skip
        return;
      }
      try {
        const parsed = parseResult.value as Record<string, unknown>;
        const agents = parsed.agents as Record<string, { status?: string }> | undefined;
        if (!agents || typeof agents !== 'object') {
          return;
        }

        for (const [agentId, agentData] of Object.entries(agents)) {
          if (agentData?.status === 'completed') {
            const targetIndex = pendingByAgentId.get(agentId);
            if (typeof targetIndex === 'number' && invocations[targetIndex] && !invocations[targetIndex].completedAt) {
              invocations[targetIndex] = {
                ...invocations[targetIndex],
                completedAt: event.timestamp
              };
              pendingByAgentId.delete(agentId);
            }
          }
        }
      } catch {
        // Invalid JSON in AgentOutputTool detail - skip
      }
    }
  });

  return invocations;
};

const formatSubAgentDisplay = (
  entries: SubAgentInvocation[]
): { display: string; tooltip: string } => {
  if (entries.length === 0) {
    return { display: '', tooltip: '' };
  }

  const connector = ' → ';
  const maxPreview = 3;
  const groupedLabels: string[] = [];
  let index = 0;
  while (index < entries.length && groupedLabels.length < maxPreview) {
    const current = entries[index];
    let count = 1;
    let nextIndex = index + 1;
    while (nextIndex < entries.length && entries[nextIndex].label === current.label) {
      count += 1;
      nextIndex += 1;
    }
    const countSuffix = count > 1 ? ` ×${count}` : '';
    groupedLabels.push(`${current.label}${countSuffix}`);
    index = nextIndex;
  }

  const overflow = entries.length - index;
  const baseDisplay = groupedLabels.join(connector) || entries[0]?.label || '';
  const display = overflow > 0 ? `${baseDisplay} +${overflow}` : baseDisplay;

  const tooltipLines = entries.map((entry) => {
    const statusLabel = entry.completedAt ? 'completed' : 'running';
    const summary = entry.summary ? ` — ${entry.summary}` : '';
    return `${entry.label} (${statusLabel})${summary}`;
  });

  const tooltip = tooltipLines.join('\n') || display;

  return { display, tooltip };
};

type StepWindow = {
  stepNumber: number;
  start: number;
  end: number;
};

const buildStepWindows = (assistantSteps: AgentEvent[]): StepWindow[] => {
  if (!assistantSteps.length) {
    return [];
  }

  return assistantSteps.map((step, index) => ({
    stepNumber: index + 1,
    start: step.timestamp,
    end: index < assistantSteps.length - 1 ? assistantSteps[index + 1].timestamp : Number.POSITIVE_INFINITY
  }));
};

const resolveStepRange = (
  invocation: SubAgentInvocation,
  stepWindows: StepWindow[]
): SubAgentStepRange | null => {
  if (!stepWindows.length) {
    return null;
  }

  const start = invocation.startedAt;
  const end = invocation.completedAt ?? Number.POSITIVE_INFINITY;
  const overlapping = stepWindows.filter((window) => window.start < end && start < window.end);

  if (overlapping.length === 0) {
    if (start < stepWindows[0].start) {
      return { start: stepWindows[0].stepNumber, end: stepWindows[0].stepNumber };
    }
    return null;
  }

  return {
    start: overlapping[0].stepNumber,
    end: overlapping[overlapping.length - 1].stepNumber
  } satisfies SubAgentStepRange;
};

const collectToolSummaries = (
  toolSummariesByStep: Map<number, StepToolSummary[]>,
  range: SubAgentStepRange | null,
  subAgentToolUseId?: string
): StepToolSummary[] => {
  if (!range) {
    return [];
  }
  const summaries: StepToolSummary[] = [];
  for (let step = range.start; step <= range.end; step += 1) {
    const entries = toolSummariesByStep.get(step) ?? [];
    // Filter to only include tools that belong to this sub-agent.
    // Tools executed by this sub-agent have parentToolUseId === subAgentToolUseId.
    const filtered = subAgentToolUseId
      ? entries.filter(entry => entry.parentToolUseId === subAgentToolUseId)
      : entries;
    summaries.push(...filtered);
  }
  return summaries;
};

const collectFileSummary = (
  fileOperationsByStep: Map<number, FileOperation[]>,
  range: SubAgentStepRange | null
): string | null => {
  if (!range) {
    return null;
  }
  const operations: FileOperation[] = [];
  for (let step = range.start; step <= range.end; step += 1) {
    const stepOperations = fileOperationsByStep.get(step) ?? [];
    operations.push(...stepOperations);
  }
  return summarizeFileOperations(operations);
};

/**
 * Derive a human-readable activity string from the latest tool_use:start event
 * belonging to a running sub-agent.
 */
const deriveCurrentActivity = (
  events: AgentEvent[],
  subAgentToolUseId: string | undefined
): string | undefined => {
  if (!subAgentToolUseId) {
    return undefined;
  }
  // Walk events in reverse to find the latest tool start owned by this sub-agent
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event.type === 'tool' &&
      event.stage === 'start' &&
      event.parentToolUseId === subAgentToolUseId
    ) {
      return humanizeToolActivity(event.toolName, event.detail);
    }
  }
  return undefined;
};

/**
 * Extract task progress for a specific sub-agent by filtering events to only
 * those with a matching parentToolUseId, then running the standard extractor.
 */
const collectSubAgentTaskProgress = (
  events: AgentEvent[],
  subAgentToolUseId: string | undefined,
): TaskProgressItem[] => {
  if (!subAgentToolUseId) return [];
  const subAgentEvents = events.filter(
    (e) => e.type === 'tool' && e.parentToolUseId === subAgentToolUseId,
  );
  if (subAgentEvents.length === 0) return [];
  return extractTaskProgress(subAgentEvents);
};

export const buildSubAgentTimeline = (
  events: AgentEvent[],
  context?: TurnStepContext
): SubAgentTimeline | null => {
  const invocations = buildSubAgentEntries(events);
  if (invocations.length === 0) {
    return null;
  }

  const stepWindows = context ? buildStepWindows(context.assistantSteps) : [];
  const toolSummariesByStep = context?.toolSummariesByStep ?? new Map<number, StepToolSummary[]>();
  const fileOperationsByStep = context?.fileOperationsByStep ?? new Map<number, FileOperation[]>();
  const routingByToolUseId = buildSubAgentRoutingByToolUseId(events);

  const items: SubAgentTimelineItem[] = invocations.map((invocation, index) => {
    const routingMeta = invocation.toolUseId ? routingByToolUseId.get(invocation.toolUseId) : undefined;
    const stepRange = resolveStepRange(invocation, stepWindows);
    const toolSummaries = collectToolSummaries(toolSummariesByStep, stepRange, invocation.toolUseId);
    const fileSummary = collectFileSummary(fileOperationsByStep, stepRange);
    const durationMs = invocation.completedAt ? invocation.completedAt - invocation.startedAt : undefined;
    const isRunning = !invocation.completedAt;
    const currentActivity = isRunning
      ? deriveCurrentActivity(events, invocation.toolUseId)
      : undefined;
    const taskProgress = collectSubAgentTaskProgress(events, invocation.toolUseId);

    return {
      id: invocation.id || `${invocation.label}-${index}`,
      toolUseId: invocation.toolUseId,
      label: invocation.label,
      subagentType: invocation.subagentType,
      summary: invocation.summary,
      prompt: invocation.prompt,
      result: invocation.result,
      status: isRunning ? 'running' : 'completed',
      isBackground: invocation.isBackground,
      startedAt: invocation.startedAt,
      completedAt: invocation.completedAt,
      durationMs,
      toolSummaries,
      fileSummary,
      stepRange,
      currentActivity,
      model: invocation.model ?? routingMeta?.model,
      contextMode: invocation.contextMode ?? routingMeta?.contextMode,
      routingEffort: invocation.routingEffort ?? routingMeta?.routingEffort,
      ...(taskProgress.length > 0 ? { taskProgress } : {}),
    } satisfies SubAgentTimelineItem;
  });

  const { display: summaryLabel, tooltip } = formatSubAgentDisplay(invocations);
  const runningCount = items.filter((item) => item.status === 'running').length;
  const toolCount = items.reduce((acc, item) => acc + item.toolSummaries.length, 0);

  return {
    items,
    summaryLabel,
    tooltip,
    totalCount: items.length,
    runningCount,
    toolCount
  } satisfies SubAgentTimeline;
};
