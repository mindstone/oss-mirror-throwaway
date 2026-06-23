import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import { sharedNunjucksEnv } from '@core/services/nunjucksConfig';

const log = createScopedLogger({ service: 'promptTemplate' });

// =============================================================================
// Zod Schemas
// =============================================================================

/** Schema for space summary included in env block */
export const SpaceSummarySchema = z.object({
  name: z.string().min(1, 'Space name is required'),
  path: z.string().min(1, 'Space path is required'),
  description: z.string(),
  type: z.string().optional(),
  sharing: z.string().optional(),
  /** Effective associated accounts for this Space (local account bindings plus safe README domain hints) */
  emails: z.array(z.string()).optional(),
  /** Organisation name for this space (for skills that reference {COMPANY_NAME}) */
  organisationName: z.string().optional(),
  /** Whether the space directory is writable. true = writable, false = read-only, undefined = not yet checked */
  writable: z.boolean().optional(),
});
export type SpaceSummary = z.infer<typeof SpaceSummarySchema>;

export const OrganisationSpaceGroupSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  spaces: z.array(SpaceSummarySchema),
});
export type OrganisationSpaceGroup = z.infer<typeof OrganisationSpaceGroupSchema>;

export const OperatorPromptMetadataSchema = z.object({
  id: z.string().min(1, 'Operator id is required'),
  name: z.string().min(1, 'Operator name is required'),
  displayName: z.string().optional(),
  description: z.string(),
  consult_when: z.string(),
});
export type OperatorPromptMetadata = z.infer<typeof OperatorPromptMetadataSchema>;

/** Schema for frequently-used tools injected into system prompt */
const FrequentToolSchema = z.object({
  toolName: z.string().min(1, 'Tool name is required'),
  shortName: z.string().min(1, 'Short name is required'),
  params: z.array(z.string()).default([]),
});
export type FrequentTool = z.infer<typeof FrequentToolSchema>;

/** Schema for a capability provided by a connected MCP package */
const ConnectedPackageCapabilitySchema = z.object({
  id: z.string(),
  promptGuidance: z.string().optional(),
});

/** Schema for connected MCP packages injected into system prompt */
export const ConnectedPackageSchema = z.object({
  name: z.string().min(1, 'Package name is required'),
  description: z.string(),
  capabilities: z.array(ConnectedPackageCapabilitySchema).default([]),
});
export type ConnectedPackage = z.infer<typeof ConnectedPackageSchema>;

/** Schema for typed parameter info in grouped tools */
const ParamTypeInfoSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  format: z.string().optional(),
  required: z.boolean().optional(),
});

/** Schema for a tool within a grouped package */
const GroupedToolSchema = z.object({
  shortName: z.string().min(1, 'Short name is required'),
  params: z.array(z.string()).default([]),
  typedParams: z.array(ParamTypeInfoSchema).optional(),
});
export type GroupedTool = z.infer<typeof GroupedToolSchema>;

/** Schema for frequent tools grouped by server */
export const FrequentToolGroupSchema = z.object({
  serverId: z.string().min(1, 'Server ID is required'),
  serverDescription: z.string(),
  tools: z.array(GroupedToolSchema).min(1, 'At least one tool is required'),
});
export type FrequentToolGroup = z.infer<typeof FrequentToolGroupSchema>;

/** Session type enum for agent context awareness */
export const SessionTypeSchema = z.enum(['interactive', 'automation', 'cli', 'mcp_server']);
export type SessionType = z.infer<typeof SessionTypeSchema>;

