/**
 * Display-time formatter for MCP connector/server names.
 *
 * Custom MCP connections (no catalog entry) and newly-contributed connectors are
 * keyed by their raw server name, which often comes from the connector directory
 * (e.g. `path.basename("~/mcp-servers/apple-shortcuts")` → `"apple-shortcuts"`)
 * or from the build skill's canonical slug (e.g. `apple-shortcuts-mcp`).
 * The raw name is the stable key used by matching + swap logic, so we never
 * rewrite it in storage. Instead we titleise at render time.
 *
 * Conversions:
 *   apple-shortcuts      → Apple Shortcuts
 *   apple-shortcuts-mcp  → Apple Shortcuts
 *   apple-mcp-server     → Apple
 *   my_custom_mcp        → My Custom
 *   figma                → Figma
 *
 * Pass-through when the name is already human-shaped (contains whitespace, or
 * starts with an uppercase word) so we don't mangle hand-curated display names
 * like "GitHub" → "Github".
 *
 * The affix-stripping list mirrors `stripMcpAffixes` in
 * `src/core/services/connectorCatalogService.ts` — keep them aligned so display
 * labels and catalog-match normalisation drop the same set of well-known
 * MCP plumbing words.
 */

/**
 * Suffix word-tokens dropped before capitalisation when they would otherwise
 * appear as visible plumbing ("Mcp", "Server", "Mcp Server"). Preserved as an
 * array so "mcp-server" matches both `["mcp","server"]` suffix tokens in one
 * pass. If a name is *only* plumbing (e.g. bare `mcp`), stripping is skipped
 * so we still show something.
 */
const SUFFIX_TOKENS = new Set(['mcp', 'mcpserver', 'server', 'serverkit', 'ai']);
const PREFIX_TOKENS = new Set(['mcp']);

export function formatConnectorDisplayName(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Already looks like a human-readable display name — leave it alone.
  if (/\s/.test(trimmed)) return trimmed;
  if (/^[A-Z][a-z]/.test(trimmed)) return trimmed;

  // Split on kebab/snake boundaries.
  const tokens = trimmed.split(/[-_]+/).filter(Boolean);

  // Drop trailing plumbing tokens (e.g. "apple-shortcuts-mcp" → drop "mcp";
  // "apple-mcp-server" → drop "server" then "mcp"). Stop as soon as a
  // non-plumbing token is reached. Never strip the *last* remaining token
  // — `formatConnectorDisplayName('mcp')` should still return 'Mcp', not ''.
  while (tokens.length > 1 && SUFFIX_TOKENS.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }
  // Same for leading plumbing prefixes ("mcp-mail-server" → drop leading "mcp").
  while (tokens.length > 1 && PREFIX_TOKENS.has(tokens[0].toLowerCase())) {
    tokens.shift();
  }

  return tokens
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}
