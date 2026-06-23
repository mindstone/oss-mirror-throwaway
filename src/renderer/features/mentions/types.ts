/**
 * Unified mention result types for @-mention autocomplete.
 *
 * This module defines a discriminated union type that supports:
 * - file/directory mentions (from workspace search)
 * - conversation mentions (from session history)
 * - command mentions (special keywords like @files)
 *
 * @see docs/plans/finished/251219_conversation_references.md for design context
 */

import type { SearchResult } from '@renderer/utils/librarySearch';
import type { ModelProviderType } from '@shared/types/settings';

/**
 * Filter type for @-mention autocomplete.
 * Controls which result types are shown:
 * - 'all': All results (files, skills, conversations, commands)
 * - 'skills': Only skill files/folders
 * - 'conversations': Only conversation history
 * - 'memory': Only files in memory directories
 * - 'models': Only configured model profiles
 * - 'operators': Only Operators available in the active Space scope
 */
export type MentionFilterType = 'all' | 'skills' | 'conversations' | 'memory' | 'models' | 'operators';

/**
 * Result of parsing a mention query for prefix filtering.
 */
export interface ParsedMentionQuery {
  /** The extracted filter type from prefix (defaults to 'all' if no prefix) */
  filter: MentionFilterType;
  /** The query string with prefix stripped (for search) */
  query: string;
  /** Whether an explicit prefix was present in the query */
  hasExplicitPrefix: boolean;
}

/**
 * Prefix mappings for mention filtering.
 * Maps prefix strings to their filter types.
 * Supports both singular and plural forms, plus short aliases.
 */
const MENTION_PREFIX_MAP: Record<string, MentionFilterType> = {
  // Skills prefixes
  'skill:': 'skills',
  'skills:': 'skills',
  's:': 'skills',
  // Conversation prefixes
  'conversation:': 'conversations',
  'conversations:': 'conversations',
  'conv:': 'conversations',
  'c:': 'conversations',
  // Memory prefixes
  'memory:': 'memory',
  'mem:': 'memory',
  'm:': 'memory',
  // Model prefixes
  'model:': 'models',
  'models:': 'models',
  'mod:': 'models',
  // Operator prefixes
  'operator:': 'operators',
  'operators:': 'operators',
  'op:': 'operators',
};

/** Pre-sorted prefixes (longest first) for efficient matching */
const SORTED_PREFIXES = Object.keys(MENTION_PREFIX_MAP).sort((a, b) => b.length - a.length);

/**
 * Parses a mention query to extract filter prefix and search query.
 *
 * Supports prefixes:
 * - Skills: `skill:`, `skills:`, `s:`
 * - Conversations: `conversation:`, `conversations:`, `conv:`, `c:`
 * - Memory: `memory:`, `mem:`, `m:`
 * - Models: `model:`, `models:`, `mod:`
 *
 * @param rawQuery - The raw query string after @ (e.g., "skill:test" or "test")
 * @returns Parsed result with filter type, stripped query, and prefix presence flag
 *
 * @example
 * parseMentionQuery('skill:test')
 * // => { filter: 'skills', query: 'test', hasExplicitPrefix: true }
 *
 * parseMentionQuery('mem:notes')
 * // => { filter: 'memory', query: 'notes', hasExplicitPrefix: true }
 *
 * parseMentionQuery('test')
 * // => { filter: 'all', query: 'test', hasExplicitPrefix: false }
 */
export function parseMentionQuery(rawQuery: string): ParsedMentionQuery {
  const lowerQuery = rawQuery.toLowerCase();

  for (const prefix of SORTED_PREFIXES) {
    if (lowerQuery.startsWith(prefix)) {
      return {
        filter: MENTION_PREFIX_MAP[prefix],
        query: rawQuery.slice(prefix.length),
        hasExplicitPrefix: true,
      };
    }
  }

  // No prefix found - return 'all' filter with original query
  return {
    filter: 'all',
    query: rawQuery,
    hasExplicitPrefix: false,
  };
}

/**
 * A file or directory mention result from workspace search.
 * Wraps the existing SearchResult type with a discriminator.
 */
