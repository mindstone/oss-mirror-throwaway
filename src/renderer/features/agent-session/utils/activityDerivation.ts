/**
 * Unified activity derivation layer for the Thinking Panel UX redesign.
 *
 * Consolidates friendly-label logic previously spread across TurnStepsInline,
 * toolChips, and personaQuips into a single derivation pipeline. Presentation
 * functions (`deriveCurrentActivity`, `deriveCollapsedSummary`) sit on top of
 * the shared `humanizeToolActivity()` and the moved `humanizeToolDisplay()`.
 *
 * @see docs/plans/260413_thinking_panel_ux_redesign.md — Stage 1
 */

import { sanitizeCommandForDisplay, humanizeToolActivity } from '@rebel/shared';
import { safeParseDetail } from './safeParseDetail';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import { classifyTurnEnding, type TurnEndingInput } from '@shared/utils/turnEndingClassification';
import type { StepToolSummary } from './toolChips';
import type { TaskProgressItem } from './turnStepContext';
import type { SubAgentTimeline } from './subAgentTimeline';

// ---------------------------------------------------------------------------
// Moved from TurnStepsInline.tsx — canonical location for friendly labels
// ---------------------------------------------------------------------------

export const MCP_LABEL_SEPARATOR = ' \u2022 '; // U+2022 BULLET — matches toolChips.ts

export const FRIENDLY_LABELS: Record<string, string> = {
  'edit file': 'Editing your document',
  'write file': 'Writing up the results',
  'create file': 'Drafting something new',
  'read file': 'Reading through your content',
  'read': 'Reading through your content',
  'open file': 'Looking at your files',
  'view file': 'Looking at your files',
  'save file': 'Saving your work',
  'delete file': 'Tidying up',
  'delete': 'Tidying up',
  'list files': 'Browsing your files',
  'move file': 'Organising your files',
  'copy file': 'Making a copy',
  'rename file': 'Renaming a file',
  'apply patch': 'Applying edits',
  'write': 'Writing up the results',
  'edit': 'Editing your document',
  'update': 'Updating your content',
  'file search': 'Looking through your files',
  'search': 'Searching for what you need',
  'tool search': 'Picking the best tool for this',
  'run command': 'Running a background task',
  'task update': 'Tracking what has been done',
  'task create': 'Planning the next steps',
  'task list': 'Checking the to-do list',
  'todowrite': 'Planning the next steps',
  'missionset': 'Setting the goal',
  'rebel_operator__consult': 'Asking an Operator',
};

export const humanizeLabel = (label: string): string => {
  const mcpParts = label.split(MCP_LABEL_SEPARATOR);
  const raw = mcpParts.length >= 2 ? mcpParts[mcpParts.length - 1] : label;
  return FRIENDLY_LABELS[raw.toLowerCase()] ?? raw;
};

/**
 * Pre-turn context tools dispatched by agentTurnExecutor during context assembly.
 * For these, we show the result summary (e.g., "Found 10 relevant tools") instead
 * of a generic friendly label like "Searching for what you need".
 */
export const PRE_TURN_CONTEXT_TOOLS = new Set([
  'tool_search', 'skill_search', 'file_search', 'conversation_search', 'document_prefetch'
]);

export const humanizeToolDisplay = (tool: StepToolSummary): string => {
  const operatorSetupAffordance = deriveOperatorSetupAffordance(tool);
  if (operatorSetupAffordance) {
    return operatorSetupAffordance.label;
  }

  if (tool.detail && tool.toolName && PRE_TURN_CONTEXT_TOOLS.has(tool.toolName) && tool.status === 'success') {
    return tool.detail.split('\n')[0];
  }

  const rawAction = (tool.label.split(MCP_LABEL_SEPARATOR).pop() ?? tool.label).toLowerCase();
  const friendly = FRIENDLY_LABELS[rawAction];
  if (!friendly) return humanizeLabel(tool.label);

  if (tool.fullPath) {
    const parts = tool.fullPath.replace(/\\/g, '/').split('/');
    const filename = parts[parts.length - 1];
    if (filename?.includes('.')) return `${friendly} — ${filename}`;
  }
  if (tool.fullCommand) {
    const short = sanitizeCommandForDisplay(tool.fullCommand, 36);
    if (short) return `${friendly} — ${short}`;
  }
  if (tool.fullUrl) {
    try {
      const hostname = new URL(tool.fullUrl).hostname.replace(/^www\./, '');
      if (hostname) return `${friendly} — ${hostname}`;
    } catch { /* malformed URL, fall through */ }
  }
  return friendly;
};

