import { normalize } from 'pathe';

export type OnboardingStep = 'welcome' | 'workspace' | 'api' | 'tools' | 'permissions' | 'googleDrive' | 'voiceSetup' | 'toolAuth';

/**
 * High-level onboarding stages that form the full onboarding funnel.
 * Tracks progression through: wizard → coach → ui_reveal → tutorial → spark
 */
export type OnboardingStage = 'wizard' | 'coach' | 'ui_reveal' | 'tutorial' | 'spark';

/**
 * Semantic names for tutorial checklist steps.
 * Maps numeric step IDs to human-readable names for analytics.
 */
export type TutorialStepName = 'meet_rebel' | 'connector' | 'skill' | 'memory' | 'use_case';

/**
 * Maps numeric tutorial step IDs to semantic names.
 */
export const TUTORIAL_STEP_NAMES: Record<number, TutorialStepName> = {
  0: 'meet_rebel',
  1: 'connector',
  2: 'skill',
  3: 'memory',
  4: 'use_case',
};

export type ToolCategory = 'builtin' | 'filesystem' | 'shell' | 'network' | 'integration' | 'planning';

export type FileOperation = 'create' | 'edit';

export interface ToolUsageMap {
  [toolName: string]: number;
}

export interface ToolUsageByCategory {
  [category: string]: number;
}

export interface McpServerUsage {
  [serverName: string]: number;
}

// Known MCP servers we want to track explicitly
export const TRACKED_MCP_SERVERS = [
  'gmail',
  'google-calendar',
  'outlook',
  'outlook-calendar', 
  'notion',
  'slack',
  'teams',
] as const;

export type TrackedMcpServer = typeof TRACKED_MCP_SERVERS[number];

const INFRA_SERVER_NAMES = ['super-mcp-router', 'mcp'];

/**
 * Extract MCP server name from tool name.
 * Tool names come in as "package_id/tool_id" (e.g., "bundled-google/gmail_read_email")
 * or just "tool_name" for built-in tools.
 * 
 * For routed MCP tools (via Super-MCP), the package_id is the router name,
 * so we need to detect the actual service from the tool_id prefix.
 */
export const extractMcpServer = (toolName: string): string | null => {
  // Direct HTTP MCP tools: "mcp__server__tool" (e.g., mcp__notion__search_pages)
  // Require 3+ segments (mcp, server, tool) to avoid misclassifying "mcp__toolname"
  if (toolName.startsWith('mcp__') && !toolName.includes('/')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) {
      const serverId = parts[1]?.toLowerCase();
      if (serverId && !INFRA_SERVER_NAMES.includes(serverId)) {
        return serverId;
      }
    }
    return null;
  }

  const lowerName = toolName.toLowerCase();
  
  // Check for service prefixes in the tool name (handles both routed and direct tools)
  // Order matters - check more specific patterns first
  if (lowerName.includes('google_calendar') || lowerName.includes('gcal')) {
    return 'google-calendar';
  }
  if (lowerName.includes('outlook_calendar')) {
    return 'outlook-calendar';
  }
  if (lowerName.includes('gmail') || lowerName.includes('google_mail')) {
    return 'gmail';
  }
  if (lowerName.includes('outlook') || lowerName.includes('microsoft_outlook')) {
    return 'outlook';
  }
  if (lowerName.includes('notion')) {
    return 'notion';
  }
  if (lowerName.includes('slack')) {
    return 'slack';
  }
  if (lowerName.includes('teams') || lowerName.includes('microsoft_teams')) {
    return 'teams';
  }
  
  // Fallback: if it contains / but no known service, it might be an unknown MCP tool
  if (toolName.includes('/')) {
    const serverId = toolName.split('/')[0].toLowerCase();
    if (!INFRA_SERVER_NAMES.includes(serverId)) {
      return serverId;
    }
  }
  
  return null;
};

/**
 * Strip instance-specific suffixes from server IDs before analytics emission.
 * Server IDs like "GoogleWorkspace-greg-work-com" contain PII-derived segments;
 * this strips trailing -user-domain-tld patterns and embedded email addresses.
 */
