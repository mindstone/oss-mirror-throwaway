/**
 * Pure utilities for approval-related UI across desktop and mobile.
 *
 * Tool humanization, jargon detection, generic-reason detection, and
 * service-name extraction — all pure functions with no React, Zustand, or
 * platform imports.
 *
 * This file lives in `@rebel/shared` because it is consumed by:
 * - `src/renderer/` (desktop approval UI)
 * - `cloud-client/` (cross-surface approval hooks after Stage 3)
 * - `mobile/` (mobile approval sheets after Stage 6)
 *
 * See `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md` Stage 1.
 */

// =============================================================================
// Tool Name Humanization
// =============================================================================

/**
 * User-friendly display config for raw tool names.
 * These tool names come from built-in or MCP tools and would be
 * meaningless jargon to a knowledge worker.
 *
 * Each entry has:
 * - header: Shown as the main approval label (standalone sentence, not "Allow X?" format)
 * - subtitle: Shown below the header when the LLM-generated reason is generic/unavailable
 * - friendlyName: Short name for use in detail views and notification cards
 *
 * Copy was A/B tested against 7 personas (EA, AE, PM, Researcher, New Hire,
 * Skeptic, Power User) — see docs/project/ux_testing/personas/.
 */
export interface ToolDisplayConfig {
  header: string;
  subtitle: string;
  friendlyName: string;
}

export const TOOL_DISPLAY_CONFIG: Record<string, ToolDisplayConfig> = {
  // Built-in tools
  'Bash': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
  'Computer': {
    header: 'Rebel wants to interact with your screen',
    subtitle: 'Rebel needs to view or click on something on your screen',
    friendlyName: 'Screen interaction',
  },
  'TextEditor': {
    header: 'Rebel wants to edit a file',
    subtitle: 'Rebel needs to make changes to a file on your computer',
    friendlyName: 'File edit',
  },
  'str_replace_editor': {
    header: 'Rebel wants to edit a file',
    subtitle: 'Rebel needs to make changes to a file on your computer',
    friendlyName: 'File edit',
  },
  'text_editor': {
    header: 'Rebel wants to edit a file',
    subtitle: 'Rebel needs to make changes to a file on your computer',
    friendlyName: 'File edit',
  },
  // Generic/unhelpful tool names
  'Task': {
    header: 'Rebel is working in the background',
    subtitle: 'A step is running behind the scenes to help with your request',
    friendlyName: 'Background task',
  },
  'Agent': {
    header: 'Rebel is working in the background',
    subtitle: 'A step is running behind the scenes to help with your request',
    friendlyName: 'Background task',
  },
  'Execute': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
};

// Build case-insensitive lookup (lowercase key → config)
const TOOL_DISPLAY_LOOKUP = new Map<string, ToolDisplayConfig>();
for (const [key, config] of Object.entries(TOOL_DISPLAY_CONFIG)) {
  TOOL_DISPLAY_LOOKUP.set(key.toLowerCase(), config);
}

/**
 * Tool names that are developer jargon and should never appear in user-facing
 * approval headers. When these are the only label available, fall back to
 * the generic "Action needs your OK" instead.
 */
export const JARGON_TOOL_NAMES = new Set([
  'bash', 'computer', 'texteditor', 'text_editor', 'str_replace_editor',
  'execute', 'task', 'agent', 'shell', 'cmd', 'powershell', 'terminal',
  'subprocess', 'exec', 'run', 'spawn',
]);

/**
 * Get the full display config for a tool (header, subtitle, friendlyName).
 * Returns null if no config is known for this tool name.
 */
export function getToolDisplayConfig(rawToolName: string): ToolDisplayConfig | null {
  return TOOL_DISPLAY_LOOKUP.get(rawToolName.toLowerCase()) ?? null;
}

/**
 * Get a user-friendly short name for a tool (e.g., "Local task", "File edit").
 * Returns null if no friendly name is known (caller decides fallback).
 */
export function getFriendlyToolName(rawToolName: string): string | null {
  return TOOL_DISPLAY_LOOKUP.get(rawToolName.toLowerCase())?.friendlyName ?? null;
}

/**
 * Get a user-friendly header label for a jargon tool (standalone sentence).
 * Returns null if no config is known for this tool name.
 */
export function getToolHeader(rawToolName: string): string | null {
  return TOOL_DISPLAY_LOOKUP.get(rawToolName.toLowerCase())?.header ?? null;
}

/**
 * Get a fallback subtitle for a tool (when the LLM reason is generic).
 * Returns a tool-specific subtitle if available, or a generic one for
 * any tool in the jargon blocklist. Returns null only for non-jargon tools
 * (which have their own display names like "Gmail").
 */
