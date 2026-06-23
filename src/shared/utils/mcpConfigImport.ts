/**
 * Utilities for importing MCP server configurations from various formats.
 *
 * Supports flexible paste formats commonly copied from:
 * - Claude Desktop config files
 * - Documentation examples
 * - MCP server generators
 * - Other config wrappers
 *
 * Used by both renderer (AddConnectionModal) and main process (agent bridge).
 */

/** Maximum allowed config size in bytes (10KB - generous, typical config is 1-2KB) */
const MAX_CONFIG_SIZE_BYTES = 10 * 1024;

/** Detected format of the pasted configuration */
export type McpConfigFormat =
  | 'standard' // { command: "npx", args: [...] }
  | 'keyed' // { "my-server": { command: "npx" } }
  | 'claude-desktop' // { mcpServers: { "name": {...} } }
  | 'wrapper' // { mcp_servers: {...} } or { servers: {...} }
  | 'array' // [{ name: "my-server", command: "npx" }]
  | 'unknown';

/** Result of extracting server configuration from pasted input */
export interface ExtractResult {
  /** Detected format of the input */
  format: McpConfigFormat;
  /** Extracted configuration object (null if extraction failed) */
  config: Record<string, unknown> | null;
  /** Extracted server name if available from keyed/wrapper formats */
  extractedName: string | null;
  /** Error messages (empty if successful) */
  errors: string[];
  /** Warning messages (informational, not blocking) */
  warnings: string[];
}

/**
 * Check if a value is a plain object (not array, null, etc.)
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check if an object looks like an MCP server config (has command or url)
 */
function hasServerFields(obj: Record<string, unknown>): boolean {
  return (
    (typeof obj.command === 'string' && obj.command.length > 0) ||
    (typeof obj.url === 'string' && obj.url.length > 0)
  );
}

/**
 * Extract server entries from a container object (mcpServers, mcp_servers, etc.)
 * Returns the entries and any errors if multiple servers found.
 */
function extractFromContainer(container: unknown): {
  config: Record<string, unknown> | null;
  name: string | null;
  error: string | null;
} {
  if (!isPlainObject(container)) {
    return { config: null, name: null, error: 'Container is not an object' };
  }

  const keys = Object.keys(container);
  if (keys.length === 0) {
    return { config: null, name: null, error: 'No servers found in container' };
  }

  if (keys.length > 1) {
    return {
      config: null,
      name: null,
      error: 'Multiple servers found. Paste a single server config.'
    };
  }

  const serverKey = keys[0];
  const serverConfig = container[serverKey];

  if (!isPlainObject(serverConfig)) {
    return { config: null, name: null, error: 'Server config must be an object' };
  }

  return { config: serverConfig, name: serverKey, error: null };
}

/**
 * Extract and normalize an MCP server configuration from various paste formats.
 *
 * Detection order:
 * 1. Size check (reject >10KB)
 * 2. JSON parse validation
 * 3. Array format: [{ name: "x", command: "y" }]
 * 4. Claude Desktop format: { mcpServers: { "name": {...} } }
 * 5. Wrapper formats: { mcp_servers/servers/upstreamServers: {...} }
 * 6. Keyed format: { "my-server": { command: "npx" } }
 * 7. Standard format: { command: "npx", args: [...] }
 *
 * @param input - Raw JSON string pasted by user
 * @returns Extraction result with format, config, name, errors, and warnings
 */