export const sanitizeServerIdForAnalytics = (serverId: string): string => {
  let cleaned = serverId.toLowerCase();
  cleaned = cleaned.replace(/@[a-z0-9.-]+/g, '');
  cleaned = cleaned.replace(
    /-[a-z0-9]+-[a-z0-9]+-(com|io|org|net|co|dev|app|ai|edu|gov)$/,
    ''
  );
  cleaned = cleaned.replace(/-+$/, '');
  return cleaned || serverId.toLowerCase();
};

export interface TurnToolMetrics {
  toolUsage: ToolUsageMap;
  toolUsageByCategory: ToolUsageByCategory;
  mcpServerUsage: McpServerUsage;
  totalToolCalls: number;
  failedToolCalls: number;
  filesCreated: number;
  filesEdited: number;
  workArtifactsCreated?: number;
  workArtifactsCreatedByType?: Record<string, number>;
  memoryFilesModified: number;
  skillFilesModified: number;
  // Tool output sizes (proxy for tokens consumed by tool results)
  totalToolOutputChars: number;
  mcpToolOutputChars: number;
  builtinToolOutputChars: number;
}

export interface TurnSubAgentMetrics {
  usedSubAgents: boolean;
  subAgentCount: number;
  subAgentTypes: string[];
  subAgentToolCount: number;
}

export type SubscriptionTraitTier = 'dash' | 'rogue';
export type SubscriptionTraitStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'trialing'
  | 'inactive';

export interface SubscriptionTraits {
  tier: SubscriptionTraitTier;
  status: SubscriptionTraitStatus;
  cancelAtPeriodEnd?: boolean;
}

export type CouncilSkippedMemberEventName = 'Council Skipped Member';
export type CouncilBlockedEventName = 'Council Blocked';
export type CouncilTrackingEventName = CouncilSkippedMemberEventName | CouncilBlockedEventName;
export type CouncilSkipReason = 'not-in-managed-allowlist' | 'no-byok-credential';
export type CouncilBlockedReason = 'no-eligible-members';

export interface UserTraits {
  appVersion: string;
  buildChannel: 'stable' | 'beta' | 'dev';
  platform: string;
  arch: string;
  voiceProvider: string | null;
  permissionMode: string;
  mcpMode: string;
  hasWorkspace: boolean;
  hasMcpConfig: boolean;
  planMode: boolean;
  extendedContext: boolean;
  onboardingCompleted: boolean;
  onboardingFirstCompletedAt: number | null;
  subscription?: SubscriptionTraits;
  companyId?: string;
  companyName?: string;
  accountId?: string;
  accountName?: string;
  accountAttributionSource?: string;
  company_id?: string;
  company_name?: string;
  company_slug?: string;
  account_id?: string;
  account_name?: string;
  account_slug?: string;
  account_attribution_source?: string;
  licenseTier?: string;
  organization_id?: string;
  organization_slug?: string;
  organization_name?: string;
  team_id?: string | null;
  team_name?: string | null;
}

export type AnalyticsAttributionInput = {
  companyName?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  source?: string | null;
  licenseTier?: string | null;
  organizationId?: string | null;
  organizationSlug?: string | null;
  organizationName?: string | null;
  teamId?: string | null;
  teamName?: string | null;
};

export type AnalyticsAttributionProperties = {
  companyId?: string;
  companyName?: string;
  accountId?: string;
  accountName?: string;
  accountAttributionSource?: string;
  company_id?: string;
  company_name?: string;
  company_slug?: string;
  account_id?: string;
  account_name?: string;
  account_slug?: string;
  account_attribution_source?: string;
  licenseTier?: string;
  organization_id?: string;
  organization_slug?: string;
  organization_name?: string;
  team_id?: string | null;
  team_name?: string | null;
};

export type MilestoneType =
  | 'first_message_sent'
  | 'first_voice_message'
  | 'first_tool_connected'
  | 'first_automation_created'
  | 'first_automation_run_success'
  | 'first_task_executed'
  | 'first_inbox_item_executed'
  | 'first_tutorial_watched'
  | 'first_connector_connected'
  | 'first_coaching_acted'
  | 'safety_settings_customized'
  | 'memory_settings_customized'
  // Journey milestones
  | 'journey_week_1_complete'
  | 'journey_graduated';

export const hashSessionId = (sessionId: string): string => {
  // Simple hash that works in both browser and Node
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    const char = sessionId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(16, '0').slice(0, 16);
};

