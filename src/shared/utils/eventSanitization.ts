import type { AgentEvent, ImageContentBlock, ImageRef } from '@shared/types';
import { SANITIZATION_POLICY_FROM_MANIFEST } from '@shared/contracts/agentEventManifest';
import {
  safeParseDetail,
  MAX_STRUCTURED_DETAIL_PARSE_BYTES,
} from '@shared/utils/safeParseDetail';

const MAX_DETAIL_LENGTH = 10_000;
const TASK_PROMPT_PREVIEW_LENGTH = 2_000;
const TASK_DESCRIPTION_PREVIEW_LENGTH = 512;

export const isSubAgentTool = (toolName: string): boolean =>
  toolName === 'Task' || toolName.endsWith('/Task') ||
  toolName === 'Agent' || toolName.endsWith('/Agent');

/** Tool names whose end events carry a `tasks` snapshot the UI needs for MissionProgressCard. */
const TASK_SNAPSHOT_TOOL_NAMES = new Set(['TaskList', 'TaskCreate', 'TaskUpdate']);

const buildTruncationMarker = (omittedCount: number): string =>
  `... [truncated, ${omittedCount} chars omitted]`;

const truncateWithMarker = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 0) {
    return '';
  }

  const markerAtZeroPrefix = buildTruncationMarker(value.length);
  if (markerAtZeroPrefix.length >= maxLength) {
    return value.slice(0, maxLength);
  }

  let prefixLength = maxLength;
  let nextPrefixLength = prefixLength;

  do {
    prefixLength = nextPrefixLength;
    const omittedCount = Math.max(0, value.length - prefixLength);
    const marker = buildTruncationMarker(omittedCount);
    nextPrefixLength = Math.max(0, maxLength - marker.length);
  } while (nextPrefixLength !== prefixLength);

  const omittedCount = Math.max(0, value.length - prefixLength);
  return `${value.slice(0, prefixLength)}${buildTruncationMarker(omittedCount)}`;
};

const toSubAgentStartPreviewDetail = (detail: string): string | null => {
  // BOUNDED via safeParseDetail at the structured budget (1 MiB) — generous for
  // realistic sub-agent prompts, but a pathological >1MiB detail returns null,
  // and the caller (sanitizeToolDetail) then truncates to MAX_DETAIL_LENGTH.
  const result = safeParseDetail(detail, { maxBytes: MAX_STRUCTURED_DETAIL_PARSE_BYTES });
  if (!result.ok) {
    return null;
  }
  try {
    const parsed = result.value as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const compact: Record<string, unknown> = {
      __detailTruncated: true,
      __originalDetailLength: detail.length,
    };

    // Task tool format: { subagent_type, description?, prompt?, run_in_background? }
    if (typeof parsed.subagent_type === 'string' && parsed.subagent_type.trim()) {
      compact.subagent_type = truncateWithMarker(parsed.subagent_type.trim(), 128);
    }

    // Agent tool format: { agent, prompt }
    if (typeof parsed.agent === 'string' && parsed.agent.trim()) {
      compact.agent = truncateWithMarker(parsed.agent.trim(), 128);
    }

    if (typeof parsed.description === 'string' && parsed.description.trim()) {
      compact.description = truncateWithMarker(parsed.description.trim(), TASK_DESCRIPTION_PREVIEW_LENGTH);
    }

    if (typeof parsed.prompt === 'string' && parsed.prompt.trim()) {
      compact.prompt = truncateWithMarker(parsed.prompt.trim(), TASK_PROMPT_PREVIEW_LENGTH);
    }

    if (typeof parsed.run_in_background === 'boolean') {
      compact.run_in_background = parsed.run_in_background;
    }

    let compactDetail = JSON.stringify(compact, null, 2);
    if (compactDetail.length <= MAX_DETAIL_LENGTH) {
      return compactDetail;
    }

    if (typeof compact.prompt === 'string') {
      delete compact.prompt;
      compactDetail = JSON.stringify(compact, null, 2);
      if (compactDetail.length <= MAX_DETAIL_LENGTH) {
        return compactDetail;
      }
    }

    const agentIdentifier = typeof compact.subagent_type === 'string'
      ? compact.subagent_type
      : typeof compact.agent === 'string'
        ? compact.agent
        : 'Sub-agent';

    const minimalDetail: Record<string, unknown> = {
      __detailTruncated: true,
      __originalDetailLength: detail.length,
    };

    if (typeof compact.subagent_type === 'string') {
      minimalDetail.subagent_type = agentIdentifier;
    } else {
      minimalDetail.agent = agentIdentifier;
    }

    return JSON.stringify(minimalDetail, null, 2);
  } catch {
    return null;
  }
};

