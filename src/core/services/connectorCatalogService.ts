/**
 * Connector Catalog Service
 *
 * Provides lookup utilities to find connector entries from the catalog by server name.
 * Used to retrieve curated descriptions for connected packages when building system prompts.
 *
 * The lookup uses a multi-step matching strategy:
 * 1. Explicit catalogId (preferred - handles instance-named servers like 'Fathom-greg-work-com')
 * 2. Exact match on explicit server names (bundledConfig.serverName)
 * 3. Normalized fallback (lowercase, remove hyphens/underscores/spaces) for custom servers
 * 4. Affix-stripped fuzzy match (strips common MCP suffixes/prefixes like '-mcp', '-mcp-server')
 */

import { createScopedLogger } from '@core/logger';
import type {
  ConnectorCatalog,
  ConnectorCatalogEntry,
  UrlPatternDeclaration,
} from '@shared/types';
import catalogData from '../../../resources/connector-catalog.json';

let catalog = catalogData as ConnectorCatalog;
const log = createScopedLogger({ service: 'connectorCatalogService' });
const urlPatternRegexCache = new Map<string, RegExp>();
const invalidUrlPatternRegexCache = new Set<string>();

const getCachedUrlPatternRegex = (pattern: string): RegExp | null => {
  const cachedRegex = urlPatternRegexCache.get(pattern);
  if (cachedRegex) {
    return cachedRegex;
  }
  if (invalidUrlPatternRegexCache.has(pattern)) {
    return null;
  }

  try {
    const compiledRegex = new RegExp(pattern, 'i');
    urlPatternRegexCache.set(pattern, compiledRegex);
    return compiledRegex;
  } catch (error) {
    invalidUrlPatternRegexCache.add(pattern);
    log.warn(
      { pattern, err: error instanceof Error ? error.message : String(error) },
      'Skipping invalid connector URL pattern regex'
    );
    return null;
  }
};

export interface UrlPatternMatch {
  /** The matching catalog entry */
  catalogEntry: ConnectorCatalogEntry;
  /** The specific pattern that matched */
  pattern: UrlPatternDeclaration;
  /** Extracted args from the URL (e.g., { documentId: "abc123" }) */
  extractedArgs: Record<string, string>;
}

export function setConnectorCatalogForMain(nextCatalog: ConnectorCatalog | null): void {
  catalog = nextCatalog ?? (catalogData as ConnectorCatalog);
}

/**
 * Normalize a string for fuzzy matching.
 * Converts to lowercase and removes hyphens, underscores, and spaces.
 *
 * @example
 * normalize('Google-Workspace') => 'googleworkspace'
 * normalize('bundled_slack') => 'bundledslack'
 * normalize('Microsoft 365 Mail') => 'microsoft365mail'
 */
const normalize = (s: string): string => s.toLowerCase().replace(/[-_\s]/g, '');

/**
 * Common suffixes and prefixes that users or npx packages add to server names.
 * Used for fuzzy matching when the exact normalized name doesn't match.
 *
 * Ordered longest-first so longer patterns are stripped before shorter ones
 * (e.g., 'mcp-server' before 'mcp' or 'server').
 */
const COMMON_SUFFIXES = ['mcpserver', 'serverkit', 'server', 'mcp', 'ai'];
const COMMON_PREFIXES = ['mcp'];

/**
 * Strip well-known MCP naming suffixes and prefixes from a normalized string.
 * Handles patterns like 'perplexity-mcp', 'exa-mcp-server', 'mcp-mail-server'.
 *
 * @example
 * stripMcpAffixes('perplexitymcp')    => 'perplexity'
 * stripMcpAffixes('examcpserver')     => 'exa'
 * stripMcpAffixes('mcpmailserver')    => 'mail'
 * stripMcpAffixes('shopifymcp')       => 'shopify'
 * stripMcpAffixes('notion')           => 'notion' (unchanged)
 */
const stripMcpAffixes = (normalized: string): string => {
  let result = normalized;
  for (const suffix of COMMON_SUFFIXES) {
    if (result.endsWith(suffix) && result.length > suffix.length) {
      result = result.slice(0, -suffix.length);
      break;
    }
  }
  for (const prefix of COMMON_PREFIXES) {
    if (result.startsWith(prefix) && result.length > prefix.length) {
      result = result.slice(prefix.length);
      break;
    }
  }
  return result;
};

/**
 * Find a catalog entry by catalog ID.
 *
 * @param catalogId - The catalog entry ID (e.g., 'bundled-fathom', 'gmail')
 * @returns The matching catalog entry or undefined if not found
 */
export const findCatalogEntryById = (catalogId: string): ConnectorCatalogEntry | undefined => {
  if (!catalogId) return undefined;
  return catalog.connectors.find((entry) => entry.id === catalogId);
};

/**
 * Find connectors whose urlPatterns match the given URL.
 * Returns all matches (there may be multiple patterns/connectors that match).
 */