// ---------------------------------------------------------------------------
// Task title simplification — strip technical noise, preserve meaning
// ---------------------------------------------------------------------------

const DANGLING_WORDS = /\s+(that|the|a|an|and|or|but|which|who|whom|whose|where|when|with|from|into|for|about|this|these|their|its|our|your|my|to|in|on|of|by|as|at|is|are|was|were|will|would|should|could|can|may|might|shall|has|have|had|do|does|did|be|been|being|not|no|so|if|then|than|it)\s*$/i;

/**
 * Simplify a verbose agent-generated task title into a short, user-friendly
 * one-liner. Only strips technical noise (file paths, parenthetical refs,
 * verbose detail lists) — never removes verbs or core meaning.
 *
 * The full title remains available via expand/tooltip.
 */
export function simplifyTaskTitle(title: string): string {
  let t = title;

  // Strip file paths (the only truly "technical noise")
  t = t.replace(/\b[\w.-]+\/[\w./-]+\.[\w]+\b/g, '');   // paths with extensions
  t = t.replace(/\b[\w.-]+\/[\w./-]{10,}\b/g, '');        // long slash-separated paths
  t = t.replace(/\b(at|from|in|across)\s+\S*\/\S+/gi, ''); // "at/from/in <path>"

  // Strip parenthetical content (technical refs like "(s)", "(via worker)", etc.)
  t = t.replace(/\s*\([^)]{0,60}\)/g, '');

  // Trim verbose detail lists after colon/semicolon — but only when
  // enough meaningful content exists before the delimiter (>20 chars).
  // Em-dashes are NOT trimmed (used in ranges like "A–F" and short clarifications).
  const delimMatch = t.match(/^(.{20,}?)\s*[:;]\s*.+/);
  if (delimMatch) {
    t = delimMatch[1];
  }

  // Clean up dangling prepositions left by path stripping
  t = t.replace(/\s+(at|from|in|across)\s+(?=to\s)/gi, ' ');  // "at to" → " to"
  t = t.replace(/\s+(at|from|in|across)\s*$/i, '');             // trailing preposition

  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();

  // Cap at ~60 chars, breaking at word boundary
  if (t.length > 60) {
    const cut = t.slice(0, 60);
    const lastSpace = cut.lastIndexOf(' ');
    t = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut)
      .replace(DANGLING_WORDS, '') + '\u2026';
  }

  return t;
}

const ALREADY_PROGRESSIVE = new Set([
  'analyzing',
  'answering',
  'auditing',
  'browsing',
  'building',
  'checking',
  'collecting',
  'comparing',
  'drafting',
  'editing',
  'exploring',
  'fetching',
  'finding',
  'gathering',
  'loading',
  'looking',
  'organizing',
  'planning',
  'preparing',
  'reading',
  'researching',
  'reviewing',
  'running',
  'scanning',
  'searching',
  'thinking',
  'tracing',
  'updating',
  'using',
  'verifying',
  'working',
  'writing',
]);

const IMPERATIVE_TO_PROGRESSIVE: Record<string, string> = {
  analyze: 'Analyzing',
  answer: 'Answering',
  audit: 'Auditing',
  browse: 'Browsing',
  build: 'Building',
  check: 'Checking',
  collect: 'Collecting',
  compare: 'Comparing',
  create: 'Creating',
  draft: 'Drafting',
  edit: 'Editing',
  explore: 'Exploring',
  fetch: 'Fetching',
  find: 'Finding',
  gather: 'Gathering',
  inspect: 'Inspecting',
  investigate: 'Investigating',
  list: 'Listing',
  load: 'Loading',
  look: 'Looking at',
  open: 'Opening',
  organize: 'Organizing',
  plan: 'Planning',
  prepare: 'Preparing',
  read: 'Reading',
  research: 'Researching',
  review: 'Reviewing',
  run: 'Running',
  scan: 'Scanning',
  search: 'Searching',
  summarize: 'Summarizing',
  trace: 'Tracing',
  update: 'Updating',
  use: 'Using',
  verify: 'Verifying',
  work: 'Working on',
  write: 'Writing',
};