/**
 * Compact a task-snapshot end event (TaskList/TaskCreate/TaskUpdate) by stripping
 * verbose fields from each task while preserving the `tasks` array with the fields
 * the UI needs: id, title, status, priority, owner, kind, parallelGroup.
 *
 * `kind` matters because the renderer's `toTaskFromTaskList` filters out
 * orchestration tasks (subagent delegations, SummarizeResult result tasks);
 * stripping it leaks those rows into the planning panel.
 *
 * `parallelGroup` matters because the planning panel uses it to render
 * concurrently-executing tasks as a single visual cluster.
 */
const slimTaskFields = (t: Record<string, unknown>): Record<string, unknown> => {
  const slim: Record<string, unknown> = {};
  for (const key of ['id', 'title', 'status', 'priority', 'owner', 'kind', 'parallelGroup']) {
    if (t[key] !== undefined) slim[key] = t[key];
  }
  if (typeof t.description === 'string' && t.description.trim()) {
    slim.description = truncateWithMarker(t.description.trim(), 200);
  }
  if (typeof t.notes === 'string' && t.notes.trim()) {
    slim.notes = truncateWithMarker(t.notes.trim(), 150);
  }
  if (Array.isArray(t.blockers) && t.blockers.length > 0 && t.blockers.every((b: unknown) => typeof b === 'string')) {
    slim.blockers = t.blockers;
  }
  return slim;
};

const toTaskSnapshotCompactDetail = (detail: string): string | null => {
  // BOUNDED via safeParseDetail at the structured budget (1 MiB) — a pathological
  // >1MiB task snapshot returns null, and sanitizeToolDetail then truncates to
  // MAX_DETAIL_LENGTH.
  const parseResult = safeParseDetail(detail, { maxBytes: MAX_STRUCTURED_DETAIL_PARSE_BYTES });
  if (!parseResult.ok) return null;
  try {
    const parsed = parseResult.value as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;

    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : null;
    if (!tasks) return null;

    const compactTasks = tasks.map((task: unknown) => {
      if (typeof task !== 'object' || task === null) return task;
      return slimTaskFields(task as Record<string, unknown>);
    });

    const compact: Record<string, unknown> = {
      __detailTruncated: true,
      __originalDetailLength: detail.length,
    };
    if (typeof parsed.summary === 'string') compact.summary = parsed.summary;
    if (typeof parsed.task === 'object' && parsed.task !== null) {
      compact.task = slimTaskFields(parsed.task as Record<string, unknown>);
    }
    compact.tasks = compactTasks;

    const result = JSON.stringify(compact, null, 2);
    if (result.length <= MAX_DETAIL_LENGTH) return result;

    // Still too large (unusual) -- drop individual task and summary, keep tasks array only
    const minimal: Record<string, unknown> = {
      __detailTruncated: true,
      __originalDetailLength: detail.length,
      tasks: compactTasks,
    };
    return JSON.stringify(minimal, null, 2);
  } catch {
    return null;
  }
};

const sanitizeToolDetail = (event: Extract<AgentEvent, { type: 'tool' }>): string => {
  if (event.detail.length <= MAX_DETAIL_LENGTH) {
    return event.detail;
  }

  if (event.stage === 'start' && isSubAgentTool(event.toolName)) {
    const previewDetail = toSubAgentStartPreviewDetail(event.detail);
    if (previewDetail) {
      return previewDetail;
    }
  }

  if (event.stage === 'end' && TASK_SNAPSHOT_TOOL_NAMES.has(event.toolName)) {
    const compactDetail = toTaskSnapshotCompactDetail(event.detail);
    if (compactDetail) {
      return compactDetail;
    }
  }

  return truncateWithMarker(event.detail, MAX_DETAIL_LENGTH);
};