const normalizeAnalyticsDimension = (value: string | null | undefined): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

const slugifyAnalyticsDimension = (value: string | null): string | null => {
  if (!value) return null;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
};

export const buildAnalyticsAttributionProperties = (
  input: AnalyticsAttributionInput
): AnalyticsAttributionProperties => {
  const companyName = normalizeAnalyticsDimension(input.companyName);
  const accountId = normalizeAnalyticsDimension(input.accountId);
  const accountName = normalizeAnalyticsDimension(input.accountName) ?? companyName;
  const source = normalizeAnalyticsDimension(input.source);
  const licenseTier = normalizeAnalyticsDimension(input.licenseTier);
  const organizationId = normalizeAnalyticsDimension(input.organizationId);
  const organizationSlug = normalizeAnalyticsDimension(input.organizationSlug);
  const organizationName = normalizeAnalyticsDimension(input.organizationName);
  const teamId = normalizeAnalyticsDimension(input.teamId ?? undefined);
  const teamName = normalizeAnalyticsDimension(input.teamName ?? undefined);
  const companyId = companyName ? hashSessionId(companyName.toLowerCase()) : null;
  const derivedAccountId = accountId ?? (accountName ? hashSessionId(accountName.toLowerCase()) : null);
  const companySlug = slugifyAnalyticsDimension(companyName);
  const accountSlug = slugifyAnalyticsDimension(accountName);

  return {
    ...(companyName ? {
      companyName,
      companyId: companyId ?? undefined,
      company_id: companyId ?? undefined,
      company_name: companyName,
      ...(companySlug ? { company_slug: companySlug } : {}),
    } : {}),
    ...(derivedAccountId ? { accountId: derivedAccountId, account_id: derivedAccountId } : {}),
    ...(accountName ? { accountName, account_name: accountName } : {}),
    ...(accountSlug ? { account_slug: accountSlug } : {}),
    ...(source ? { accountAttributionSource: source, account_attribution_source: source } : {}),
    ...(licenseTier ? { licenseTier } : {}),
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(organizationSlug ? { organization_slug: organizationSlug } : {}),
    ...(organizationName ? { organization_name: organizationName } : {}),
    ...(teamId ? { team_id: teamId } : {}),
    ...(teamName ? { team_name: teamName } : {}),
  };
};

/**
 * Build the desktop analytics context-provider payload — the object merged into
 * every desktop `track()` event via `setAnalyticsContextProvider` in
 * `src/main/index.ts`. Pure (no module-state reads) so the
 * `client_surface: 'desktop'` invariant is unit-testable without the Electron
 * main graph; it mirrors the cloud provider's shape (`cloud-service/src/bootstrap.ts`,
 * `client_surface: 'cloud'`).
 *
 * Key choice: `client_surface` (NOT `surface`) — a non-colliding key, distinct
 * from the per-event `surface` property used for chat_checkpoint / nps_survey.
 */
export const buildDesktopAnalyticsContext = (
  input: {
    companyName?: string | null;
    source?: string | null;
    licenseTier?: string | null;
  } = {}
): Record<string, unknown> => ({
  client_surface: 'desktop',
  ...buildAnalyticsAttributionProperties({
    companyName: input.companyName ?? null,
    source: input.source ?? null,
  }),
  licenseTier: input.licenseTier ?? 'free',
});

export const isMemoryFile = (filePath: string): boolean => {
  const parts = normalize(filePath).split('/');
  const parents = parts.slice(-4, -1);
  return parents.some(dir => dir.toLowerCase() === 'memory');
};

export const isSkillFile = (filePath: string): boolean => {
  const parts = normalize(filePath).split('/');
  const parents = parts.slice(-4, -1);
  return parents.some(dir => dir.toLowerCase() === 'skills');
};

/**
 * Check if a file is a space instructions file (README.md at a space root).
 * These are high-salience files that define space behavior and user instructions.
 * 
 * Matches (works with both relative and absolute paths):
 * - Chief-of-Staff/README.md (private instructions)
 * - work/Company/Space/README.md (shared space instructions)
 * - personal/README.md (personal space)
 * 
 * Does NOT match:
 * - Chief-of-Staff/memory/topics/README.md (nested, not space root)
 * - docs/README.md (not a recognized space pattern)
 * - README.md (root level, no space)
 * - Projects/README.md (not an explicitly recognized space)
 * 
 * Note: This uses a conservative allowlist approach to avoid false positives.
 * If new space types are added, this function should be updated.
 */
