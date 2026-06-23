/**
 * Tool Verb Constants
 *
 * Shared verb lists for tool classification across safety services.
 * Used by both toolSafetyService (allowPermanentTrust) and
 * stagedToolCallsService (isSideEffectTool).
 */

import { sideEffectPatterns } from '@rebel/shared';

export { sideEffectPatterns } from '@rebel/shared';

/**
 * Read-only verbs eligible for permanent trust.
 * A tool must start with or contain (after underscore) one of these verbs
 * to be considered for the "Always allow" option.
 */
const TRUSTABLE_READ_ONLY_VERBS = [
  'list',
  'get',
  'search',
  'read',
  'fetch',
  'describe',
  'show',
  'check',
  'view',
  'inspect',
  'lookup',
  'find',
  'count',
  'query',    // Read-only data queries (e.g., PostHog query-run, SQL queries)
  // Safe local operations (nothing leaves the system)
  'draft',    // Creates local draft, not sent — combined with SE verbs like "send" the SE check prevents false trust
  'history',  // Read-only historical data
  'preview',  // Read-only preview
  'load',     // Read-only load
] as const;

/**
 * Tools that must never be permanently trusted, regardless of verb matching.
 * Uses substring matching (case-insensitive) to catch variants like
 * "mcp__server__Bash", "run_shell_command", etc.
 */
const NEVER_TRUST_SUBSTRINGS = ['bash', 'shell', 'terminal', 'execute'] as const;

/**
 * Check if a tool name matches the never-trust blocklist.
 * Uses case-insensitive substring matching to catch all variants.
 */
export function isBlockedTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return NEVER_TRUST_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Exact tool IDs that are trustable despite having both read-only and side-effect
 * verbs in their names. These tools perform safe local writes (e.g., creating a
 * draft in Gmail) that don't have external side effects.
 *
 * Uses exact string matching — no regex, no patterns. Each entry must be
 * individually justified. The isDeterministicallyReadOnly() AND gate with
 * modelTrust still applies, so these tools only get "Always allow" if the
 * safety model also agrees.
 *
 * Exported so a construction-guard test can assert each bare id is owned by
 * exactly the expected connector(s) — matching here is global by bare id, so a
 * future connector adding a same-named tool would silently inherit deterministic
 * trust. See `toolVerbs.trustAllowlist.test.ts`.
 */
export const SYSTEM_TRUSTABLE_TOOL_IDS = new Set([
  'create_workspace_draft',  // Creates a local Gmail draft, does not send
  'update_workspace_draft',  // Modifies an existing local Gmail draft, does not send
  'create_draft',            // Microsoft365Mail: creates a standalone Outlook draft, saved but not sent
  'create_reply_draft',      // Microsoft365Mail: creates a threaded reply draft, saved but not sent
]);

// Pre-compiled regex patterns for read-only verb matching
const readOnlyPatterns = TRUSTABLE_READ_ONLY_VERBS.map(
  (verb) => new RegExp(`(?:^|_)${verb}(?:_|$)`)
);

/**
 * Determine if a tool ID is deterministically read-only based on its name.
 * Uses word-boundary-aware matching: verb must appear at the start of the ID
 * or after an underscore, and end at an underscore or end-of-string.
 *
 * A tool must contain at least one read-only verb AND no side-effect verbs.
 * This prevents composite names like "get_and_delete_files" from being trusted.
 *
 * Examples:
 *   "list_files"           → true  (starts with "list", no side-effect verbs)
 *   "gmail_search_emails"  → true  ("search" after underscore)
 *   "get_message_sender"   → true  (starts with "get", "sender" doesn't match "send")
 *   "send_email"           → false (no read-only verb)
 *   "get_and_delete_files" → false (has "delete" side-effect verb)
 *   "create_workspace_draft" → true (in SYSTEM_TRUSTABLE_TOOL_IDS allowlist)
 *   "manage_workspace_draft" → false (has "manage" side-effect verb)
 */
/**
 * Normalize PascalCase/camelCase identifiers to snake_case so that
 * underscore-delimited verb patterns can match them.
 *
 * Three-pass approach:
 *   Pass 1 ([A-Z]+)([A-Z][a-z]): inserts _ between uppercase run and next word
 *     "HTMLParser" → "HTML_Parser"
 *   Pass 2 ([a-z0-9])([A-Z]): inserts _ at camelCase boundaries
 *     "HTML_Parser" → "HTML_Parser" (no change), "Web_Search" stays
 *   Pass 3: hyphens → underscores (kebab-case tools like "query-run")
 *
 * Examples:
 *   "WebSearch"   → "web_search"
 *   "WebFetch"    → "web_fetch"
 *   "HTMLParser"  → "html_parser"
 *   "OAuth2Token" → "o_auth2_token"
 *   "APIGetUser"  → "api_get_user"
 *   "query-run"   → "query_run"
 *   "event-definitions-list" → "event_definitions_list"
 */