/**
 * Sanitization strategy registry — R2 Stage 3a-L2 cutover (2026-05-01).
 *
 * The manifest's `sanitization` axis (per-variant) names a strategy from this
 * registry; the dispatcher resolves the name to a function at sanitization
 * time. The manifest stores the name (string), not the function, so that the
 * registry can grow without bumping the manifest type (see `SanitizationStrategy`
 * docstring at `agentEventManifestAxes.ts:37-49`).
 *
 * Adding a new strategy:
 *   1. Add a new manifest value at the relevant entry's `sanitization` axis.
 *   2. Add a corresponding key + function here.
 *   3. The fail-closed resolver below catches any mismatch at runtime.
 *
 * Pre-cutover behavior (preserved verbatim per Stage A parity):
 *   - non-tool events → pass-through (returned unchanged, identity-preserving)
 *   - tool events with detail.length <= 10k → pass-through (fast-path)
 *   - tool events with detail.length > 10k → truncate-tool-detail-with-subagent-identity
 */
const passThrough = (event: AgentEvent): AgentEvent => event;

type ToolEvent = Extract<AgentEvent, { type: 'tool' }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isImageRef = (value: unknown): value is ImageRef => {
  if (!isRecord(value)) return false;
  return (
    typeof value.assetId === 'string'
    && typeof value.mimeType === 'string'
    && typeof value.byteSize === 'number'
  );
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const sanitizeToolResultContentImages = (
  content: unknown[] | undefined,
  topLevelImageRefs: Array<ImageRef | null> | undefined,
): { content?: unknown[]; changed: boolean } => {
  if (!content) return { changed: false };

  let changed = false;
  let imageBlockIndex = 0;

  const sanitizedContent = content.map((block) => {
    if (!isRecord(block) || block.type !== 'image') {
      return block;
    }

    const correspondingTopLevelRef = topLevelImageRefs?.[imageBlockIndex];
    imageBlockIndex += 1;

    const blockRef = isImageRef(block.imageRef) ? block.imageRef : undefined;
    const imageRef = blockRef ?? correspondingTopLevelRef;
    if (!imageRef) {
      return block;
    }

    const hasInlineSource = hasOwn(block, 'source') || hasOwn(block, 'data');
    const needsImageRefBackfill = blockRef === undefined;
    if (!hasInlineSource && !needsImageRefBackfill) {
      return block;
    }

    const sanitizedBlock: Record<string, unknown> = {
      ...block,
      imageRef,
    };
    delete sanitizedBlock.source;
    delete sanitizedBlock.data;
    changed = true;
    return sanitizedBlock;
  });

  return changed ? { content: sanitizedContent, changed } : { changed: false };
};

const sanitizeTopLevelImageContent = (
  imageContent: ImageContentBlock[] | undefined,
  imageRef: Array<ImageRef | null> | undefined,
): { imageContent?: ImageContentBlock[]; changed: boolean } => {
  if (!imageContent || !imageRef || imageRef.length === 0) {
    return { changed: false };
  }

  let changed = false;
  const stripped = imageContent.map((block, index) => {
    if (!imageRef[index]) {
      return block;
    }
    if (!block.data) {
      return block;
    }
    changed = true;
    return {
      ...block,
      data: '',
    };
  });

  return changed ? { imageContent: stripped, changed } : { changed: false };
};

export const sanitizeToolImagePayloadForRefs = (event: ToolEvent): ToolEvent => {
  const topLevelResult = sanitizeTopLevelImageContent(event.imageContent, event.imageRef);
  const toolResultContent = sanitizeToolResultContentImages(
    event.toolResult?.content,
    event.imageRef,
  );

  if (!topLevelResult.changed && !toolResultContent.changed) {
    return event;
  }

  const sanitized: ToolEvent = { ...event };
  if (topLevelResult.changed) {
    if (topLevelResult.imageContent) {
      sanitized.imageContent = topLevelResult.imageContent;
    } else {
      delete sanitized.imageContent;
    }
  }

  if (toolResultContent.changed) {
    sanitized.toolResult = {
      ...event.toolResult,
      content: toolResultContent.content,
    };
  }

  return sanitized;
};

const truncateToolDetailWithSubagentIdentity = (event: AgentEvent): AgentEvent => {
  if (event.type !== 'tool') return event;
  if (event.detail.length <= MAX_DETAIL_LENGTH) return event;
  return {
    ...event,
    detail: sanitizeToolDetail(event),
  };
};

const SANITIZATION_STRATEGIES = {
  'pass-through': passThrough,
  'truncate-tool-detail-with-subagent-identity': truncateToolDetailWithSubagentIdentity,
} as const;

type SanitizationStrategyName = keyof typeof SANITIZATION_STRATEGIES;

/**
 * Resolve a manifest-declared strategy name to its registry function.
 *
 * Fail-closed: if the manifest names a strategy that doesn't exist in the
 * registry (e.g., a new manifest entry was added without a corresponding
 * registry update), throw rather than silently fall back to pass-through.
 * Silent fall-back to pass-through would be a memory-safety regression
 * (unbounded `tool.detail` growth in the renderer's session-store).
 *
 * Uses `Object.hasOwn` rather than `'name' in registry` to avoid
 * Object.prototype-key spoofs (e.g., a manifest value of `'toString'` would
 * resolve to `Object.prototype.toString` under a naive `in` check, bypassing
 * the fail-closed guard).
 */
const resolveStrategy = (
  strategyName: string,
): typeof SANITIZATION_STRATEGIES[SanitizationStrategyName] => {
  if (Object.hasOwn(SANITIZATION_STRATEGIES, strategyName)) {
    return SANITIZATION_STRATEGIES[strategyName as SanitizationStrategyName];
  }
  throw new Error(
    `eventSanitization: unknown sanitization strategy "${strategyName}" — ` +
      'manifest names a strategy not registered in SANITIZATION_STRATEGIES. ' +
      'Add a corresponding registry entry at src/shared/utils/eventSanitization.ts.',
  );
};

const dispatchSanitization = (event: AgentEvent): AgentEvent => {
  // `Object.hasOwn` guards against Object.prototype-key spoofs: a forward-version
  // event with `type === 'toString'` would otherwise resolve to
  // `Object.prototype.toString` (a function) under a plain index-then-undefined
  // check, defeating the unknown-variant preservation precedent from
  // `eventCompaction.ts`.
  if (!Object.hasOwn(SANITIZATION_POLICY_FROM_MANIFEST, event.type)) {
    return event;
  }
  const strategyName = SANITIZATION_POLICY_FROM_MANIFEST[
    event.type as keyof typeof SANITIZATION_POLICY_FROM_MANIFEST
  ];
  const sanitized = resolveStrategy(strategyName)(event);
  if (sanitized.type !== 'tool') return sanitized;
  return sanitizeToolImagePayloadForRefs(sanitized);
};

/**
 * Sanitize an event for memory-safe main-process accumulation.
 * - Truncates large tool `detail` strings to prevent unbounded growth
 * - Strips inline image bytes when the corresponding `imageRef` is present,
 *   preserving per-image legacy fallbacks for refs that failed to materialize
 *
 * Post-Stage-3a-L2: dispatch routes through the manifest's sanitization axis
 * (`SANITIZATION_POLICY_FROM_MANIFEST`) + the local strategy registry. The
 * separate `sanitizeEventForRenderer` export is preserved for caller-site
 * documentation (different process surfaces); both share the dispatcher.
 */
export const sanitizeEventForMainAccumulation = (event: AgentEvent): AgentEvent =>
  dispatchSanitization(event);

/**
 * Sanitize an event for renderer-side storage.
 * - Truncates large tool `detail` strings (same threshold as main process)
 * - Strips inline image bytes when the corresponding `imageRef` is present,
 *   preserving per-image legacy fallbacks for refs that failed to materialize
 *
 * See `sanitizeEventForMainAccumulation` for dispatch internals.
 */
export const sanitizeEventForRenderer = (event: AgentEvent): AgentEvent =>
  dispatchSanitization(event);
