/**
 * Utilities for serializing and validating MCP server configurations.
 * Used by AddConnectionModal and ExpandedConnectionCard.
 */
import { INTERNAL_ENV_KEYS } from '@core/mcpInternalEnvKeys';
import type { McpServerConfigDetails, McpTransport } from '@shared/types';

/**
 * Serialize server config to JSON for editing.
 * Filters out internal environment variables.
 */
export const serializeServerConfig = (server: McpServerConfigDetails): string => {
  const config: Record<string, unknown> = {
    transport: server.transport,
  };
  
  if (server.command) config.command = server.command;
  if (server.args?.length) config.args = server.args;
  if (server.url) config.url = server.url;
  if (server.cwd) config.cwd = server.cwd;
  if (server.description) config.description = server.description;
  
  // Filter out internal env vars
  if (server.env) {
    const filteredEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.env)) {
      if (!INTERNAL_ENV_KEYS.has(key)) {
        filteredEnv[key] = value;
      }
    }
    if (Object.keys(filteredEnv).length > 0) {
      config.env = filteredEnv;
    }
  }
  
  if (server.headers && Object.keys(server.headers).length > 0) {
    config.headers = server.headers;
  }
  
  return JSON.stringify(config, null, 2);
};

export interface ConfigValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate server config JSON.
 * Returns validation result with errors and warnings.
 */
export const validateServerConfig = (json: string): ConfigValidation => {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return { isValid: false, errors: [`Invalid JSON: ${msg}`], warnings: [] };
  }
  
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { isValid: false, errors: ['Config must be a JSON object'], warnings: [] };
  }
  
  const config = parsed as Record<string, unknown>;
  
  // Super-MCP auto-detects transport: command = stdio, url = http
  const hasCommand = typeof config.command === 'string' && config.command.length > 0;
  const hasUrl = typeof config.url === 'string' && config.url.length > 0;
  
  if (!hasCommand && !hasUrl) {
    errors.push('Either "command" (for local) or "url" (for remote) is required');
  }
  
  if (hasCommand && hasUrl) {
    warnings.push("Both 'command' and 'url' specified. URL takes precedence (remote server).");
  }
  
  // Type validation if explicitly set
  if (config.type && !['stdio', 'http', 'sse'].includes(config.type as string)) {
    errors.push('"type" must be "stdio", "http", or "sse"');
  }
  
  // Warnings for placeholder values
  if (config.env && typeof config.env === 'object') {
    for (const [key, value] of Object.entries(config.env as Record<string, unknown>)) {
      if (typeof value === 'string' && (value.includes('YOUR_') || value === 'xxx' || value === '...')) {
        warnings.push(`env.${key} looks like a placeholder value`);
      }
    }
  }
  
  return { isValid: errors.length === 0, errors, warnings };
};

/**
 * Metadata fields that are intentionally hidden from user-editable JSON
 * but must be preserved when editing existing servers.
 * 
 * These fields are immutable - they're set when the server is first created
 * and shouldn't change during config edits. See REPLACE semantics in
 * mcpConfigManager.ts and immutability design in docs/plans/finished/260105_mcp_email_field.md
 */
export interface PreserveMetadata {
  email?: string | null;
  catalogId?: string | null;
  workspace?: string | null;
}

/**
 * Parse validated JSON config into upsert payload fields.
 * 
 * @param json - The JSON config string to parse
 * @param preserveMetadata - Optional metadata to preserve from the original server.
 *   These fields are intentionally hidden from the editable JSON but must be
 *   included in the upsert payload to prevent data loss.
 */
export const parseConfigToPayload = (
  json: string,
  preserveMetadata?: PreserveMetadata
): {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  description?: string;
  oauth?: boolean;
  email?: string;
  catalogId?: string;
  workspace?: string;
} => {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  
  return {
    transport: (parsed.type as McpTransport) || (parsed.transport as McpTransport) || undefined,
    command: (parsed.command as string) || undefined,
    args: (parsed.args as string[]) || undefined,
    url: (parsed.url as string) || undefined,
    cwd: (parsed.cwd as string) || undefined,
    env: (parsed.env as Record<string, string>) || undefined,
    headers: (parsed.headers as Record<string, string>) || undefined,
    description: (parsed.description as string) || undefined,
    oauth: (parsed.oauth as boolean) || undefined,
    // Preserve immutable metadata fields if provided
    email: preserveMetadata?.email ?? undefined,
    catalogId: preserveMetadata?.catalogId ?? undefined,
    workspace: preserveMetadata?.workspace ?? undefined,
  };
};