export function toProgressivePhrase(text: string): string {
  const normalized = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Thinking';
  }

  const [firstWord, ...restWords] = normalized.split(' ');
  const lowerFirst = firstWord.toLowerCase();

  if (ALREADY_PROGRESSIVE.has(lowerFirst)) {
    return normalized;
  }

  const mapped = IMPERATIVE_TO_PROGRESSIVE[lowerFirst];
  if (mapped) {
    return restWords.length > 0 ? `${mapped} ${restWords.join(' ')}` : mapped;
  }

  if (lowerFirst === 'current' || lowerFirst === 'next') {
    return normalized;
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Activity derivation — new in Stage 1
// ---------------------------------------------------------------------------

export type SubAgentActivityInfo = {
  runningCount: number;
  totalCount: number;
  completedCount: number;
  dominantActivity?: string;
  statusText: string;
  /** Badge label: the count as a string, or "5+" for large counts. */
  badgeLabel: string;
};

/**
 * Where the winning status line came from in the priority ladder. Lets the
 * presentation layer tell *concrete* activity (a real tool / sub-agent / build /
 * error / task) apart from the *non-concrete* gap fillers (a rotating persona
 * quip-or-tip carried on `thinkingHeadline`, or the bare idle fallback). Stage 4
 * uses this to keep ONE primary signal — the concrete line — and demote the
 * quip to a quiet, gated fallback. Pure metadata; it does not change the ladder.
 */
export type ActivitySource =
  | 'error'
  | 'mcpBuild'
  | 'tool'
  | 'subAgents'
  | 'thinkingHeadline'
  | 'task'
  | 'idle';

/**
 * Sources that represent *real* work Rebel is doing or just did — as opposed to
 * a gap filler. The persona quip/tip (`thinkingHeadline`) and the bare `idle`
 * fallback are deliberately excluded.
 */
const CONCRETE_ACTIVITY_SOURCES: ReadonlySet<ActivitySource> = new Set<ActivitySource>([
  'error',
  'mcpBuild',
  'tool',
  'subAgents',
  'task',
]);

/**
 * @internal Test seam — exported only so `__tests__/activityDerivation.test.ts` can
 * assert which derived sources count as "real work" vs gap-fillers. The classification
 * itself (`CONCRETE_ACTIVITY_SOURCES`) is private and live; this thin predicate has no
 * production consumer. The default knip leg still tracks it.
 */
export function isConcreteActivitySource(source: ActivitySource): boolean {
  return CONCRETE_ACTIVITY_SOURCES.has(source);
}

export type DerivedActivity = {
  statusLine: string;
  /** Where this status line came from in the priority ladder (Stage 4). */
  source: ActivitySource;
  isActive: boolean;
  hasError: boolean;
  /**
   * Inline affordance for successful Operator consults that report
   * `{ calibrated: false }`. Presentation can render this as a deep-link to
   * the Operators panel instead of treating the tool result as a normal
   * successful ask.
   */
  operatorSetupAffordance?: {
    operatorId: string;
    operatorName: string;
    label: string;
    deepLink: string;
  };
  /**
   * Set when the activity line reflects an in-flight MCP connector build.
   * Presentation uses this to render the connector name with a tooltip
   * carrying the reassurance copy (previously on the footer MCPBuildCard).
   * Absent when another priority (error, running tool, etc.) has won.
   */
  mcpBuild?: {
    verb: 'Building' | 'Trying out';
    connectorName: string;
    helperText: string;
  } | null;
  /**
   * Populated whenever one or more sub-agents are running, regardless of
   * which priority won the status line. Used by the indicator (Bot icon +
   * count badge) and compact preview chips.
   */
  subAgents?: SubAgentActivityInfo;
};

/**
 * Reassurance copy previously rendered on the footer MCPBuildCard's
 * `helperText`. Kept here so the tooltip that replaces it can stay in sync
 * without reaching into the (deprecated) MCPBuildCard file.
 *
 * Voice doc: docs/project/CONNECTOR_CONTRIBUTION_VOICE.md. Plain English,
 * action-oriented, no technical artefact terms (no "scaffolding", "tool
 * handlers", "tests", "compile", "connector").
 */
export const MCP_BUILD_HELPER_TEXT: Record<McpBuildActivity['subphase'], string> = {
  implementing: "We're putting the pieces together. You'll see the share option once it works.",
  testing: "We're trying each new action with realistic examples to make sure it actually works. This usually takes a minute or two. You'll see the share option once everything works.",
};

/**
 * Live MCP-build activity derived from the contribution store.
 *
 * When present, this takes priority over tool/sub-agent/headline activity
 * in `deriveCurrentActivity()` so the user sees connector build progress
 * ("Writing <name>", "Testing <name>") in the Doing-right-now section of
 * the Rebel thinking card instead of a separate footer card.
 *
 * See docs/plans/260420_simplify_mcp_build_flow.md for the progress-card
 * rationale and the later decision to fold this into the unified thinking
 * card (removes the footer card; eliminates the stuck-card symptom when
 * the contribution record lingers in `testing`).
 */
export type McpBuildActivity = {
  subphase: 'implementing' | 'testing';
  connectorName: string;
};

export type DeriveCurrentActivityParams = {
  toolSummariesByStep: Map<number, StepToolSummary[]>;
  taskProgress?: TaskProgressItem[];
  subAgentTimeline?: SubAgentTimeline | null;
  thinkingHeadline?: string;
  mcpBuildActivity?: McpBuildActivity | null;
};

/**
 * Shorten a verbose MCP server label to just the recognisable service name.
 *
 * MCP identifiers often encode account/org qualifiers after the service name
 * (e.g., "Google Workspace Team Member Mindstone Com"). Users only need the
 * service portion — "Google Workspace" is meaningful, the rest is noise.
 */
function shortenServerLabel(label: string, maxWords = 2): string {
  const words = label.split(/\s+/);
  if (words.length <= maxWords) return label;
  return words.slice(0, maxWords).join(' ');
}

/**
 * Convert a tool summary to an active-verb status line.
 * Always returns present-tense ("Reading a file", "Searching the web")
 * — never result text ("Found 2 relevant conversations").
 *
 * Checks renderer-level FRIENDLY_LABELS first (richer, more specific) before
 * falling back to the shared humanizeToolActivity. If the shared layer returns
 * a generic "Using X" label, we improve it with MCP context from the label.
 */
function toolToActiveVerb(tool: StepToolSummary): string {
  if (tool.toolName === 'rebel_operator__consult') {
    return `Asking ${getOperatorDisplayName(tool)}`;
  }

  const rawAction = (tool.label.split(MCP_LABEL_SEPARATOR).pop() ?? tool.label).toLowerCase();
  const friendly = FRIENDLY_LABELS[rawAction];
  if (friendly) return friendly;

  if (tool.toolName) {
    const shared = humanizeToolActivity(tool.toolName, tool.detail);
    // "Using X" is too generic — try to build a better label from the MCP
    // label (e.g., "Slack • Search Messages" → "Searching Slack messages")
    if (shared.startsWith('Using ') && tool.label.includes(MCP_LABEL_SEPARATOR)) {
      const parts = tool.label.split(MCP_LABEL_SEPARATOR);
      const action = (parts[parts.length - 1] ?? '').trim();
      // For the server, use the last non-action segment (skips router layers)
      // then shorten to the recognisable service name.
      const serverParts = parts.slice(0, -1);
      const rawServer = (serverParts[serverParts.length - 1] ?? '').trim();
      const server = shortenServerLabel(rawServer);
      if (server && action) {
        const humanAction = action
          .replace(/[_-]+/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase();
        return `${toProgressivePhrase(humanAction)} in ${server}`;
      }
      if (server) return `Working with ${server}`;
    }
    return shared;
  }
  return humanizeLabel(tool.label);
}

/**
 * Derive a single plain-language activity string from current tool state.
 *
 * "Right now" must always reflect **actual tool/task activity** — what Rebel
 * is doing or just did, never entertainment quips or persona tips.
 *
 * Priority:
 *  1. Error state — latest tool errored
 *  2. MCP build activity (writing/testing a connector) — the footer build
 *     card was folded into this line so users see one unified activity
 *     anchor instead of two cards racing each other.
 *  3. Actively running tool (present-tense verb)
 *  4. Sub-agent activity
 *  5. Last completed tool (between tool calls — shows what just finished)
 *  6. thinkingHeadline (specific activity from the router/headline system)
 *  7. In-progress task title (as a last resort before generic)
 *  8. "Getting started" (never show bare "Thinking")
 */
export function deriveCurrentActivity(params: DeriveCurrentActivityParams): DerivedActivity {
  const { toolSummariesByStep, taskProgress, subAgentTimeline, thinkingHeadline, mcpBuildActivity } = params;

  const allTools = collectAllTools(toolSummariesByStep);
  const latestTool = allTools.length > 0 ? allTools[allTools.length - 1] : null;
  const isActive = allTools.some(t => t.status === 'running' || t.status === 'pending');
  const hasError = latestTool?.status === 'error';

  // Always compute sub-agent info — used for the indicator (Bot icon + badge)
  // even when a higher priority wins the status line.
  const subAgents = deriveSubAgentInfo(subAgentTimeline) ?? undefined;

  // Priority 1: Error state
  if (hasError && latestTool) {
    if (latestTool.toolName === 'rebel_operator__consult') {
      return {
        statusLine: `Couldn't ask ${getOperatorDisplayName(latestTool)} — moving on`,
        source: 'error',
        isActive,
        hasError: true,
        subAgents,
      };
    }
    const activity = toolToActiveVerb(latestTool);
    return {
      statusLine: `Had trouble ${lowercaseFirst(activity)} — moving on`,
      source: 'error',
      isActive,
      hasError: true,
      subAgents,
    };
  }

  // Priority 2: MCP build activity — a tool is being built or tried out.
  // Wins over running tool so the user sees the high-level intent
  // ("Trying out Notion") rather than the low-level step underneath.
  //
  // Verbs follow the voice doc + user amendment (260427):
  //   - implementing → "Building"  (replaces "Writing" — describes the
  //     full construction better)
  //   - testing      → "Trying out" (plain English, matches the voice
  //     doc lexicon)
  if (mcpBuildActivity) {
    const verb: 'Building' | 'Trying out' = mcpBuildActivity.subphase === 'testing' ? 'Trying out' : 'Building';
    return {
      statusLine: `${verb} ${mcpBuildActivity.connectorName}`,
      source: 'mcpBuild',
      isActive: true,
      hasError: false,
      mcpBuild: {
        verb,
        connectorName: mcpBuildActivity.connectorName,
        helperText: MCP_BUILD_HELPER_TEXT[mcpBuildActivity.subphase],
      },
      subAgents,
    };
  }

  // Priority 3: Actively running tool — always present-tense verb
  const runningOperatorGroup = deriveLatestOperatorConsultGroup(toolSummariesByStep, 'running');
  if (runningOperatorGroup) {
    return { statusLine: runningOperatorGroup, source: 'tool', isActive: true, hasError: false, subAgents };
  }

  const runningTool = findLastToolByStatus(allTools, 'running');
  if (runningTool) {
    return { statusLine: toolToActiveVerb(runningTool), source: 'tool', isActive: true, hasError: false, subAgents };
  }

  // Priority 4: Sub-agent activity
  if (subAgents) {
    return { statusLine: subAgents.statusText, source: 'subAgents', isActive: true, hasError: false, subAgents };
  }

  // Priority 5: Last completed tool (between tool calls, show what just finished)
  if (latestTool && latestTool.status === 'success') {
    const operatorSetupAffordance = deriveOperatorSetupAffordance(latestTool);
    if (operatorSetupAffordance) {
      return {
        statusLine: operatorSetupAffordance.label,
        source: 'tool',
        isActive: false,
        hasError: false,
        operatorSetupAffordance,
      };
    }

    const completedOperatorGroup = deriveLatestOperatorConsultGroup(toolSummariesByStep, 'success');
    if (completedOperatorGroup) {
      return {
        statusLine: completedOperatorGroup,
        source: 'tool',
        isActive: false,
        hasError: false,
      };
    }
    return {
      statusLine: toolToActiveVerb(latestTool),
      source: 'tool',
      isActive: false,
      hasError: false,
    };
  }

  // Priority 6: thinkingHeadline provides specific activity from the router
  // (e.g. "Looking at Linear", "Searching Slack messages"). In the current
  // build the router is disabled, so this carries the rotating persona
  // quip/tip and the calm default headline — i.e. a *gap filler*, not concrete
  // activity. Marked `source: 'thinkingHeadline'` so Stage 4's presentation can
  // demote it (the persona quip belongs in a quiet, gated fallback slot).
  if (thinkingHeadline) {
    const cleaned = thinkingHeadline.replace(/\*\*(.+?)\*\*/g, '$1').trim();
    if (cleaned && cleaned.toLowerCase() !== 'thinking') {
      return { statusLine: toProgressivePhrase(cleaned), source: 'thinkingHeadline', isActive: false, hasError: false };
    }
  }

  // Priority 7: In-progress task title as last resort
  const inProgressTask = taskProgress?.find(t => t.status === 'in_progress');
  if (inProgressTask) {
    return {
      statusLine: toProgressivePhrase(simplifyTaskTitle(inProgressTask.title)),
      source: 'task',
      isActive: false,
      hasError: false,
    };
  }

  // Priority 8: Descriptive fallback — never show bare "Thinking"
  return { statusLine: 'Getting started', source: 'idle', isActive: false, hasError: false };
}

// ---------------------------------------------------------------------------
// Stage 4 — persona-quip fallback gating (one thing at a time)
// ---------------------------------------------------------------------------

/**
 * How long a non-concrete waiting line must sit unchanged before we re-engage
 * the user with a quiet persona quip (long-wait reassurance). Below this, the
 * single primary line + the quiet elapsed timer carry the wait on their own.
 *
 * Chosen at ~25s per the Stage 4 brief: long enough that a brisk gap stays
 * calm and silent, short enough that a genuinely stalled-feeling wait still
 * gets a witty sign of life before the user starts wondering if it's stuck.
 */
export const PERSONA_QUIP_LONG_WAIT_MS = 25_000;

export type ShouldShowPersonaQuipParams = {
  /** Whether the turn is actively running. Quips never show outside a live turn. */
  isThinking: boolean;
  /** Source of the *primary* (concrete) activity line — i.e. the line derived WITHOUT the rotating quip. */
  activitySource: ActivitySource;
  /** How long that primary line has been unchanged, in ms. */
  activityStaticForMs: number;
};

/**
 * Decide whether the rotating persona quip should surface as a quiet, secondary
 * fallback line (Stage 4 — "one thing at a time", demote-don't-delete).
 *
 * The quip is a SILENCE FILLER, never a competitor to *changing* real activity.
 * It shows ONLY when the turn is live (`isThinking`) AND one of:
 *  - we're in the genuine idle gap (`source === 'idle'` — nothing concrete yet),
 *    where it fills the silence immediately; OR
 *  - the primary line has sat unchanged long enough to risk feeling stuck
 *    (`activityStaticForMs >= PERSONA_QUIP_LONG_WAIT_MS`), even when that line
 *    is a concrete tool/task — long-wait re-engagement (DA SHOULD-4).
 *
 * A *progressing* concrete line never triggers a quip: each change resets the
 * static clock, so the quip only appears once activity has genuinely gone quiet.
 * The quiet elapsed timer remains the always-on "still moving" signal alongside.
 */
export function shouldShowPersonaQuip(params: ShouldShowPersonaQuipParams): boolean {
  const { isThinking, activitySource, activityStaticForMs } = params;
  if (!isThinking) return false;
  // Bare idle gap: fill the silence right away.
  if (activitySource === 'idle') return true;
  // Otherwise (a concrete or headline line): only once it has been static long
  // enough that the wait risks feeling stuck.
  return activityStaticForMs >= PERSONA_QUIP_LONG_WAIT_MS;
}

// ---------------------------------------------------------------------------
// Collapsed summary derivation
// ---------------------------------------------------------------------------

export type DeriveCollapsedSummaryParams = {
  taskProgress?: TaskProgressItem[];
  currentActivity: string;
  isThinking: boolean;
  isComplete: boolean;
  isPaused?: boolean;
  endedWith?: TurnEndingInput;
};

/**
 * Derive the single-line collapsed bar text.
 *
 * - Complete: "Done — X/Y steps completed" or "Done — [last activity]"
 * - Thinking with tasks: "X/Y · [currentActivity]"
 * - Thinking without tasks: "[currentActivity]"
 * - Fallback: "Activity"
 */
export function deriveCollapsedSummary(params: DeriveCollapsedSummaryParams): string {
  const { taskProgress, currentActivity, isThinking, isComplete, isPaused = false, endedWith } = params;

  const completedCount = taskProgress?.filter(t => t.status === 'completed').length ?? 0;
  const totalCount = taskProgress?.length ?? 0;

  // Precedence: interrupted wins over isComplete because mid-turn termination
  // leaves !isThinking && !isBusy && hadActivity → isComplete=true (see
  // ContextualProgressCard.tsx isComplete derivation).
  if (classifyTurnEnding(endedWith).kind === 'transient_error') {
    if (totalCount > 0) {
      return `Connection dropped — ${completedCount}/${totalCount} steps completed`;
    }
    return 'Connection dropped';
  }

  if (isComplete) {
    if (totalCount > 0) {
      return `Done — ${completedCount}/${totalCount} steps completed`;
    }
    if (currentActivity && currentActivity !== 'Working on it') {
      return `Done — ${currentActivity}`;
    }
    return 'Done';
  }

  if (isThinking) {
    if (totalCount > 0) {
      return `${completedCount}/${totalCount} · ${currentActivity}`;
    }
    return currentActivity;
  }

  if (isPaused) {
    return 'Paused — needs your approval';
  }

  return 'Activity';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function collectAllTools(toolSummariesByStep: Map<number, StepToolSummary[]>): StepToolSummary[] {
  const all: StepToolSummary[] = [];
  const sortedKeys = Array.from(toolSummariesByStep.keys()).sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const tools = toolSummariesByStep.get(key);
    if (tools) all.push(...tools);
  }
  return all;
}

function findLastToolByStatus(
  tools: StepToolSummary[],
  status: StepToolSummary['status'],
): StepToolSummary | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].status === status) return tools[i];
  }
  return null;
}