/** Schema for environment context passed to the template */
export const EnvContextSchema = z.object({
  date: z.string().min(1, 'date is required'),
  timeOfDayBucket: z.string().min(1, 'timeOfDayBucket is required'),
  timezone: z.string().min(1, 'timezone is required'),
  locale: z.string().min(1, 'locale is required'),
  userName: z.string().optional(),
  platform: z.string().min(1, 'platform is required'),
  appVersion: z.string().min(1, 'appVersion is required'),
  buildChannel: z.string().min(1, 'buildChannel is required'),
  workspacePath: z.string().min(1, 'workspacePath is required'),
  mcpConfigPath: z.string().min(1, 'mcpConfigPath is required'),
  model: z.string().min(1, 'model is required'),
  surfaceCapability: z.enum(['desktop', 'cloud']),
  spaces: z.array(SpaceSummarySchema).optional(),
  organisations: z.array(OrganisationSpaceGroupSchema).optional(),
  unorganisedSpaces: z.array(SpaceSummarySchema).optional(),
  operators: z.array(OperatorPromptMetadataSchema).default([]),
  // Session mode context — see help-for-humans/session-modes.md
  sessionType: SessionTypeSchema.optional(),
  privacyMode: z.boolean().optional(),
  voiceActive: z.boolean().optional(),
  // Safe Mode context — injected when app is running in Safe Mode
  isSafeMode: z.boolean().optional(),
  safeModeReason: z.string().optional(),
  safeModeErrorCategory: z.string().optional(),
  safeModeSentryEventId: z.string().optional(),
  // Windows Python blocked — injected when Windows Store aliases are blocking Python commands
  windowsPythonBlocked: z.boolean().optional(),
  // Conversation session ID — used by contribution tools to link records to this session
  sessionId: z.string().optional(),
});
export type EnvContext = z.infer<typeof EnvContextSchema>;

/** Schema for the full composite prompt context */
export const CompositePromptContextSchema = z.object({
  rebelSystemMd: z.string().min(1, 'rebelSystemMd is required and cannot be empty'),
  chiefOfStaffMd: z.string().min(1, 'chiefOfStaffMd is required and cannot be empty'),
  runningInRebelApp: z.boolean(),
  env: EnvContextSchema,
  /**
   * User-set success criterion for the conversation ("finish line"), pre-fenced
   * via `fenceUntrustedContent` at the context-builder layer. The raw user input
   * is capped at 500 chars upstream by `normalizeFinishLine`; the cap here is
   * looser to accommodate the XML fence + warning-text wrapper (~180 chars).
   * The `{% if finishLine %}` block in `rebel-system/AGENTS.md` renders it as the
   * dominant stop signal. Resolved at turn admission — see
   * `docs/plans/260515_finish_line.md`.
   */
  finishLine: z.string().max(1024).optional(),
  /** Frequently-used tools (personalized based on user's usage patterns) - DEPRECATED, use frequentToolGroups */
  frequentTools: z.array(FrequentToolSchema).default([]),
  /** Frequent tools grouped by package (for improved prompt rendering) */
  frequentToolGroups: z.array(FrequentToolGroupSchema).default([]),
  /** Connected MCP tool packages available in this session */
  connectedPackages: z.array(ConnectedPackageSchema).default([]),
});
export type CompositePromptContext = z.infer<typeof CompositePromptContextSchema>;

