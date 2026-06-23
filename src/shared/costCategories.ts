/**
 * Cost Category Registry — Single Source of Truth
 *
 * Central registry for all cost categories used across the codebase.
 * Eliminates category metadata drift between costLedgerService, usageCostAnalysis,
 * UsageTab, btsModelResolver, and agentTurnRegistry.
 *
 * Every known cost category maps to its metadata:
 * - kind: 'auxiliary' (BTS callers), 'turn' (turn-level tracking), or 'legacy' (historical)
 * - group: UI cost bucket for the Usage tab
 * - label: Human-readable label for UI tooltips
 * - desc: Optional longer description for tooltip detail
 * - btsTaskGroup: Optional BTS model override group (for btsModelResolver)
 *
 * @see src/core/services/costLedgerService.ts — cost ledger
 * @see src/core/services/usageCostAnalysis.ts — cost grouping
 * @see src/renderer/features/settings/components/tabs/UsageTab.tsx — usage display
 * @see src/shared/utils/btsModelResolver.ts — BTS model overrides
 * @see src/core/services/agentTurnRegistry.ts — turn lifecycle
 */

// -----------------------------------------------------------------------------
// Cost group types
// -----------------------------------------------------------------------------

/** UI cost bucket keys for the Usage tab */
export const COST_GROUP_KEYS = [
  'conversations',
  'automations',
  'fileIntelligence',
  'safetyChecks',
  'memoryNotes',
  'housekeeping',
] as const;

export type CostGroupKey = (typeof COST_GROUP_KEYS)[number];

/** Human-readable labels for cost groups */
export const COST_GROUP_LABELS: Record<CostGroupKey, string> = {
  conversations: 'Conversations',
  automations: 'Automations',
  fileIntelligence: 'File Intelligence',
  safetyChecks: 'Safety Checks',
  memoryNotes: 'Memory & Notes',
  housekeeping: 'Housekeeping',
};

// -----------------------------------------------------------------------------
// BTS task group types (behind-the-scenes model override groups)
// -----------------------------------------------------------------------------

/** User-facing task groups for behind-the-scenes model overrides */
export type BtsTaskGroup = 'safety' | 'memory' | 'coaching' | 'meetings' | 'improvement' | 'hero-choice' | 'search' | 'foraging';

/** UI metadata for each task group */
export const BTS_TASK_GROUPS: Record<BtsTaskGroup, { label: string; description: string; defaultLabel?: string; requiresJson?: boolean }> = {
  safety: { label: 'Safety & Security', description: 'Tool safety checks and memory write guards', requiresJson: true },
  memory: { label: 'Memory', description: 'Learning and remembering from conversations', requiresJson: true },
  coaching: { label: 'Coaching & Estimates', description: 'Session coaching, improvement tips, and time estimates', requiresJson: true },
  meetings: { label: 'Meetings', description: 'Meeting transcription and Q&A' },
  improvement: { label: 'Self-Improvement', description: 'Post-session analysis and improvement suggestions', defaultLabel: 'Same as Main work', requiresJson: true },
  'hero-choice': { label: 'For You', description: 'Personalised homepage recommendations based on your recent activity', requiresJson: true },
  search: { label: 'Search', description: 'Smart query generation for file, tool, conversation, and skill search', requiresJson: true },
  foraging: { label: 'Foraging', description: 'Cheap extractive content triage during agent turns' },
};

/** All valid BtsTaskGroup values for iteration */
export const BTS_TASK_GROUP_KEYS = Object.keys(BTS_TASK_GROUPS) as BtsTaskGroup[];

// -----------------------------------------------------------------------------
// Category metadata shape (for satisfies constraint)
// -----------------------------------------------------------------------------

interface CostCategoryMeta {
  kind: 'auxiliary' | 'turn' | 'legacy';
  group: CostGroupKey;
  label: string;
  desc?: string;
  btsTaskGroup?: BtsTaskGroup;
}

// -----------------------------------------------------------------------------
// Registry (alphabetical order)
// -----------------------------------------------------------------------------