export const findConnectorsForUrl = (
  url: string,
  connectorCatalog: ConnectorCatalog
): UrlPatternMatch[] => {
  if (!url) {
    return [];
  }

  // Match against protocol+host+path only (not query string or fragment)
  // to prevent false positives from embedded URLs in query params.
  let matchTarget: string;
  try {
    const parsed = new URL(url);
    matchTarget = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    matchTarget = url;
  }

  const matches: UrlPatternMatch[] = [];

  for (const entry of connectorCatalog.connectors) {
    const urlPatterns = entry.urlPatterns;
    if (!urlPatterns || urlPatterns.length === 0) {
      continue;
    }

    for (const patternDeclaration of urlPatterns) {
      const patternRegex = getCachedUrlPatternRegex(patternDeclaration.pattern);
      if (!patternRegex) {
        continue;
      }

      const regexMatch = patternRegex.exec(matchTarget);
      if (!regexMatch) {
        continue;
      }

      const extractedArgs: Record<string, string> = {};
      if (patternDeclaration.extractArgs) {
        const groupName = patternDeclaration.extractArgs.group ?? 'id';
        const extractedValue = regexMatch.groups?.[groupName];
        if (extractedValue) {
          extractedArgs[patternDeclaration.extractArgs.param] = extractedValue;
        } else {
          log.warn(
            { pattern: patternDeclaration.pattern, group: groupName, url },
            'URL pattern matched but named capture group was not found in regex result'
          );
        }
      }

      matches.push({
        catalogEntry: entry,
        pattern: patternDeclaration,
        extractedArgs,
      });
    }
  }

  return matches;
};

/**
 * Find a catalog entry by server key.
 *
 * Uses a multi-step matching strategy (stops at first match):
 * 1. Exact match by catalogId (if provided via options)
 * 2. Exact match on explicit server names:
 *    - bundledConfig.serverName (e.g., "Slack", "GoogleWorkspace")
 * 3. Normalized match on catalog entry IDs:
 *    - Normalizes both the key and catalog entry IDs (lowercase, strip separators)
 * 4. Affix-stripped match:
 *    - Strips common MCP naming affixes (e.g., '-mcp', '-mcp-server', 'mcp-')
 *      from both the server key and catalog entry IDs/names, then compares.
 *      Handles user-named servers like 'perplexity-mcp' matching catalog id 'perplexity'.
 *
 * Returns undefined for custom MCPs not in the catalog (they get fallback text).
 *
 * @param serverKey - The MCP server name to look up (e.g., "Slack", "bundled-slack")
 * @param options - Optional lookup hints
 * @param options.catalogId - Explicit catalog ID to use (preferred over name-based matching)
 * @returns The matching catalog entry or undefined if not found
 *
 * @example
 * findCatalogEntry('Slack') // Returns bundled-slack entry (via bundledConfig.serverName)
 * findCatalogEntry('figma-local') // Returns figma-local entry (via normalized ID match)
 * findCatalogEntry('perplexity-mcp') // Returns perplexity entry (via affix-stripped match)
 * findCatalogEntry('exa-mcp-server') // Returns exa entry (via affix-stripped match)
 * findCatalogEntry('Fathom-greg-work-com', { catalogId: 'bundled-fathom' }) // Returns bundled-fathom entry
 * findCatalogEntry('MyCustomMcp') // Returns undefined
 */
export const findCatalogEntry = (
  serverKey: string,
  options?: { catalogId?: string | null }
): ConnectorCatalogEntry | undefined => {
  if (!serverKey) return undefined;

  // Step 1: Match by explicit catalogId (preferred - handles instance naming)
  if (options?.catalogId) {
    const byId = findCatalogEntryById(options.catalogId);
    if (byId) return byId;
  }

  // Step 2: Exact match on bundled server names
  const exactMatch = catalog.connectors.find(
    (entry) => entry.bundledConfig?.serverName === serverKey
  );
  if (exactMatch) return exactMatch;

  // Step 3: Normalized match on catalog entry IDs
  const normalizedKey = normalize(serverKey);
  const normalizedMatch = catalog.connectors.find((entry) => normalize(entry.id) === normalizedKey);
  if (normalizedMatch) return normalizedMatch;

  // Step 4: Affix-stripped fuzzy match
  // Users often name servers with common suffixes/prefixes (e.g., 'perplexity-mcp',
  // 'exa-mcp-server', 'mcp-datadog'). Strip these affixes from both the server key
  // and catalog entry IDs/names to find matches.
  const strippedKey = stripMcpAffixes(normalizedKey);
  if (strippedKey !== normalizedKey && strippedKey.length > 0) {
    // Compare stripped key against catalog entry IDs (also stripped) and display names
    const affixMatch = catalog.connectors.find((entry) => {
      const strippedEntryId = stripMcpAffixes(normalize(entry.id));
      if (strippedKey === strippedEntryId) return true;
      if (strippedKey === normalize(entry.name)) return true;
      return false;
    });
    if (affixMatch) return affixMatch;
  }

  // Also try: the key is clean but the catalog entry has affixes
  // (e.g., server named 'shopify' matching catalog id 'shopify-mcp' if that existed)
  return catalog.connectors.find((entry) => {
    const strippedEntryId = stripMcpAffixes(normalize(entry.id));
    if (strippedEntryId !== normalize(entry.id) && normalizedKey === strippedEntryId) return true;
    return false;
  });
};