function getOperatorDisplayName(tool: StepToolSummary): string {
  const fromPayload = extractOperatorNameFromPayload(tool.resultPayload);
  if (fromPayload) return fromPayload;
  const fromDetail = extractOperatorNameFromDetail(tool.detail);
  if (fromDetail) return fromDetail;
  return 'Operator';
}

export function deriveOperatorSetupAffordance(
  tool: StepToolSummary,
): DerivedActivity['operatorSetupAffordance'] | null {
  if (tool.toolName !== 'rebel_operator__consult' || tool.status !== 'success') {
    return null;
  }

  const payload = normalizeOperatorResultPayload(tool.resultPayload);
  if (!payload || payload.calibrated !== false) {
    return null;
  }

  const operatorId = typeof payload.operatorId === 'string' && payload.operatorId.trim()
    ? payload.operatorId.trim()
    : null;
  if (!operatorId) {
    return null;
  }

  const operatorName = typeof payload.operatorName === 'string' && payload.operatorName.trim()
    ? payload.operatorName.trim()
    : getOperatorDisplayName(tool);

  return {
    operatorId,
    operatorName,
    label: `Set up ${operatorName}`,
    deepLink: formatNavigationUrl({ type: 'team', roleId: operatorId }),
  };
}

function normalizeOperatorResultPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const result = record.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return record;
}