export function extractServerConfig(input: string): ExtractResult {
  const warnings: string[] = [];

  // 1. Size check - fast pre-check using string length before allocating encoder
  // String length is always <= byte length, so this is a safe early rejection
  if (input.length > MAX_CONFIG_SIZE_BYTES) {
    return {
      format: 'unknown',
      config: null,
      extractedName: null,
      errors: ['Config too large (max 10KB)'],
      warnings: []
    };
  }
  // For strings near the limit, check actual byte size (handles multi-byte UTF-8)
  if (input.length > MAX_CONFIG_SIZE_BYTES / 2) {
    const inputSize = new TextEncoder().encode(input).length;
    if (inputSize > MAX_CONFIG_SIZE_BYTES) {
      return {
        format: 'unknown',
        config: null,
        extractedName: null,
        errors: ['Config too large (max 10KB)'],
        warnings: []
      };
    }
  }

  // 2. JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown parse error';
    return {
      format: 'unknown',
      config: null,
      extractedName: null,
      errors: [`Invalid JSON: ${message}`],
      warnings: []
    };
  }

  // 3. Array format
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return {
        format: 'array',
        config: null,
        extractedName: null,
        errors: ['Empty array'],
        warnings: []
      };
    }

    if (parsed.length > 1) {
      return {
        format: 'array',
        config: null,
        extractedName: null,
        errors: ['Multiple servers found. Paste a single server config.'],
        warnings: []
      };
    }

    const firstItem = parsed[0];
    if (!isPlainObject(firstItem)) {
      return {
        format: 'array',
        config: null,
        extractedName: null,
        errors: ['Array item must be an object'],
        warnings: []
      };
    }

    const extractedName =
      typeof firstItem.name === 'string' && firstItem.name.length > 0 ? firstItem.name : null;

    // Check for command/url warnings after extracting
    if (
      typeof firstItem.command === 'string' &&
      firstItem.command.length > 0 &&
      typeof firstItem.url === 'string' &&
      firstItem.url.length > 0
    ) {
      warnings.push(
        "Both 'command' and 'url' specified. URL takes precedence (remote server)."
      );
    }

    if (!hasServerFields(firstItem)) {
      return {
        format: 'array',
        config: null,
        extractedName,
        errors: [
          "Could not detect config format. Expected 'command' for local servers or 'url' for remote."
        ],
        warnings
      };
    }

    return {
      format: 'array',
      config: firstItem,
      extractedName,
      errors: [],
      warnings
    };
  }

  // Must be an object from here
  if (!isPlainObject(parsed)) {
    return {
      format: 'unknown',
      config: null,
      extractedName: null,
      errors: ['Config must be a JSON object'],
      warnings: []
    };
  }

  // 4. Claude Desktop format: { mcpServers: {...} }
  if ('mcpServers' in parsed && isPlainObject(parsed.mcpServers)) {
    const result = extractFromContainer(parsed.mcpServers);
    if (result.error) {
      return {
        format: 'claude-desktop',
        config: null,
        extractedName: null,
        errors: [result.error],
        warnings: []
      };
    }

    // Check for command/url warnings
    if (
      result.config &&
      typeof result.config.command === 'string' &&
      result.config.command.length > 0 &&
      typeof result.config.url === 'string' &&
      result.config.url.length > 0
    ) {
      warnings.push(
        "Both 'command' and 'url' specified. URL takes precedence (remote server)."
      );
    }

    return {
      format: 'claude-desktop',
      config: result.config,
      extractedName: result.name,
      errors: [],
      warnings
    };
  }

  // 5. Wrapper formats: { mcp_servers: {...} }, { servers: {...} }, { upstreamServers: {...} }
  const wrapperKeys = ['mcp_servers', 'servers', 'upstreamServers'] as const;
  for (const wrapperKey of wrapperKeys) {
    if (wrapperKey in parsed && isPlainObject(parsed[wrapperKey])) {
      const result = extractFromContainer(parsed[wrapperKey]);
      if (result.error) {
        return {
          format: 'wrapper',
          config: null,
          extractedName: null,
          errors: [result.error],
          warnings: []
        };
      }

      // Check for command/url warnings
      if (
        result.config &&
        typeof result.config.command === 'string' &&
        result.config.command.length > 0 &&
        typeof result.config.url === 'string' &&
        result.config.url.length > 0
      ) {
        warnings.push(
          "Both 'command' and 'url' specified. URL takes precedence (remote server)."
        );
      }

      return {
        format: 'wrapper',
        config: result.config,
        extractedName: result.name,
        errors: [],
        warnings
      };
    }
  }

  // 6. Keyed format: single top-level key with value containing command/url
  const topLevelKeys = Object.keys(parsed);
  if (topLevelKeys.length === 1) {
    const key = topLevelKeys[0];
    const value = parsed[key];
    if (isPlainObject(value) && hasServerFields(value)) {
      // Check for command/url warnings
      if (
        typeof value.command === 'string' &&
        value.command.length > 0 &&
        typeof value.url === 'string' &&
        value.url.length > 0
      ) {
        warnings.push(
          "Both 'command' and 'url' specified. URL takes precedence (remote server)."
        );
      }

      return {
        format: 'keyed',
        config: value,
        extractedName: key,
        errors: [],
        warnings
      };
    }
  }

  // 7. Standard format: { command: "...", args: [...] } or { url: "..." }
  if (hasServerFields(parsed)) {
    // Check for command/url warnings
    if (
      typeof parsed.command === 'string' &&
      parsed.command.length > 0 &&
      typeof parsed.url === 'string' &&
      parsed.url.length > 0
    ) {
      warnings.push(
        "Both 'command' and 'url' specified. URL takes precedence (remote server)."
      );
    }

    return {
      format: 'standard',
      config: parsed,
      extractedName: null,
      errors: [],
      warnings
    };
  }

  // 8. Unknown format
  return {
    format: 'unknown',
    config: null,
    extractedName: null,
    errors: [
      "Could not detect config format. Expected 'command' for local servers or 'url' for remote."
    ],
    warnings: []
  };
}