/**
 * Get the description for a server, with a fallback for unknown servers.
 *
 * @param serverKey - The MCP server name to look up
 * @param fallbackDescription - Optional fallback if no catalog entry found (default: '(custom MCP server)')
 * @returns The catalog description or the fallback
 *
 * @example
 * getServerDescription('Slack') // 'Search messages, read channels/threads, post messages...'
 * getServerDescription('MyCustomMcp') // '(custom MCP server)'
 * getServerDescription('MyCustomMcp', 'User-configured server') // 'User-configured server'
 */
export const getServerDescription = (
  serverKey: string,
  fallbackDescription = '(custom MCP server)'
): string => {
  const entry = findCatalogEntry(serverKey);
  return entry?.description ?? fallbackDescription;
};

/**
 * Get description for a server with optional email or workspace prefix.
 * Used in system prompt to show account identity.
 *
 * @param serverKey - The MCP server name
 * @param options - Optional lookup hints and overrides
 * @param options.email - Account email to prefix in the description (for email-based MCPs)
 * @param options.workspace - Workspace name to prefix in the description (for workspace-based MCPs like Slack)
 * @param options.catalogId - Explicit catalog ID for instance-named servers (e.g., 'Fathom-greg-work-com' → 'bundled-fathom')
 * @param options.serverDescription - Custom description from server config (overrides catalog)
 * @returns Formatted description with email/workspace prefix if provided
 *
 * @example
 * getServerDescriptionWithEmail('Fathom', { email: '[external-email]' })
 * // '[external-email] - Meeting transcripts, AI summaries...'
 * getServerDescriptionWithEmail('Fathom-greg-work-com', { catalogId: 'bundled-fathom', email: '[external-email]' })
 * // '[external-email] - Meeting transcripts, AI summaries...'
 * getServerDescriptionWithEmail('Slack-mindstone', { catalogId: 'bundled-slack', workspace: 'Mindstone' })
 * // 'Mindstone workspace - Team messaging...'
 * getServerDescriptionWithEmail('Fathom', { serverDescription: 'My custom description' })
 * // 'My custom description'
 */
export const getServerDescriptionWithEmail = (
  serverKey: string,
  options?: {
    email?: string | null;
    workspace?: string | null;
    catalogId?: string | null;
    serverDescription?: string | null;
  }
): string => {
  const { email, workspace, catalogId, serverDescription } = options ?? {};

  // Use server config description if provided, otherwise fall back to catalog
  let baseDescription: string;
  if (serverDescription) {
    baseDescription = serverDescription;
  } else {
    // Use catalogId for lookup if provided (handles instance-named servers like 'Fathom-greg-work-com')
    const entry = findCatalogEntry(serverKey, { catalogId });
    baseDescription = entry?.description ?? '(custom MCP server)';
  }

  // If workspace is present (for workspace-based MCPs like Slack), format with "workspace" suffix
  if (workspace) {
    // Avoid duplicating workspace if it's already in the description
    const workspacePrefix = `${workspace} workspace`;
    if (baseDescription.toLowerCase().startsWith(workspace.toLowerCase())) {
      return baseDescription;
    }
    return `${workspacePrefix} - ${baseDescription}`;
  }

  // If email is present, prefix it
  if (email) {
    // Avoid duplicating email if it's already in the description (from buildBundledMcpPayload)
    if (baseDescription.startsWith(email)) {
      return baseDescription;
    }
    return `${email} - ${baseDescription}`;
  }

  return baseDescription;
};

/**
 * Get the display name for a server.
 *
 * @param serverKey - The MCP server name to look up
 * @returns The catalog display name or the original server key if not found
 *
 * @example
 * getServerDisplayName('gmail') // 'Gmail'
 * getServerDisplayName('GoogleWorkspace') // 'Google Workspace (Local)'
 * getServerDisplayName('MyCustomMcp') // 'MyCustomMcp'
 */
export const getServerDisplayName = (serverKey: string): string => {
  const entry = findCatalogEntry(serverKey);
  return entry?.name ?? serverKey;
};

/**
 * Check if a server is in the catalog.
 *
 * @param serverKey - The MCP server name to check
 * @returns true if the server is in the catalog, false otherwise
 */
export const isKnownServer = (serverKey: string): boolean => {
  return findCatalogEntry(serverKey) !== undefined;
};