export function normalizeToSnakeCase(id: string): string {
  return id
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

export function isDeterministicallyReadOnly(toolId: string): boolean {
  const lower = normalizeToSnakeCase(toolId);
  if (SYSTEM_TRUSTABLE_TOOL_IDS.has(lower)) return true;
  const hasReadOnlyVerb = readOnlyPatterns.some((pattern) => pattern.test(lower));
  if (!hasReadOnlyVerb) return false;
  const hasSideEffectVerb = sideEffectPatterns.some((pattern) => pattern.test(lower));
  return !hasSideEffectVerb;
}

/**
 * MCP packages whose side-effect tools always require explicit user consent.
 * Used when the effectiveToolId alone is too generic to identify a
 * consent-sensitive domain (e.g., Microsoft Calendar's `create_event`).
 */
const CONSENT_REQUIRED_PACKAGES = new Set([
  'microsoft-calendar',
]);

const CONSENT_REQUIRED_REBEL_APP_BRIDGE_TOOLS = new Set([
  'rebel_bridge_extract_extension',
  'rebel_bridge_reveal_extension_folder',
  'rebel_bridge_open_extensions_page',
  'rebel_bridge_approve_pending',
  'rebel_bridge_reset_install',
]);

const SAFETY_PROMPT_REQUIRED_COMMUNICATION_PACKAGES = [
  'slack',
  'google-workspace',
  'googleworkspace',
  'gmail',
  'microsoft',
  'outlook',
] as const;

const COMMUNICATION_TARGET_SUBSTRINGS = [
  'slack',
  'email',
  'gmail',
  'mail',
  'message',
  'dm',
  'channel',
  'chat',
  'workspace',
] as const;

const COMMUNICATION_SEND_VERBS = ['send', 'post', 'reply', 'message'] as const;
const communicationSendPatterns = COMMUNICATION_SEND_VERBS.map(
  (verb) => new RegExp(`(?:^|_)${verb}(?:_|$)`),
);

/**
 * Determine if a tool requires explicit user consent (UI approval) regardless
 * of the Safety Prompt evaluator's decision.
 *
 * Calendar mutations are the canonical example: creating/deleting/managing
 * events on a user's calendar is a trust-sensitive action that should never
 * be auto-allowed. See FOX-2874, FOX-2878, FOX-2922.
 *
 * Checks two axes:
 *   1. Tool name contains "calendar" AND a side-effect verb (Google Workspace)
 *   2. Package is consent-required AND tool has a side-effect verb (Microsoft)
 */
export function isConsentRequiredTool(effectiveToolId: string, packageId?: string): boolean {
  const normalized = normalizeToSnakeCase(effectiveToolId);
  const normalizedPackageId = packageId?.toLowerCase();
  if (
    normalizedPackageId === 'rebelappbridge' &&
    Array.from(CONSENT_REQUIRED_REBEL_APP_BRIDGE_TOOLS).some((toolId) =>
      normalized.endsWith(toolId),
    )
  ) {
    return true;
  }

  const hasSideEffect = sideEffectPatterns.some((p) => p.test(normalized));
  if (!hasSideEffect) return false;

  if (normalized.includes('calendar')) return true;
  if (packageId && CONSENT_REQUIRED_PACKAGES.has(packageId)) return true;

  return false;
}

/**
 * Sensitive communication tools must be checked against the current Safety
 * Rules even if an older exact-tool trustedTools entry exists.
 *
 * This preserves the intended product contract:
 * - saved Safety Rules may still allow a send/post automatically;
 * - deleting a rule must take effect immediately;
 * - stale "always trust this tool id" entries cannot bypass current rules for
 *   external communication.
 */
export function requiresSafetyPromptPolicyCheck(effectiveToolId: string, packageId?: string): boolean {
  const normalized = normalizeToSnakeCase(effectiveToolId);
  if (SYSTEM_TRUSTABLE_TOOL_IDS.has(normalized)) return false;

  const normalizedPackageId = packageId?.toLowerCase() ?? '';
  const hasCommunicationPackage = SAFETY_PROMPT_REQUIRED_COMMUNICATION_PACKAGES.some((pkg) =>
    normalizedPackageId.includes(pkg),
  );
  const hasCommunicationTarget = COMMUNICATION_TARGET_SUBSTRINGS.some((target) =>
    normalized.includes(target),
  );
  const hasSendVerb = communicationSendPatterns.some((pattern) => pattern.test(normalized));

  return hasSendVerb && (hasCommunicationPackage || hasCommunicationTarget);
}