export const COST_CATEGORY_REGISTRY = {
  'activity-summary': { kind: 'auxiliary', group: 'conversations', label: 'Activity recap', desc: 'One-sentence summary of what Rebel did each turn' },
  'adhoc-model': { kind: 'auxiliary', group: 'conversations', label: 'Ad-hoc models', desc: 'Referenced model consultations' },
  agent: { kind: 'auxiliary', group: 'conversations', label: 'Your conversations', desc: 'Interactive turns with Rebel' },
  'archive-safety': { kind: 'auxiliary', group: 'housekeeping', label: 'Archive safety', btsTaskGroup: 'safety' },
  'atlas-insights': { kind: 'auxiliary', group: 'fileIntelligence', label: 'Atlas insights', desc: 'AI-powered file analysis' },
  autoContinue: { kind: 'auxiliary', group: 'conversations', label: 'Auto-continue', desc: 'Automatic conversation continuation' },
  automation: { kind: 'turn', group: 'automations', label: 'Automations', desc: 'Scheduled background tasks' },
  'bug-report-diagnostics': { kind: 'auxiliary', group: 'housekeeping', label: 'Bug report diagnostics', desc: 'Bug report LLM analysis', btsTaskGroup: 'safety' },
  chat: { kind: 'turn', group: 'conversations', label: 'Chat mode' },
  coaching: { kind: 'auxiliary', group: 'memoryNotes', label: 'Session insights', desc: 'Generating coaching tips', btsTaskGroup: 'coaching' },
  communityShare: { kind: 'auxiliary', group: 'housekeeping', label: 'Community share', desc: 'Community share composition' },
  compaction: { kind: 'auxiliary', group: 'housekeeping', label: 'Compaction', desc: 'Conversation compaction summaries' },
  'compaction-bts': { kind: 'auxiliary', group: 'housekeeping', label: 'Intelligent compaction', desc: 'BTS-powered compression' },
  conversation: { kind: 'turn', group: 'conversations', label: 'Chat completions', desc: 'Simple chat mode (no tools)' },
  council: { kind: 'auxiliary', group: 'conversations', label: 'Council members', desc: 'Multi-model council dispatch' },
  'done-safety': { kind: 'auxiliary', group: 'safetyChecks', label: 'Auto-done safety', desc: 'Auto-done safety evaluation', btsTaskGroup: 'safety' },
  enhancement: { kind: 'auxiliary', group: 'fileIntelligence', label: 'File enhancement', desc: 'Adding context to indexed files' },
  error: { kind: 'auxiliary', group: 'conversations', label: 'Error result', desc: 'Turn billed but failed' },
  'error-evaluation': { kind: 'turn', group: 'housekeeping', label: 'Error evaluation', desc: 'Error recovery evaluation' },
  evidence: { kind: 'auxiliary', group: 'memoryNotes', label: 'Evidence collection', desc: 'Evidence collection from sessions', btsTaskGroup: 'memory' },
  fileIndex: { kind: 'auxiliary', group: 'fileIntelligence', label: 'File indexing', desc: 'Building searchable file index' },
  foraging: { kind: 'auxiliary', group: 'housekeeping', label: 'Content foraging', desc: 'Extractive content triage', btsTaskGroup: 'foraging' },
  'hero-choice': { kind: 'auxiliary', group: 'housekeeping', label: 'Daily hero choice', desc: 'Personalised homepage recommendations', btsTaskGroup: 'hero-choice' },
  indexing: { kind: 'auxiliary', group: 'fileIntelligence', label: 'Indexing', desc: 'BTS contextual retrieval' },
  'meeting-qa': { kind: 'auxiliary', group: 'conversations', label: 'Meeting Q&A', desc: 'Meeting bot Q&A responses', btsTaskGroup: 'meetings' },
  'meeting-state': { kind: 'auxiliary', group: 'conversations', label: 'Meeting state', desc: 'Meeting state tracking', btsTaskGroup: 'meetings' },
  'meeting-summary': { kind: 'auxiliary', group: 'conversations', label: 'Meeting summary', desc: 'Transcript summarisation', btsTaskGroup: 'meetings' },
  memory: { kind: 'auxiliary', group: 'memoryNotes', label: 'Memory updates', desc: 'Summarising memories', btsTaskGroup: 'memory' },
  memoryWrite: { kind: 'auxiliary', group: 'safetyChecks', label: 'Memory safety', desc: 'Checking memory write requests', btsTaskGroup: 'safety' },
  metadata: { kind: 'auxiliary', group: 'housekeeping', label: 'Metadata', desc: 'Title generation and metadata operations' },
  'plugin-ai': { kind: 'auxiliary', group: 'conversations', label: 'Plugin AI', desc: 'Plugin AI operations' },
  queryGeneration: { kind: 'auxiliary', group: 'fileIntelligence', label: 'Query generation', desc: 'Pre-turn search query generation', btsTaskGroup: 'search' },
  quip: { kind: 'auxiliary', group: 'housekeeping', label: 'Personality', desc: 'Generating witty remarks' },
  safety: { kind: 'auxiliary', group: 'safetyChecks', label: 'Tool safety', desc: 'Evaluating tool call risks', btsTaskGroup: 'safety' },
  scratchpad: { kind: 'auxiliary', group: 'memoryNotes', label: 'Scratchpad', desc: 'Organising notes' },
  semantic: { kind: 'auxiliary', group: 'fileIntelligence', label: 'Semantic search', desc: 'Finding relevant context' },
  spaceDescription: { kind: 'auxiliary', group: 'memoryNotes', label: 'Space descriptions', desc: 'Space description generation' },
  spacesSynthesis: { kind: 'auxiliary', group: 'memoryNotes', label: 'Spaces synthesis', desc: 'Weekly activity summaries' },
  stt: { kind: 'auxiliary', group: 'conversations', label: 'Speech-to-text', desc: 'Voice transcription (Whisper, Scribe)' },
  system: { kind: 'auxiliary', group: 'housekeeping', label: 'System', desc: 'System health checks' },
  'system-improvement': { kind: 'auxiliary', group: 'housekeeping', label: 'Self-improvement', desc: 'Post-session analysis', btsTaskGroup: 'improvement' },
  timeSaved: { kind: 'auxiliary', group: 'housekeeping', label: 'Time estimates', desc: 'Calculating time saved', btsTaskGroup: 'coaching' },
  useCaseDiscovery: { kind: 'auxiliary', group: 'housekeeping', label: 'Use case discovery', desc: 'Personalised use case generation' },
  'video-recs': { kind: 'auxiliary', group: 'housekeeping', label: 'Video picks', desc: 'Personalised community video recommendations', btsTaskGroup: 'hero-choice' },
  warmup: { kind: 'auxiliary', group: 'housekeeping', label: 'Cache warmup', desc: 'Prompt cache warming' },
  'watchdog-judge': { kind: 'auxiliary', group: 'housekeeping', label: 'Time checks', desc: 'Long-running turn time checks' },
  weekly_assessment: { kind: 'auxiliary', group: 'housekeeping', label: 'Weekly assessment', desc: 'Weekly usage assessment', btsTaskGroup: 'improvement' },
} as const satisfies Record<string, CostCategoryMeta>;