export const isInstructionsFile = (filePath: string): boolean => {
  const parts = normalize(filePath).split('/');
  const fileName = parts[parts.length - 1];
  
  // Must be a README.md file (case-insensitive)
  if (fileName.toLowerCase() !== 'readme.md') {
    return false;
  }
  
  // Need at least 2 parts (space/README.md)
  if (parts.length < 2) {
    return false;
  }
  
  // Get the trailing segments to match patterns regardless of absolute path prefix
  // For Chief-of-Staff/README.md, we need last 2 parts
  // For work/Company/Space/README.md, we need last 4 parts
  const last2 = parts.slice(-2);
  const last4 = parts.slice(-4);
  
  // Pattern 1: Chief-of-Staff/README.md
  if (last2[0].toLowerCase() === 'chief-of-staff') {
    return true;
  }
  
  // Pattern 2: work/Company/Space/README.md
  if (parts.length >= 4 && last4[0].toLowerCase() === 'work') {
    return true;
  }
  
  // Pattern 3: personal/README.md (known private space)
  if (last2[0].toLowerCase() === 'personal') {
    return true;
  }
  
  // Don't match arbitrary SpaceName/README.md to avoid false positives
  // (e.g., docs/README.md, src/README.md)
  return false;
};

export const getFileExtension = (filePath: string): string => {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
};

// Known built-in tools mapped to their correct category
const BUILTIN_TOOL_CATEGORIES = new Map<string, ToolCategory>([
  ['read', 'filesystem'],
  ['write', 'filesystem'],
  ['edit', 'filesystem'],
  ['multiedit', 'filesystem'],
  ['glob', 'filesystem'],
  ['grep', 'filesystem'],
  ['ls', 'filesystem'],
  ['bash', 'shell'],
  ['todoread', 'planning'],
  ['todowrite', 'planning'],
  ['notebook', 'builtin'],
]);

export const deriveToolCategory = (toolName: string): ToolCategory => {
  const name = toolName.toLowerCase();

  // MCP routed tools use "package_id/tool_id" format — classify as integration
  // unless the tool itself matches a known built-in name
  if (toolName.includes('/')) {
    const toolId = toolName.split('/').pop()?.toLowerCase() ?? '';
    const builtinCategory = BUILTIN_TOOL_CATEGORIES.get(toolId);
    if (builtinCategory) {
      return builtinCategory; // built-in tool accessed via router
    }
    // Check for known integration services in the tool name
    if (['slack', 'gmail', 'email', 'calendar', 'drive', 'notion', 'outlook', 'teams'].some(t => name.includes(t))) {
      return 'integration';
    }
    return 'integration'; // default for routed MCP tools
  }

  // Check integration keywords BEFORE filesystem to avoid misclassification
  // (e.g., "slack_list_channels" was incorrectly matched as filesystem by "list")
  if (['slack', 'gmail', 'email', 'calendar', 'drive', 'notion', 'outlook', 'teams'].some(t => name.includes(t))) {
    return 'integration';
  }
  if (['task', 'plan', 'agent', 'workflow', 'todo'].some(t => name.includes(t))) {
    return 'planning';
  }
  if (['bash', 'shell', 'terminal', 'command', 'exec'].some(t => name.includes(t))) {
    return 'shell';
  }
  if (['http', 'fetch', 'request', 'api', 'url', 'web'].some(t => name.includes(t))) {
    return 'network';
  }
  if (['read', 'write', 'edit', 'create', 'delete', 'list', 'glob', 'grep', 'search'].some(t => name.includes(t))) {
    return 'filesystem';
  }

  return 'builtin';
};

export const deriveFileOperation = (toolName: string): FileOperation | null => {
  const name = toolName.toLowerCase();
  
  if (['create', 'touch', 'mkdir'].some(t => name.includes(t))) {
    return 'create';
  }
  if (['write', 'edit', 'patch', 'update', 'append'].some(t => name.includes(t))) {
    return 'edit';
  }
  
  return null;
};
