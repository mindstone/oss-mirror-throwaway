/**
 * Agent Turn Formatters
 *
 * Pure formatting functions for agent turn context assembly:
 * - Tool parameter hint extraction
 * - Suggested tools context formatting
 * - Frequent tools and connected packages formatting
 */

import type { FrequentToolGroup, ConnectedPackage } from '../services/promptTemplateService';

/**
 * Format frequent tool groups as context text for subagent injection.
 * Uses the grouped format matching the main system prompt.
 * Returns undefined if no tools to avoid empty context blocks.
 */
export const formatFrequentToolsContext = (groups: FrequentToolGroup[]): string | undefined => {
  if (groups.length === 0) return undefined;
  const lines: string[] = ['**Your Frequent Tools:**'];
  for (const group of groups) {
    const toolNames = group.tools.map(t => t.shortName).join(', ');
    lines.push(`- **${group.serverId}**: ${toolNames}`);
  }
  return lines.join('\n');
};

/**
 * Format connected packages as context text for subagent injection.
 * Returns undefined if no packages to avoid empty context blocks.
 * Sorted alphabetically by name for cache stability.
 */
export const formatConnectedPackagesContext = (packages: ConnectedPackage[]): string | undefined => {
  if (packages.length === 0) return undefined;
  return `**Connected Packages:** ${packages.map(pkg => pkg.name).join(', ')}`;
};

type ParamHintProperty = {
  description?: unknown;
  type?: unknown;
  format?: unknown;
  enum?: unknown;
  oneOf?: unknown;
};

const MAX_INLINE_ENUM_VALUES = 5;

const formatInlineEnumValue = (value: string | number | boolean): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return String(value);
};

const extractOneOfConstValues = (oneOf: unknown): (string | number | boolean)[] => {
  if (!Array.isArray(oneOf)) return [];
  return oneOf
    .filter(
      (entry): entry is { const: string | number | boolean } =>
        entry != null &&
        typeof entry === 'object' &&
        'const' in entry &&
        (typeof entry.const === 'string' ||
          typeof entry.const === 'number' ||
          typeof entry.const === 'boolean')
    )
    .map((entry) => entry.const);
};

const extractOneOfTypeUnion = (oneOf: unknown): string | null => {
  if (!Array.isArray(oneOf)) return null;
  const types = oneOf
    .filter(
      (entry): entry is { type: string } =>
        entry != null && typeof entry === 'object' && 'type' in entry && typeof entry.type === 'string'
    )
    .map((entry) => entry.type)
    .filter((t) => t !== 'null');
  return types.length > 0 ? types.join('|') : null;
};

const extractInlineEnumHint = (prop: ParamHintProperty): string | null => {
  const scalarValues = Array.isArray(prop.enum)
    ? prop.enum.filter(
        (value): value is string | number | boolean =>
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      )
    : extractOneOfConstValues(prop.oneOf);

  if (scalarValues.length === 0) return null;

  const formattedValues = scalarValues
    .slice(0, MAX_INLINE_ENUM_VALUES)
    .map(formatInlineEnumValue)
    .join('|');

  return scalarValues.length > MAX_INLINE_ENUM_VALUES ? `${formattedValues}|...` : formattedValues;
};

const extractTypeHint = (prop: ParamHintProperty): string | null => {
  const inlineEnumHint = extractInlineEnumHint(prop);
  if (inlineEnumHint) return inlineEnumHint;

  if (typeof prop.format === 'string' && prop.format.trim().length > 0) {
    return prop.format.trim();
  }

  const typeValue = Array.isArray(prop.type)
    ? prop.type.find((entry): entry is string => typeof entry === 'string' && entry !== 'null')
    : prop.type;

  if (typeof typeValue === 'string' && typeValue.length > 0) {
    return typeValue;
  }

  const oneOfUnion = extractOneOfTypeUnion(prop.oneOf);
  if (oneOfUnion) return oneOfUnion;

  return null;
};

/**
 * Check if a schema explicitly defines zero parameters.
 * Returns true when the schema has a `properties` key that is an empty object.
 */
export const isEmptyParamSchema = (inputSchema: unknown): boolean => {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return false;
  const schema = inputSchema as { properties?: Record<string, unknown> };
  return !!schema.properties && typeof schema.properties === 'object'
    && !Array.isArray(schema.properties) && Object.keys(schema.properties).length === 0;
};

/**
 * Extract a compact parameter summary from a tool's inputSchema.
 * Returns a string like "(to: email, subject: string, cc?: email)"
 * with optional IMPORTANT hints from descriptions.
 */
export const extractParamHints = (inputSchema: unknown): string => {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return '';

  const schema = inputSchema as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };

  const props = schema.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return '';

  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : []
  );

  const hints: string[] = [];

  for (const [name, rawProp] of Object.entries(props)) {
    const prop: ParamHintProperty =
      rawProp && typeof rawProp === 'object' && !Array.isArray(rawProp)
        ? (rawProp as ParamHintProperty)
        : {};

    const isRequired = required.has(name);
    const desc = typeof prop.description === 'string' ? prop.description : '';

    // Extract short hint from description: look for IMPORTANT notes.
    const importantMatch = desc.match(/IMPORTANT:\s*(.{1,80})/i);
    const importantHint = importantMatch?.[1]?.replace(/[.!]+$/, '') || '';

    const typeHint = extractTypeHint(prop);
    const paramName = `${name}${isRequired ? '' : '?'}`;
    const typedParam = typeHint ? `${paramName}: ${typeHint}` : paramName;
    const importantSuffix = importantHint ? ` — "${importantHint}"` : '';

    hints.push(`${typedParam}${importantSuffix}`);
  }

  return hints.length > 0 ? `(${hints.join(', ')})` : '';
};

/**
 * Format suggested tools as context text for pre-turn injection.
 * Includes tool names and brief descriptions (no parameter hints — agents should
 * call get_tool_details to hydrate schemas before using tools).
 * Returns undefined if no relevant tools found.
 * 
 * @param tools - Array of tool results from semantic search
 * @param serverAccountMap - Optional map of serverId -> account label (email/workspace)
 */
export const formatSuggestedToolsContext = (
  tools: Array<{
    toolId: string;
    serverId: string;
    serverName: string;
    description: string;
    summary: string;
    inputSchema: unknown;
    score: number;
  }>,
  serverAccountMap?: Map<string, string>
): string | undefined => {
  if (tools.length === 0) return undefined;

  const toolLines = tools.map(t => {
    const desc = t.summary || t.description || '';
    const shortDesc = desc.length > 150 ? desc.slice(0, 147) + '...' : desc;
    const accountLabel = serverAccountMap?.get(t.serverId);
    const accountHint = accountLabel ? ` (${accountLabel})` : '';
    return `- package_id=\`${t.serverId}\`, tool_id=\`${t.toolId}\`${accountHint} — ${shortDesc}`;
  });

  return `Potentially relevant tools for this request (not an exclusive list). Use if helpful; call get_tool_details for schemas before first use.\n${toolLines.join('\n')}`;
};