// -----------------------------------------------------------------------------
// Derived types
// -----------------------------------------------------------------------------

/** Union of all known cost category keys */
export type CostCategoryKey = keyof typeof COST_CATEGORY_REGISTRY;

/** Categories used by behind-the-scenes (BTS) callers — derived from kind: 'auxiliary' */
export type AuxiliaryCostCategory = {
  [K in CostCategoryKey]: (typeof COST_CATEGORY_REGISTRY)[K]['kind'] extends 'auxiliary' ? K : never;
}[CostCategoryKey];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Lookup the UI cost group for a category, with fallback to 'housekeeping' for unknown strings */
export function groupForCategory(cat: string): CostGroupKey {
  const entry = (COST_CATEGORY_REGISTRY as Record<string, CostCategoryMeta>)[cat];
  return entry?.group ?? 'housekeeping';
}

/** Lookup the human-readable label for a category, with fallback to capitalised raw string */
export function labelForCategory(cat: string): string {
  const entry = (COST_CATEGORY_REGISTRY as Record<string, CostCategoryMeta>)[cat];
  if (entry) return entry.label;
  // Fallback: capitalise first letter, replace hyphens/underscores with spaces
  return cat.charAt(0).toUpperCase() + cat.slice(1).replace(/[-_]/g, ' ');
}

/** Lookup the optional description for a category */
export function descForCategory(cat: string): string | undefined {
  const entry = (COST_CATEGORY_REGISTRY as Record<string, CostCategoryMeta>)[cat];
  return entry?.desc;
}

/** Reverse mapping: return all category keys belonging to a given group */
export function categoriesForGroup(group: CostGroupKey): string[] {
  return Object.entries(COST_CATEGORY_REGISTRY)
    .filter(([, meta]) => meta.group === group)
    .map(([cat]) => cat);
}

/** Set of all known category keys (for distinguishing known vs unknown categories) */
export const ALL_KNOWN_CATEGORIES = new Set(Object.keys(COST_CATEGORY_REGISTRY));