export interface FileMentionResult extends SearchResult {
  kind: 'file';
}

/**
 * A conversation mention result from session history search.
 * Contains the essential fields needed for display and selection.
 */
export interface ConversationMentionResult {
  kind: 'conversation';
  /** Session ID (used in rebel://conversation/{id} URLs) */
  id: string;
  /** Session title (shown in autocomplete and inserted as link text) */
  title: string;
  /** Last update timestamp in milliseconds */
  updatedAt: number;
  /** Number of messages in the conversation */
  messageCount: number;
  /** Fuzzy search score (lower is better match) */
  score: number;
  /** Character index ranges of matched portions in title */
  matches: Array<[number, number]>;
  /** Session origin - 'automation' and 'role' indicate background runs */
  origin?: 'manual' | 'automation' | 'role' | 'mcp-tool' | 'inbound-trigger' | 'plugin' | 'focus' | 'browser-extension' | 'operator-personalisation';
  /** Whether this is the currently active session */
  isCurrent?: boolean;
}

/**
 * A command mention result for special keywords like @files.
 * These insert a literal keyword that triggers special behavior when the message is sent.
 */
export interface CommandMentionResult {
  kind: 'command';
  /** The command keyword (e.g., 'files') */
  command: string;
  /** Display label shown in autocomplete */
  label: string;
  /** Description shown as secondary text */
  description: string;
  /** Fuzzy search score (lower is better match) */
  score: number;
  /** Character index ranges of matched portions */
  matches: Array<[number, number]>;
}

/**
 * A model profile mention result from configured local/cloud model settings.
 */
export interface ModelMentionResult {
  kind: 'model';
  /** Profile ID (for unique identification) */
  profileId: string;
  /** Profile display name */
  profileName: string;
  /** Model name (e.g., 'gpt-5.2-codex') */
  modelName: string;
  /** Provider type (e.g., 'openai', 'google') */
  providerType?: ModelProviderType;
  /** Fuzzy search score (lower is better) */
  score: number;
  /** Character index ranges of matched portions */
  matches: Array<[number, number]>;
}

/**
 * An Operator mention result from the Operator registry.
 */
export interface OperatorMentionResult {
  kind: 'operator';
  operatorId: string;
  operatorSlug: string;
  operatorName: string;
  description: string;
  consultWhen: string;
  score: number;
  matches: Array<[number, number]>;
}

/**
 * Unified mention result type for autocomplete.
 *
 * Discriminated union allowing type-safe handling of file,
 * conversation, command, and model results in the mention popover and insertion logic.
 *
 * Usage:
 * ```ts
 * function handleResult(result: UnifiedMentionResult) {
 *   if (result.kind === 'file') {
 *     // Access SearchResult properties: result.node, result.fullPath, etc.
 *   } else if (result.kind === 'conversation') {
 *     // Access conversation properties: result.id, result.title, etc.
 *   } else {
 *     // Access command properties: result.command, result.label, etc.
 *   }
 * }
 * ```
 */
export type UnifiedMentionResult =
  | FileMentionResult
  | ConversationMentionResult
  | CommandMentionResult
  | ModelMentionResult
  | OperatorMentionResult;

/**
 * Type guard to check if a mention result is a file/directory.
 */
export function isFileMentionResult(
  result: UnifiedMentionResult
): result is FileMentionResult {
  return result.kind === 'file';
}

/**
 * Type guard to check if a mention result is a conversation.
 */
export function isConversationMentionResult(
  result: UnifiedMentionResult
): result is ConversationMentionResult {
  return result.kind === 'conversation';
}

/**
 * Type guard to check if a mention result is a command.
 */
export function isCommandMentionResult(
  result: UnifiedMentionResult
): result is CommandMentionResult {
  return result.kind === 'command';
}

/**
 * Type guard to check if a mention result is a model profile.
 */
export function isModelMentionResult(
  result: UnifiedMentionResult
): result is ModelMentionResult {
  return result.kind === 'model';
}

/**
 * Type guard to check if a mention result is an Operator.
 */
export function isOperatorMentionResult(
  result: UnifiedMentionResult
): result is OperatorMentionResult {
  return result.kind === 'operator';
}