/** Schema for space frontmatter in README.md (or legacy AGENTS.md) files */
export const SpaceFrontmatterSchema = z.object({
  rebel_space_description: z.string().min(1, 'rebel_space_description is required to identify as a Rebel space'),
  /** Custom display name for the space (e.g., "Mindstone - Exec" instead of path) */
  display_name: z.string().optional(),
  /**
   * Organisation name for this space. Used by skills that reference {COMPANY_NAME}.
   * This is space-specific (not global) so different work spaces can have different orgs.
   */
  organisation_name: z.string().optional(),
  space_type: z.enum(['personal', 'company', 'team', 'shared', 'project', 'router', 'operator']).optional(),
  sharing: z.enum(['private', 'restricted', 'team', 'company-wide', 'public']).optional(),
  sensitivity: z.enum(['standard', 'confidential', 'restricted']).optional(),
  /** Memory trust level for this space - overrides global memorySafetyLevel */
  memoryTrust: z.enum(['always_ask', 'balanced', 'always_write']).optional(),
  related_spaces: z.array(z.string()).optional(),
  owner: z.string().email().optional(),
  /**
   * Shared associated-account hints for this Space. Used by AI to match MCPs to Spaces
   * only when no user-local SpaceConfig.associatedAccounts decision exists.
   * Supports exact emails ([external-email]) and domain wildcards (acme.com - bare domain).
   */
  emails: z.array(z.string()).optional(),
  /**
   * Last reviewed date for personal goals (Chief-of-Staff only).
   * Format: YYYY-MM-DD. Used by UI to detect staleness (>90 days = needs review).
   * The full personal_goals structure is in frontmatter but not validated here
   * (agent writes it directly, UI only needs this date for staleness detection).
   */
  personal_goals_last_reviewed: z.string().optional(),
  /**
   * Last reviewed date for company values (company/team spaces).
   * Format: YYYY-MM-DD. Used by UI to detect staleness.
   */
  company_values_last_reviewed: z.string().optional(),
});
export type SpaceFrontmatter = z.infer<typeof SpaceFrontmatterSchema>;

const EXTERNAL_IDE_FALLBACK_PATTERN = /<!--\s*EXTERNAL-IDE-FALLBACK:BEGIN\s*-->[\s\S]*?<!--\s*EXTERNAL-IDE-FALLBACK:END\s*-->/gi;

// =============================================================================
// Composite Prompt Rendering
// =============================================================================
// The system prompt is now composed by rendering rebel-system/AGENTS.md as a
// Nunjucks template. This file contains {{ chiefOfStaffMd }} and {{ env.* }}
// variables that are substituted at runtime.
//
// This approach gives rebel-system control over the narrative flow and where
// user content (Chief-of-Staff) and environment context are placed.
//
// The template uses Nunjucks {{ variable }} syntax for actual variable substitution.
// This is separate from the {PLACEHOLDER} convention used in user-facing templates
// (like README-template-for-Chief-of-Staff.md) where single-curly-brace placeholders
// are indicative markers for users to manually fill in, not Nunjucks variables.

// Uses shared Nunjucks environment from nunjucksConfig.ts
const nunjucksEnv = sharedNunjucksEnv;

/**
 * Strips EXTERNAL-IDE-FALLBACK blocks from rebel-system content.
 * These blocks are only relevant for Cursor/external IDE fallback.
 */
export const stripExternalIdeFallback = (content: string): string => {
  return content.replace(EXTERNAL_IDE_FALLBACK_PATTERN, '').trim();
};

/**
 * Renders the composite system prompt by using rebel-system/AGENTS.md as a
 * Nunjucks template. The rebel-system file contains {{ chiefOfStaffMd }} and
 * {{ env.* }} variables that are substituted with the provided context.
 *
 * This approach gives rebel-system control over the narrative flow and where
 * user content (Chief-of-Staff) and environment context are placed in the
 * final system prompt.
 */
export const renderCompositePrompt = (context: CompositePromptContext): string => {
  // Strip EXTERNAL-IDE-FALLBACK blocks when running in Rebel app
  // These blocks are only relevant for external IDEs (Cursor, Claude Code) that
  // read the file directly from disk without Nunjucks rendering
  const templateContent = context.runningInRebelApp
    ? stripExternalIdeFallback(context.rebelSystemMd)
    : context.rebelSystemMd;

  try {
    // Render rebel-system/AGENTS.md as the template, substituting chiefOfStaffMd and env
    const rendered = nunjucksEnv.renderString(templateContent, context);
    return rendered;
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'Failed to render composite system prompt'
    );
    throw new Error(
      `Composite system prompt rendering failed: ${error instanceof Error ? error.message : String(error)}. Run \`npm run prompt:doctor\` for diagnostics.`
    );
  }
};