function extractOperatorNameFromPayload(value: unknown): string | null {
  const payload = normalizeOperatorResultPayload(value);
  if (!payload) return null;
  const operatorName = typeof payload.operatorName === 'string' ? payload.operatorName : null;
  if (operatorName?.trim()) return operatorName.trim();
  const operatorId = typeof payload.operatorId === 'string' ? payload.operatorId : null;
  if (!operatorId) return null;
  const slug = operatorId.includes('::') ? operatorId.slice(operatorId.lastIndexOf('::') + 2) : operatorId;
  return slug
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function extractOperatorNameFromDetail(detail: string | undefined): string | null {
  if (!detail) return null;
  const result = safeParseDetail(detail);
  if (!result.ok) return null;
  try {
    const parsed = result.value as Record<string, unknown>;
    const operatorName = typeof parsed.operatorName === 'string'
      ? parsed.operatorName
      : typeof (parsed.result as Record<string, unknown> | undefined)?.operatorName === 'string'
        ? (parsed.result as Record<string, unknown>).operatorName as string
        : null;
    if (operatorName?.trim()) return operatorName.trim();
    const operatorId = typeof parsed.operatorId === 'string'
      ? parsed.operatorId
      : typeof (parsed.input as Record<string, unknown> | undefined)?.operatorId === 'string'
        ? (parsed.input as Record<string, unknown>).operatorId as string
        : null;
    if (!operatorId) return null;
    const slug = operatorId.includes('::') ? operatorId.slice(operatorId.lastIndexOf('::') + 2) : operatorId;
    return slug
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  } catch {
    return null;
  }
}

function deriveOperatorConsultGroupForTools(
  tools: StepToolSummary[],
  status: StepToolSummary['status'],
): string | null {
  const operatorTools = tools.filter((tool) =>
    tool.toolName === 'rebel_operator__consult' && tool.status === status,
  );
  if (operatorTools.length < 2 || operatorTools.length > 3) return null;
  const names = operatorTools.map(getOperatorDisplayName);
  const verb = status === 'running' || status === 'pending' ? 'Asking' : 'Asked';
  return `${verb} ${operatorTools.length} Operators: ${names.join(', ')}`;
}

function deriveLatestOperatorConsultGroup(
  toolSummariesByStep: Map<number, StepToolSummary[]>,
  status: StepToolSummary['status'],
): string | null {
  const sortedStepKeys = Array.from(toolSummariesByStep.keys()).sort((a, b) => b - a);
  for (const stepKey of sortedStepKeys) {
    const group = deriveOperatorConsultGroupForTools(toolSummariesByStep.get(stepKey) ?? [], status);
    if (group) return group;
  }
  return null;
}

function deriveSubAgentInfo(timeline: SubAgentTimeline | null | undefined): SubAgentActivityInfo | null {
  if (!timeline?.items.length) return null;

  const running = timeline.items.filter(item => item.status === 'running');
  if (running.length === 0) return null;

  const completedCount = timeline.items.filter(item => item.status === 'completed').length;
  const runningCount = running.length;
  const totalCount = timeline.items.length;
  const badgeLabel = runningCount >= 5 ? '5+' : String(runningCount);

  // Derive dominant activity — only set when EVERY running agent has the same
  // known activity. If some agents haven't reported activity yet, fall back to
  // the generic "working at once" phrasing to avoid overstating shared intent.
  const activities = running
    .map(item => {
      if (item.currentActivity) return toProgressivePhrase(item.currentActivity);
      const lastTool = item.toolSummaries.at(-1);
      if (lastTool) return toProgressivePhrase(humanizeToolDisplay(lastTool));
      return null;
    })
    .filter((a): a is string => a !== null);

  const uniqueActivities = new Set(activities.map(a => a.toLowerCase()));
  const dominantActivity = activities.length === running.length && uniqueActivities.size === 1
    ? activities[0]
    : undefined;

  let statusText: string;
  if (completedCount > 0 && runningCount > 0) {
    statusText = `${runningCount} of ${totalCount} assistant${totalCount !== 1 ? 's' : ''} still working`;
  } else if (runningCount === 1) {
    const activity = dominantActivity ? lowercaseFirst(dominantActivity) : 'working';
    statusText = `Assistant ${activity}`;
  } else if (dominantActivity) {
    statusText = `${runningCount} assistants ${lowercaseFirst(dominantActivity)}`;
  } else {
    statusText = `${runningCount} assistants working at once`;
  }

  return { runningCount, totalCount, completedCount, dominantActivity, statusText, badgeLabel };
}

function lowercaseFirst(text: string): string {
  if (!text) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}