export function getToolFallbackSubtitle(rawToolName: string): string | null {
  const config = TOOL_DISPLAY_LOOKUP.get(rawToolName.toLowerCase());
  if (config) return config.subtitle;
  // For jargon tools without a specific config, use a safe generic subtitle
  if (isJargonToolName(rawToolName)) {
    return 'Part of completing what you asked — runs on your device';
  }
  return null;
}

/**
 * Check if a tool name is developer jargon that shouldn't be shown to users.
 */
export function isJargonToolName(toolName: string): boolean {
  return JARGON_TOOL_NAMES.has(toolName.toLowerCase());
}

/**
 * Detect if a reason string is a generic/unhelpful fallback that doesn't
 * actually describe what the tool does.
 */
export function isGenericReason(reason: string | undefined): boolean {
  if (!reason) return true;
  // Strip the common "Safety Rules blocked:" prefix so the check works
  // whether the caller already stripped it or not.
  const SAFETY_PREFIX = 'safety rules blocked:';
  let lower = reason.toLowerCase();
  if (lower.startsWith(SAFETY_PREFIX)) {
    lower = lower.slice(SAFETY_PREFIX.length).trim();
  }
  return (
    lower === 'requires your approval to continue' ||
    lower === 'needs your ok to continue' ||
    lower === 'action needs your ok' ||
    lower === 'risk assessment complete' ||
    lower === 'rebel needs your ok before proceeding' ||
    lower === 'rebel needs you to review this before proceeding' ||
    lower.startsWith('unable to verify safety') ||
    // Legacy fail-closed copy (pre-260522). Kept for back-compat with
    // in-flight messages, persisted approvals, and historical log analysis.
    lower.startsWith('safety evaluation unavailable') ||
    // Current fail-closed copy (260522, REBEL-5G8 follow-up): friendlier
    // wording that points at recovery actions instead of suggesting blanket
    // approval. The prefix is unique enough to detect without false positives.
    lower.startsWith("rebel can't complete the safety check") ||
    lower.startsWith('matched explicit safety rule')
  );
}

// =============================================================================
// Service Name Extraction
// =============================================================================

/**
 * Service patterns for extracting service names from reason text.
 * Ordered by specificity - more specific patterns first (e.g., "Gmail" before "Email").
 */
export const SERVICE_PATTERNS = [
  // Specific services first
  { pattern: /\bgmail\b/i, name: 'Gmail' },
  { pattern: /\bgoogle\s*(drive|docs|sheets|slides|calendar)\b/i, name: 'Google Workspace' },
  { pattern: /\bslack\b/i, name: 'Slack' },
  { pattern: /\bnotion\b/i, name: 'Notion' },
  { pattern: /\blinear\b/i, name: 'Linear' },
  { pattern: /\bgithub\b/i, name: 'GitHub' },
  { pattern: /\bhubspot\b/i, name: 'HubSpot' },
  { pattern: /\bzendesk\b/i, name: 'Zendesk' },
  { pattern: /\btodoist\b/i, name: 'Todoist' },
  { pattern: /\bjira\b/i, name: 'Jira' },
  { pattern: /\basana\b/i, name: 'Asana' },
  { pattern: /\btrello\b/i, name: 'Trello' },
  { pattern: /\bsalesforce\b/i, name: 'Salesforce' },
  { pattern: /\bintercom\b/i, name: 'Intercom' },
  { pattern: /\bconfluence\b/i, name: 'Confluence' },
  { pattern: /\bdropbox\b/i, name: 'Dropbox' },
  { pattern: /\bfigma\b/i, name: 'Figma' },
  { pattern: /\bairtable\b/i, name: 'Airtable' },
  { pattern: /\bmicrosoft\s*teams\b/i, name: 'Microsoft Teams' },
  { pattern: /\boutlook\b/i, name: 'Outlook' },
  { pattern: /\bonedrive\b/i, name: 'OneDrive' },
  // Generic patterns last (fallbacks)
  { pattern: /\bcalendar\b/i, name: 'Calendar' },
  { pattern: /\bemail\b/i, name: 'Email' },
] as const;

/**
 * Try to extract a service/product name from the reason text.
 * Used primarily for Task tool (subagents) where the tool name is just "Task"
 * but the reason explains which service is being accessed.
 *
 * @param reason - The reason text from the tool approval request
 * @returns The detected service name, or null if no known service found
 */
export function extractServiceFromReason(reason: string | undefined): string | null {
  if (!reason) return null;

  for (const { pattern, name } of SERVICE_PATTERNS) {
    if (pattern.test(reason)) {
      return name;
    }
  }

  return null;
}
