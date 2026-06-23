import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFile } from 'atomically';
import type {
  McpServerUpsertPayload,
  McpRouterPathPatchPayload,
  McpServerConfigDetails,
  McpTransport,
  ConnectorCatalog,
} from '@shared/types';
import catalogData from '../../../resources/connector-catalog.json';
import { createScopedLogger } from '@core/logger';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';

const log = createScopedLogger({ service: 'mcpConfigManager' });

// =============================================================================
// Config Change Notification
// =============================================================================
// Lightweight listener registry for config mutation notifications.
// Consumers (e.g. cloudRouter MCP sync) subscribe to get notified after
// any successful config write. Platform-agnostic — no Electron or cloud deps.
// =============================================================================

const configChangeListeners = new Set<() => void>();

/**
 * Register a listener that fires after any MCP config file is written.
 * Returns an unsubscribe function for clean teardown.
 */
export const onMcpConfigChanged = (listener: () => void): (() => void) => {
  configChangeListeners.add(listener);
  return () => { configChangeListeners.delete(listener); };
};

const notifyConfigChanged = (): void => {
  for (const listener of configChangeListeners) {
    try {
      listener();
    } catch (err) {
      // Use console.warn since we're in src/core/ (no logger dependency guaranteed at import time)
      // Keep this lightweight — listeners should not throw
      console.warn('[mcpConfigManager] Config change listener error:', err);
    }
  }
};

// =============================================================================
// Config Mutation Serialization
// =============================================================================
// Single mutex to serialize all config file mutations.
// Prevents race conditions when concurrent IPC calls try to read-modify-write
// the same config file. Without this, the following can happen:
//   T0: Thread A reads {servers: {A}}
//   T1: Thread B reads {servers: {A}}
//   T2: Thread A modifies to {servers: {A, B}}
//   T3: Thread B modifies to {servers: {}}
//   T4: Thread A writes {A, B}
//   T5: Thread B writes {} ← OVERWRITES A and B!
//
// The single-mutex pattern (vs per-path Map) is simpler and sufficient because:
// - Only one router config file exists per user in practice
// - Performance impact is negligible for config operations
// =============================================================================

let configMutationQueue: Promise<void> = Promise.resolve();

/**
 * Serialize config file mutations to prevent race conditions.
 * All functions that read-modify-write config files should use this wrapper.
 */
async function withConfigMutation<T>(fn: () => Promise<T>): Promise<T> {
  const prev = configMutationQueue;
  let release: (() => void) | undefined;
  configMutationQueue = new Promise(r => { release = r; });
  await prev;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

/**
 * Result of validating an MCP server entry.
 */
export interface McpServerValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Shape of an MCP server entry as it appears in config files.
 * This is the raw format before normalization.
 */
interface RawMcpServerEntry {
  name?: unknown;
  type?: unknown;
  command?: unknown;
  url?: unknown;
  visibility?: unknown;
  // Other fields we don't validate but may be present
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
  headers?: unknown;
  description?: unknown;
  oauth?: unknown;
  auth?: unknown;
}

/**
 * Validates an MCP server entry matches Super-MCP's validation rules.
 * 
 * IMPORTANT: These rules must stay synchronized with Super-MCP's validation.
 * See: super-mcp/src/registry.ts - validatePackageFields() and validateConfig()
 * If updating rules here, check if Super-MCP also needs updating, and vice versa.
 * 
 * Validation rules (mirrored from Super-MCP):
 * - name: required, must be non-empty string (in config file context, the key serves as id,
 *   but the entry may also have a 'name' field which defaults to id in Super-MCP)
 * - transport: must be "stdio" or "http" (inferred from presence of command vs url if not explicit)
 * - stdio transport: command is required and must be non-empty string
 * - http transport: url is required and must be a valid URL
 * - visibility: if present, must be "default" or "hidden"
 * 
 * @param entry - The raw MCP server entry from a config file
 * @param serverKey - The key/id of the server (used for name if entry.name is not present)
 * @returns Validation result with valid flag and optional reason if invalid
 */
export const validateMcpServerEntry = (
  entry: RawMcpServerEntry | null | undefined,
  serverKey?: string
): McpServerValidationResult => {
  // Entry must be an object
  if (!entry || typeof entry !== 'object') {
    return { valid: false, reason: 'Entry must be a non-null object' };
  }

  // Determine name: explicit name field takes precedence, otherwise use the server key
  const nameValue = entry.name !== undefined ? entry.name : serverKey;
  if (!nameValue || typeof nameValue !== 'string' || nameValue.trim() === '') {
    return { valid: false, reason: 'name is required and must be a non-empty string' };
  }

  // Infer transport type from entry fields (matching Super-MCP's logic)
  // Super-MCP uses truthy checks, so empty strings don't count as "having" a url/command.
  // See: super-mcp/src/registry.ts normalizeServerEntry() - `if (extConfig.url)`
  const rawType = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined;
  const hasUrl = !!entry.url && typeof entry.url === 'string';
  const hasCommand = !!entry.command && typeof entry.command === 'string';
  
  let transport: 'stdio' | 'http';
  if (rawType === 'sse' || rawType === 'http' || rawType === 'https' || rawType === 'rest' || rawType === 'streamable') {
    transport = 'http';
  } else if (hasUrl && !hasCommand) {
    transport = 'http';
  } else if (hasCommand && !hasUrl) {
    transport = 'stdio';
  } else if (hasUrl && hasCommand) {
    // If both are present, prefer http (matching Super-MCP's behavior)
    transport = 'http';
  } else {
    // Neither url nor command - need to determine based on type or fail
    if (rawType === 'stdio') {
      transport = 'stdio';
    } else {
      // Cannot determine transport, validation will fail below based on missing fields
      transport = 'stdio'; // Default to stdio for error messaging
    }
  }

  // Validate transport-specific requirements
  if (transport === 'stdio') {
    if (!entry.command || typeof entry.command !== 'string' || entry.command.trim() === '') {
      return { valid: false, reason: 'command is required and must be a non-empty string for stdio transport' };
    }
  } else {
    // http transport
    if (!entry.url || typeof entry.url !== 'string' || entry.url.trim() === '') {
      return { valid: false, reason: 'url is required and must be a non-empty string for http transport' };
    }
    // Validate URL format
    try {
      new URL(entry.url);
    } catch {
      return { valid: false, reason: `url must be a valid URL, got "${entry.url}"` };
    }
  }

  // Validate visibility if present
  if (entry.visibility !== undefined && entry.visibility !== null) {
    if (entry.visibility !== 'default' && entry.visibility !== 'hidden') {
      return { valid: false, reason: `visibility must be "default" or "hidden", got "${entry.visibility}"` };
    }
  }

  return { valid: true };
};

const prettify = (data: unknown): string => JSON.stringify(data, null, 2);

const ensureDirectory = async (targetFile: string): Promise<void> => {
  const directory = path.dirname(targetFile);
  await fs.mkdir(directory, { recursive: true });
};

const backupMalformedConfig = async (configPath: string, err: unknown): Promise<void> => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${configPath}.malformed-${timestamp}.bak`;
  try {
    await fs.copyFile(configPath, backupPath);
    // The super-mcp router config can carry plaintext secrets (sk-*/xox*); keep
    // its malformed backup owner-only, matching the hardened router write paths.
    if (path.basename(configPath) === 'super-mcp-router.json' && process.platform !== 'win32') {
      await fs.chmod(backupPath, 0o600);
    }
    log.warn(
      { err, configPath, backupPath },
      'Backed up malformed MCP config before recovery'
    );
  } catch (backupErr) {
    log.warn(
      { err: backupErr, parseErr: err, configPath, backupPath },
      'Failed to back up malformed MCP config before recovery'
    );
  }
};

const readConfig = async (configPath: string): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (err) {
      // A corrupt config must not silently become "no servers" — back it up
      // (logs internally) AND surface the parse failure here so the empty
      // fallback is observable. Behavior preserved: still recovers to {}.
      log.warn({ err, configPath }, 'MCP config is malformed JSON — recovering with empty config (servers will appear missing)');
      await backupMalformedConfig(configPath, err);
      return {};
    }
  } catch (err) {
    // File-absent (ENOENT) is the normal first-run case — recover silently.
    // Any other read failure (permissions, I/O) silently producing "no
    // servers" is the dangerous case, so make it observable before falling back.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, configPath }, 'Failed to read MCP config — recovering with empty config (servers will appear missing)');
    }
    return {};
  }
};

const writeConfig = async (configPath: string, data: unknown): Promise<void> => {
  await ensureDirectory(configPath);
  if (path.basename(configPath) === 'super-mcp-router.json') {
    await atomicCredentialWrite(configPath, prettify(data), { mode: 0o600 });
    notifyConfigChanged();
    return;
  }

  // Use atomically for crash-safe writes (handles temp file + rename)
  // This is especially important on Windows where fs.rename() can fail
  // if the destination file is locked
  await writeFile(configPath, prettify(data), 'utf8');
  notifyConfigChanged();
};

/**
 * Ensure a Super-MCP router config file exists at the given path.
 * Creates it with the proper router skeleton if missing.
 * 
 * The router file is the canonical pointer target for mcpConfigFile.
 * External configs (Cursor, etc.) are added via configPaths.
 */
export const ensureRouterConfigFile = async (configPath: string): Promise<void> => {
  const exists = await fs.access(configPath).then(() => true).catch(() => false);
  if (exists) {
    return;
  }
  // Router is identified by the presence of configPaths, not a version field
  const routerTemplate = {
    configPaths: [],
    mcpServers: {}
  };
  await writeConfig(configPath, routerTemplate);
};

/**
 * Remove stale `instances` array from a Super-MCP router config if present.
 * 
 * The v2 multi-account architecture (Dec 2025) removed ConnectorInstance metadata
 * in favor of using mcpServers as the single source of truth. This cleanup removes
 * any leftover `instances` array from router configs that went through the v1->v2 transition.
 * 
 * Safety guards:
 * - Only modifies configs within the app's userData directory
 * - Only modifies router configs (must have `configPaths` array)
 * - Creates a backup before any modification
 * 
 * @param configPath - Path to the MCP config file
 * @param userDataPath - The app's userData directory path (from app.getPath('userData'))
 * @returns true if cleanup was performed, false if skipped or no cleanup needed
 */
export const cleanupStaleInstancesArray = async (
  configPath: string,
  userDataPath: string
): Promise<boolean> => {
  // Safety check 1: only modify configs in userData directory
  // External configs (Cursor, user's own configs) should never be mutated
  const resolvedConfigPath = path.resolve(configPath);
  const resolvedUserDataPath = path.resolve(userDataPath);
  if (!resolvedConfigPath.startsWith(resolvedUserDataPath + path.sep)) {
    return false; // Don't touch external configs
  }
  
  return withConfigMutation(async () => {
    try {
      const config = await readConfig(configPath);
      if (!config) {
        return false; // Can't read config
      }
      
      // Safety check 2: only modify router configs (identified by configPaths array)
      // This prevents accidentally mutating non-router configs that happen to be in userData
      if (!Array.isArray(config.configPaths)) {
        return false; // Not a router config
      }
      
      // Check if there's actually an instances array to clean up
      if (!Array.isArray(config.instances)) {
        return false; // Nothing to clean up
      }
      
      // Create backup before modifying
      await createConfigBackup(configPath);
      
      // Remove the stale instances array
      delete config.instances;
      await writeConfig(configPath, config);
      
      return true;
    } catch {
      // Silently ignore errors - this is best-effort cleanup
      return false;
    }
  });
};

const MAX_BACKUPS = 5;

const pruneOldBackups = async (configPath: string): Promise<void> => {
  const directory = path.dirname(configPath);
  const baseName = path.basename(configPath);
  const backupPattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.bak$`);

  try {
    const entries = await fs.readdir(directory);
    const backups = entries
      .filter((entry) => backupPattern.test(entry))
      .map((entry) => {
        const match = entry.match(/\.(\d+)\.bak$/);
        return { name: entry, timestamp: match ? parseInt(match[1], 10) : 0 };
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    const toDelete = backups.slice(MAX_BACKUPS);
    await Promise.all(
      toDelete.map((backup) => fs.unlink(path.join(directory, backup.name)).catch(() => {}))
    );
  } catch {
    // Ignore cleanup errors - not critical
  }
};

export async function createConfigBackup(configPath: string): Promise<string | null> {
  const exists = await fs.access(configPath).then(() => true).catch(() => false);
  if (!exists) {
    return null;
  }
  const backupPath = `${configPath}.${Date.now()}.bak`;
  await ensureDirectory(backupPath);
  await fs.copyFile(configPath, backupPath);
  if (path.basename(configPath) === 'super-mcp-router.json' && process.platform !== 'win32') {
    await fs.chmod(backupPath, 0o600);
  }
  await pruneOldBackups(configPath);
  return backupPath;
}

const sanitizeRecord = (value: Record<string, unknown> | null | undefined): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return Object.entries(value).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (entry === undefined || entry === null) {
      return acc;
    }
    acc[key] = String(entry);
    return acc;
  }, {});
};

const sanitizeArgs = (args?: string[] | null): string[] | undefined => {
  if (!Array.isArray(args)) {
    return undefined;
  }
  const normalized = args.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : undefined;
};

const prepareServerPayload = (payload: McpServerUpsertPayload): Record<string, unknown> => {
  const next: Record<string, unknown> = {};
  // Include name as an attribute for Super-MCP display purposes
  if (payload.name) {
    next.name = payload.name.trim();
  }
  // Use explicit `type` if provided (e.g., "sse"), otherwise fall back to `transport`
  // This allows catalog entries to specify a specific transport type like "sse" 
  // while using "http" as the general transport category
  if (payload.type) {
    next.type = payload.type;
  } else if (payload.transport) {
    next.type = payload.transport;
  }
  if (payload.command) {
    next.command = payload.command;
  }
  const normalizedArgs = sanitizeArgs(payload.args ?? null);
  if (normalizedArgs) {
    next.args = normalizedArgs;
  }
  if (payload.url) {
    next.url = payload.url;
  }
  if (payload.cwd) {
    next.cwd = payload.cwd;
  }
  const env = sanitizeRecord(payload.env ?? undefined);
  if (env) {
    next.env = env;
  }
  const headers = sanitizeRecord(payload.headers ?? undefined);
  if (headers) {
    next.headers = headers;
  }
  if (payload.description) {
    next.description = payload.description;
  }
  if (payload.oauth === true) {
    next.oauth = true;
  }
  if (payload.oauthParams && Object.keys(payload.oauthParams).length > 0) {
    next.oauthParams = payload.oauthParams;
  }
  if (payload.oauthClientId) {
    next.oauthClientId = payload.oauthClientId;
  }
  if (payload.oauthClientSecret) {
    next.oauthClientSecret = payload.oauthClientSecret;
  }
  if (payload.catalogId) {
    next.catalogId = payload.catalogId;
  }
  if (payload.email) {
    next.email = payload.email;
  }
  if (payload.workspace) {
    next.workspace = payload.workspace;
  }
  if (typeof payload.lastConnectedAt === 'number') {
    next.lastConnectedAt = payload.lastConnectedAt;
  }
  return next;
};

const ensureServerContainer = (config: Record<string, unknown>): Record<string, unknown> => {
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  return config.mcpServers as Record<string, unknown>;
};

const normalizeArgsArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const result = value
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
  return result.length > 0 ? result : null;
};

const toKeyValueRecord = (value: unknown): Record<string, string> | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (entry === undefined || entry === null) {
      return acc;
    }
    acc[key] = String(entry);
    return acc;
  }, {});
  return Object.keys(entries).length > 0 ? entries : null;
};

const inferTransportFromEntry = (entry: Record<string, unknown>): McpTransport => {
  const rawType = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined;
  if (rawType === 'http' || rawType === 'https' || rawType === 'rest') {
    return 'http';
  }
  if (rawType === 'sse' || rawType === 'eventsource' || rawType === 'streamable') {
    return 'sse';
  }
  return 'stdio';
};

/**
 * Upsert (insert or replace) an MCP server entry.
 * 
 * IMPORTANT: This uses REPLACE semantics, not merge/patch. The entire server
 * entry is replaced with the payload contents. Callers must provide all required
 * fields (command for stdio, url for http) - partial payloads will fail validation.
 * 
 * This is intentional: replace semantics work well with JSON-editing UX where
 * deleting a key should delete the field, not be ignored.
 */
export const upsertMcpServerEntry = async (
  configPath: string,
  payload: McpServerUpsertPayload
): Promise<{ backupPath: string | null }> => {
  return withConfigMutation(async () => {
    if (!payload.name || !payload.name.trim()) {
      throw new Error('Server name is required.');
    }
    const name = payload.name.trim();
    const config = await readConfig(configPath);
    const container = ensureServerContainer(config);
    const nextEntry = prepareServerPayload(payload);
    if (Object.keys(nextEntry).length === 0) {
      throw new Error('Server configuration requires at least one field.');
    }
    
    // Validate entry before writing to catch incomplete/invalid configs early
    const validation = validateMcpServerEntry(nextEntry, name);
    if (!validation.valid) {
      throw new Error(`Invalid MCP server config for "${name}": ${validation.reason}`);
    }
    
    container[name] = nextEntry;
    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);
    return { backupPath };
  });
};

/**
 * Batch upsert multiple MCP servers in a single file operation.
 * More efficient than calling upsertMcpServerEntry multiple times during startup.
 * Performs: 1 read → N modifications in memory → 1 backup → 1 write
 * 
 * Uses REPLACE semantics (see upsertMcpServerEntry). Payloads with blank/missing
 * names or empty configs are silently skipped. Valid payloads are all validated
 * before any writes - if one fails validation, the entire batch fails (atomic).
 * Duplicate names in the batch will result in "last one wins" behavior.
 */
export const upsertMcpServersBatch = async (
  configPath: string,
  payloads: McpServerUpsertPayload[]
): Promise<{ backupPath: string | null; count: number }> => {
  if (!payloads || payloads.length === 0) {
    return { backupPath: null, count: 0 };
  }
  
  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    const container = ensureServerContainer(config);
    
    // First pass: validate all payloads before making any changes (atomic)
    const validatedEntries: Array<{ name: string; entry: Record<string, unknown> }> = [];
    for (const payload of payloads) {
      if (!payload.name?.trim()) continue;
      const name = payload.name.trim();
      const nextEntry = prepareServerPayload(payload);
      if (Object.keys(nextEntry).length === 0) continue;
      
      const validation = validateMcpServerEntry(nextEntry, name);
      if (!validation.valid) {
        throw new Error(`Invalid MCP server config for "${name}": ${validation.reason}`);
      }
      validatedEntries.push({ name, entry: nextEntry });
    }
    
    if (validatedEntries.length === 0) {
      return { backupPath: null, count: 0 };
    }
    
    // Second pass: apply all validated entries
    for (const { name, entry } of validatedEntries) {
      // Preserve lastConnectedAt from existing entry when not provided by the
      // incoming payload. This prevents discovery re-registration from erasing
      // the timestamp and avoids config churn that triggers unnecessary restarts.
      if (entry.lastConnectedAt === undefined) {
        const existing = container[name];
        if (existing && typeof existing === 'object' && typeof (existing as Record<string, unknown>).lastConnectedAt === 'number') {
          entry.lastConnectedAt = (existing as Record<string, unknown>).lastConnectedAt;
        }
      }
      container[name] = entry;
    }
    
    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);
    return { backupPath, count: validatedEntries.length };
  });
};

export const removeMcpServerEntry = async (
  configPath: string,
  serverName: string
): Promise<{ backupPath: string | null }> => {
  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    const container = ensureServerContainer(config);
    // Idempotent: if config or server doesn't exist, nothing to remove - that's success
    if (!container[serverName]) {
      return { backupPath: null };
    }
    delete container[serverName];
    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);
    return { backupPath };
  });
};

/**
 * Advance `lastConnectedAt` for one MCP server without mutating any other
 * server fields. Used after post-save validation confirms a credential update
 * actually works.
 */
export const touchMcpServerLastConnected = async (
  configPath: string,
  serverName: string,
  ts: number = Date.now(),
): Promise<{ backupPath: string | null }> => {
  const name = serverName.trim();
  if (!name) {
    throw new Error('Server name is required.');
  }

  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    const container = ensureServerContainer(config);
    const entry = container[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Cannot update lastConnectedAt — MCP server "${name}" not found in configuration.`);
    }

    (entry as Record<string, unknown>).lastConnectedAt = ts;
    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);
    return { backupPath };
  });
};

/**
 * Get all server names from an MCP config file.
 * 
 * @returns Array of server names (keys in mcpServers)
 */
export const getMcpServerNames = async (configPath: string): Promise<string[]> => {
  const config = await readConfig(configPath);
  if (!config?.mcpServers || typeof config.mcpServers !== 'object') {
    return [];
  }
  return Object.keys(config.mcpServers);
};

/**
 * Check if a server with the given catalogId and email already exists.
 * Used for duplicate validation when adding multiple instances of the same MCP.
 * 
 * @param configPath - Path to the MCP config file
 * @param catalogId - The catalog ID to check (e.g., 'bundled-slack')
 * @param email - The email to check (case-insensitive comparison)
 * @returns Object with exists flag and serverName if found
 */
export const serverExistsWithCatalogAndEmail = async (
  configPath: string,
  catalogId: string,
  email: string
): Promise<{ exists: boolean; serverName?: string }> => {
  const config = await readConfig(configPath);
  if (!config?.mcpServers || typeof config.mcpServers !== 'object') {
    return { exists: false };
  }

  const normalizedEmail = email.trim().toLowerCase();
  
  for (const [serverName, entry] of Object.entries(config.mcpServers)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    
    if (record.catalogId === catalogId && 
        typeof record.email === 'string' && 
        record.email.trim().toLowerCase() === normalizedEmail) {
      return { exists: true, serverName };
    }
  }
  
  return { exists: false };
};

/**
 * Check if a server for the given catalogId + email already exists.
 * When email is provided, checks for an existing entry with the same catalogId + email.
 * When no email is provided, checks for any single-instance server with the same catalogId
 * (to support idempotent upsert for connectors without email-based identity).
 */
export const findExistingCatalogServer = async (
  configPath: string,
  catalogId: string,
  email?: string,
): Promise<{ exists: boolean; serverName?: string; matchType?: 'email' | 'catalogId' }> => {
  if (email) {
    const result = await serverExistsWithCatalogAndEmail(configPath, catalogId, email);
    return result.exists ? { ...result, matchType: 'email' } : result;
  }
  // No email: look for any server with matching catalogId (single-instance connectors).
  // This enables idempotent upsert for connectors without email-based identity.
  const config = await readConfig(configPath);
  if (!config?.mcpServers || typeof config.mcpServers !== 'object') {
    return { exists: false };
  }
  for (const [serverName, entry] of Object.entries(config.mcpServers)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.catalogId === catalogId) {
      return { exists: true, serverName, matchType: 'catalogId' };
    }
  }
  return { exists: false };
};

export const patchRouterConfigPaths = async (
  configPath: string,
  payload: McpRouterPathPatchPayload
): Promise<{ backupPath: string | null }> => {
  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid Super-MCP configuration.');
    }

    const routeList: string[] = Array.isArray(config.configPaths)
      ? [...config.configPaths.map((value: unknown) => String(value))]
      : [];

    if (payload.action === 'add') {
      if (!payload.path.trim()) {
        throw new Error('Path cannot be empty.');
      }
      if (!routeList.includes(payload.path)) {
        routeList.push(payload.path);
      }
    } else if (payload.action === 'remove') {
      const index = routeList.indexOf(payload.path);
      if (index >= 0) {
        routeList.splice(index, 1);
      }
    }

    config.configPaths = routeList;

    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);
    return { backupPath };
  });
};

/**
 * Get raw MCP server entry from config.
 * Returns null if server doesn't exist (instead of throwing).
 * Used by removal service to read catalogId/email before deletion.
 * 
 * Note: For Slack connectors, slackTeamId is extracted from env.SLACK_TEAM_ID
 * because removeSlackWorkspace() requires the teamId, not the workspace display name.
 */
export const getMcpServerEntry = async (
  configPath: string,
  serverName: string
): Promise<{ catalogId?: string; email?: string; workspace?: string; slackTeamId?: string } | null> => {
  const config = await readConfig(configPath);
  const container = ensureServerContainer(config);
  const entry = container[serverName];
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  
  // Extract SLACK_TEAM_ID from env for Slack credential cleanup
  let slackTeamId: string | undefined;
  if (record.env && typeof record.env === 'object') {
    const env = record.env as Record<string, unknown>;
    if (typeof env.SLACK_TEAM_ID === 'string') {
      slackTeamId = env.SLACK_TEAM_ID;
    }
  }
  
  return {
    catalogId: typeof record.catalogId === 'string' ? record.catalogId : undefined,
    email: typeof record.email === 'string' ? record.email : undefined,
    workspace: typeof record.workspace === 'string' ? record.workspace : undefined,
    slackTeamId,
  };
};

/**
 * Patch the `oauth` flag on an existing MCP server entry in place, preserving
 * every other field (including `oauthClientId`, `oauthClientSecret`, `env`, etc.).
 *
 * Used when we learn — after the initial add — that a server is OAuth-capable:
 * either the raw-upsert OAuth probe classified it as `oauth`, or Super-MCP's
 * `authenticate` tool later completed an OAuth handshake against a server that
 * had been persisted without `oauth: true`.
 *
 * Without this, Super-MCP's HttpMcpClient skips OAuth provider setup on restart
 * (see super-mcp/src/clients/httpClient.ts — `if (this.config.oauth && ...)`)
 * and reconnects unauthenticated, losing the just-obtained tokens. See
 * docs-private/postmortems/260424_rebel_1h7_*.md.
 *
 * No-op when the server is missing or the flag is already at the desired value.
 */
export const setMcpServerOAuthFlag = async (
  configPath: string,
  serverName: string,
  oauth: boolean
): Promise<void> => {
  if (!serverName.trim()) {
    throw new Error('Server name is required');
  }
  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    const container = ensureServerContainer(config);
    const entry = container[serverName];
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const record = entry as Record<string, unknown>;
    if (oauth) {
      if (record.oauth === true) {
        return;
      }
      record.oauth = true;
    } else {
      if (record.oauth === undefined) {
        return;
      }
      delete record.oauth;
    }
    await writeConfig(configPath, config);
  });
};

export const readMcpServerDetails = async (
  configPath: string,
  serverName: string
): Promise<McpServerConfigDetails> => {
  const config = await readConfig(configPath);
  const container = ensureServerContainer(config);
  const entry = container[serverName];

  if (!entry || typeof entry !== 'object') {
    throw new Error(`Server "${serverName}" not found in configuration.`);
  }

  const record = entry as Record<string, unknown>;
  const argsArray = normalizeArgsArray(record.args ?? null);

  return {
    name: serverName,
    type: typeof record.type === 'string' ? record.type : null,
    transport: inferTransportFromEntry(record),
    command: typeof record.command === 'string' ? record.command : null,
    args: argsArray,
    url: typeof record.url === 'string' ? record.url : null,
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    env: toKeyValueRecord(record.env ?? null),
    headers: toKeyValueRecord(record.headers ?? null),
    description: typeof record.description === 'string' ? record.description : null,
    catalogId: typeof record.catalogId === 'string' ? record.catalogId : null,
    email: typeof record.email === 'string' ? record.email : null,
    workspace: typeof record.workspace === 'string' ? record.workspace : null,
    lastConnectedAt: typeof record.lastConnectedAt === 'number' ? record.lastConnectedAt : null,
  } satisfies McpServerConfigDetails;
};

/**
 * Enable or disable a specific MCP tool by updating the `userDisabledToolsByServer` field.
 * 
 * Tool names are SHORT names (e.g., `delete_file`), not namespaced forms.
 * Server ID is the key in mcpServers (e.g., "filesystem", "gmail").
 * 
 * This function:
 * - If `enabled: true`, removes the tool from the disabled list
 * - If `enabled: false`, adds the tool to the disabled list
 * - Creates the `userDisabledToolsByServer` object/arrays if they don't exist
 * - Super-MCP will hot-reload the config automatically
 * 
 * @param configPath - Path to the Super-MCP router config file
 * @param serverId - The server ID (key in mcpServers)
 * @param toolName - The short tool name (e.g., "delete_file")
 * @param enabled - Whether the tool should be enabled (true) or disabled (false)
 */
export const setMcpToolEnabled = async (
  configPath: string,
  serverId: string,
  toolName: string,
  enabled: boolean
): Promise<void> => {
  if (!serverId.trim()) {
    throw new Error('Server ID is required');
  }
  if (!toolName.trim()) {
    throw new Error('Tool name is required');
  }

  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid MCP configuration file');
    }

    // Initialize userDisabledToolsByServer if it doesn't exist or is invalid
    // Must be a plain object, not an array
    if (!config.userDisabledToolsByServer || 
        typeof config.userDisabledToolsByServer !== 'object' ||
        Array.isArray(config.userDisabledToolsByServer)) {
      config.userDisabledToolsByServer = {};
    }

    const disabledByServer = config.userDisabledToolsByServer as Record<string, string[]>;

    // Get or create the disabled tools array for this server
    if (!Array.isArray(disabledByServer[serverId])) {
      disabledByServer[serverId] = [];
    }

    const disabledTools = disabledByServer[serverId];
    const toolIndex = disabledTools.indexOf(toolName);

    if (enabled) {
      // Remove from disabled list if present
      if (toolIndex >= 0) {
        disabledTools.splice(toolIndex, 1);
      }
      // Clean up empty arrays
      if (disabledTools.length === 0) {
        delete disabledByServer[serverId];
      }
      // Clean up empty object
      if (Object.keys(disabledByServer).length === 0) {
        delete config.userDisabledToolsByServer;
      }
    } else {
      // Add to disabled list if not already present
      if (toolIndex < 0) {
        disabledTools.push(toolName);
      }
    }

    // Write config (no backup needed for this toggle operation - it's easily reversible)
    await writeConfig(configPath, config);
  });
};

/**
 * Enable or disable a specific MCP server by updating the `disabledServers` field.
 * 
 * Server IDs are the keys in mcpServers (e.g., "GoogleWorkspace-greg-work-com").
 * 
 * This function:
 * - If `disabled: true`, adds the server ID to the disabledServers array
 * - If `disabled: false`, removes the server ID from the disabledServers array
 * - Creates the `disabledServers` array if it doesn't exist
 * - Super-MCP will hot-reload (via restart) to apply the change
 * 
 * @param configPath - Path to the Super-MCP router config file
 * @param serverId - The server ID (key in mcpServers)
 * @param disabled - Whether the server should be disabled (true) or enabled (false)
 */
export const setMcpServerDisabled = async (
  configPath: string,
  serverId: string,
  disabled: boolean
): Promise<void> => {
  if (!serverId.trim()) {
    throw new Error('Server ID is required');
  }

  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid MCP configuration file');
    }

    const currentDisabledServers = Array.isArray(config.disabledServers)
      ? config.disabledServers.filter((server): server is string => typeof server === 'string')
      : [];
    const disabledSet = new Set<string>(currentDisabledServers);

    if (disabled) {
      // Add to disabled set
      disabledSet.add(serverId);
    } else {
      // Remove from disabled set
      disabledSet.delete(serverId);
    }

    // Convert back to array
    if (disabledSet.size > 0) {
      config.disabledServers = Array.from(disabledSet);
    } else {
      // Clean up empty array
      delete config.disabledServers;
    }

    // Write config (no backup needed for this toggle operation - it's easily reversible)
    await writeConfig(configPath, config);
  });
};

/**
 * Check if a specific MCP server is disabled.
 * 
 * @param configPath - Path to the Super-MCP router config file
 * @param serverId - The server ID (key in mcpServers)
 * @returns true if the server is in the disabledServers array, false otherwise
 */
export const isServerDisabled = async (configPath: string, serverId: string): Promise<boolean> => {
  try {
    const config = await readConfig(configPath);
    if (!config || typeof config !== 'object') {
      return false;
    }
    if (!Array.isArray(config.disabledServers)) {
      return false;
    }
    return config.disabledServers.includes(serverId);
  } catch {
    return false;
  }
};

/**
 * Check if a specific MCP server exists in config and is currently enabled.
 *
 * This is intentionally stricter than `!isServerDisabled(...)` because a
 * missing entry is neither disabled nor enabled — callers that care about
 * runtime lifecycle hooks (for example eager-start services) need the full
 * "installed and not disabled" semantic gate.
 *
 * @param configPath - Path to the Super-MCP router config file
 * @param serverId - The server ID (key in mcpServers)
 * @returns true only when the server exists and is not disabled
 */
export const isServerEnabled = async (configPath: string, serverId: string): Promise<boolean> => {
  const entry = await getMcpServerEntry(configPath, serverId);
  if (!entry) {
    return false;
  }

  const disabled = await isServerDisabled(configPath, serverId);
  return !disabled;
};

/**
 * Write admin-disabled tools (from the /config endpoint) to the Super-MCP router config.
 *
 * Converts from the server format `{ catalogId: { disabledTools: string[] } }` to
 * Super-MCP's flat format `{ catalogId: string[] }` and stores as `adminDisabledToolsByCatalogId`.
 * Super-MCP's config watcher will hot-reload the change automatically.
 *
 * When called with an empty object, removes the field from config (clears stale state).
 *
 * @param configPath - Path to the Super-MCP router config file
 * @param disabledConnectorTools - Catalog-keyed disabled tools from the server
 */
export const writeAdminDisabledToolsToConfig = async (
  configPath: string,
  disabledConnectorTools: Record<string, { disabledTools: string[] }>
): Promise<void> => {
  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    if (!config || typeof config !== 'object') {
      return;
    }

    // Convert from server format to super-mcp flat format
    const adminDisabled: Record<string, string[]> = {};
    for (const [catalogId, entry] of Object.entries(disabledConnectorTools)) {
      if (entry.disabledTools.length > 0) {
        adminDisabled[catalogId] = entry.disabledTools;
      }
    }

    if (Object.keys(adminDisabled).length > 0) {
      config.adminDisabledToolsByCatalogId = adminDisabled;
    } else {
      // Empty or no entries — remove the field to keep config clean
      delete config.adminDisabledToolsByCatalogId;
    }

    await writeConfig(configPath, config);
  });
};

/**
 * Mapping of bundled MCP server names/prefixes to their catalog IDs.
 * Used by the catalogId backfill migration.
 */
const BUNDLED_SERVER_TO_CATALOG_ID: Record<string, string> = {
  // Exact matches (base server names)
  'Granola': 'granola',
  // Preserve after Slack rebel-oss migration for legacy catalogId backfill.
  'Slack': 'bundled-slack',
  // Preserve after HubSpot rebel-oss migration for legacy catalogId backfill.
  'HubSpot': 'bundled-hubspot',
  'Microsoft365Mail': 'bundled-microsoft-mail',
  'Microsoft365Calendar': 'bundled-microsoft-calendar',
  'Microsoft365Files': 'bundled-microsoft-files',
  'Microsoft365Teams': 'bundled-microsoft-teams',
  'Microsoft365SharePoint': 'bundled-microsoft-sharepoint',
  // Rebel built-in servers - 7 split MCPs (Jan 2026)
  'RebelInbox': 'rebel-inbox',
  'RebelMeetings': 'rebel-meetings',
  'RebelSearchAndConversations': 'rebel-search-and-conversations',
  'RebelAutomations': 'rebel-automations',
  'RebelSpaces': 'rebel-spaces',
  'RebelSettings': 'rebel-settings',
  'RebelMcpConnectors': 'rebel-mcp-connectors',
  // Rebel built-in servers - other
  'RebelCanvas': 'rebel-canvas',
  'RebelDiagnostics': 'rebel-diagnostics',
  'RebelsCommunity': 'rebels-community',
  'RebelsCommunityWrite': 'rebels-community-write',
  'Discourse': 'discourse',
  'OpenAIImageGeneration': 'openai-image-generation',
  'Vanta': 'bundled-vanta',
  'Mixpanel': 'bundled-mixpanel',
  'RebelOffice': 'bundled-office',
  // Restored after rebel-oss migration (commit ba74a2136) removed Salesforce
  // from these maps and left legacy `mcpServers.Salesforce` entries stranded
  // without catalogId, blocking migrateBundledConnectorsToNpx. See REBEL-13Y
  // postmortem at docs-private/investigations/260504_salesforce_package_unavailable_REBEL-13Y.md
  'Salesforce': 'bundled-salesforce',
  // Legacy server names (kept for migration)
  'RebelInternal': 'rebel-internal',
  'RebelWorkspace': 'rebel-workspace',
  'RebelSearch': 'rebel-search-and-conversations', // Renamed Feb 2026
};

/**
 * Prefixes for instance-based servers that use email slugs.
 * Maps prefix to catalog ID.
 */
const INSTANCE_PREFIX_TO_CATALOG_ID: Record<string, string> = {
  'GoogleWorkspace-': 'bundled-google',
  // Preserve after HubSpot rebel-oss migration for legacy instance-name backfill.
  'HubSpot-': 'bundled-hubspot',
  'Microsoft365Mail-': 'bundled-microsoft-mail',
  'Microsoft365Calendar-': 'bundled-microsoft-calendar',
  'Microsoft365Files-': 'bundled-microsoft-files',
  'Microsoft365Teams-': 'bundled-microsoft-teams',
  'Microsoft365SharePoint-': 'bundled-microsoft-sharepoint',
  // See companion comment on `Salesforce` in BUNDLED_SERVER_TO_CATALOG_ID above.
  'Salesforce-': 'bundled-salesforce',
};

/**
 * Backfill catalogId for existing bundled MCP servers.
 * 
 * This migration runs on startup and adds `catalogId` (and optionally `email`)
 * to existing bundled MCP server entries that don't have them. This enables
 * catalog matching for instance-named servers like "GoogleWorkspace-greg-work-com".
 * 
 * Safety guards:
 * - Only modifies servers in the managed router config (not external configs via configPaths)
 * - Creates backup before modifications
 * - Idempotent: safe to run multiple times (skips entries with catalogId already set)
 * 
 * Scope: Primarily affects internal devs using bundled MCPs.
 * 
 * @param configPath - Path to the MCP router config file
 * @param userDataPath - The app's userData directory (from app.getPath('userData'))
 * @returns Object with count of servers updated and whether backup was created
 */
export const backfillCatalogIds = async (
  configPath: string,
  userDataPath: string
): Promise<{ updated: number; backupPath: string | null }> => {
  // Safety check 1: only modify configs in userData directory
  const resolvedConfigPath = path.resolve(configPath);
  const resolvedUserDataPath = path.resolve(userDataPath);
  if (!resolvedConfigPath.startsWith(resolvedUserDataPath + path.sep)) {
    return { updated: 0, backupPath: null };
  }

  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    if (!config?.mcpServers || typeof config.mcpServers !== 'object') {
      return { updated: 0, backupPath: null };
    }
    
    // Safety check 2: only modify router configs (identified by configPaths array)
    // This prevents accidentally mutating non-router configs that happen to be in userData
    if (!Array.isArray(config.configPaths)) {
      return { updated: 0, backupPath: null };
    }

    const servers = config.mcpServers as Record<string, Record<string, unknown>>;
    let updated = 0;

    for (const [serverName, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== 'object') continue;
      
      // Skip if already has catalogId
      if (typeof entry.catalogId === 'string' && entry.catalogId) continue;

      // Try exact match first
      if (BUNDLED_SERVER_TO_CATALOG_ID[serverName]) {
        entry.catalogId = BUNDLED_SERVER_TO_CATALOG_ID[serverName];
        updated++;
        continue;
      }

      // Try prefix match for instance-based servers
      for (const [prefix, catalogId] of Object.entries(INSTANCE_PREFIX_TO_CATALOG_ID)) {
        if (serverName.startsWith(prefix)) {
          entry.catalogId = catalogId;
          // NOTE: We intentionally do NOT backfill email from the slug here.
          // Slug parsing is lossy (dots/plus/hyphens lost) and would produce incorrect emails.
          // Instead, email will be set by OAuth flows (A3) or user input (A4) which provide accurate values.
          // Existing GoogleWorkspace instances have email in description field which is already used for display.
          updated++;
          break;
        }
      }
    }

    if (updated === 0) {
      return { updated: 0, backupPath: null };
    }

    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);
    
    return { updated, backupPath };
  });
};

/**
 * Repair bundled MCP connector paths when they become stale.
 * 
 * Path staleness can occur in several scenarios:
 * 1. macOS AppTranslocation: /private/var/folders/.../AppTranslocation/... → /Applications/...
 * 2. App moved between locations (e.g., user moves app to different folder)
 * 3. (Historical) Windows Squirrel updates changed app-X.Y.Z folders; now uses NSIS with stable paths
 * 
 * This migration:
 * 1. Identifies bundled connectors via catalogId prefix 'bundled-'
 * 2. Detects stale paths that don't match current resourcesPath
 * 3. Rewrites paths while preserving the suffix after 'resources/'
 * 4. Applies to both args[] and env values
 * 
 * Safety guards:
 * - Only runs in packaged builds (isPackaged = true)
 * - Only modifies configs within the app's userData directory
 * - Only modifies router configs (must have `configPaths` array)
 * - Creates a backup before any modification
 * 
 * @param configPath - Path to the MCP router config file
 * @param userDataPath - The app's userData directory (from app.getPath('userData'))
 * @param isPackaged - Whether the app is running as a packaged build (from app.isPackaged)
 * @param resourcesPath - The current resources path (from process.resourcesPath)
 * @returns Object with count of servers repaired and backup path if created
 */
export const repairBundledMcpScriptPaths = async (
  configPath: string,
  userDataPath: string,
  isPackaged: boolean,
  resourcesPath: string
): Promise<{ repaired: number; backupPath: string | null }> => {
  // Only applies to packaged builds - dev builds have different path patterns
  if (!isPackaged) {
    return { repaired: 0, backupPath: null };
  }

  // Safety check 1: only modify configs in userData directory
  const resolvedConfigPath = path.resolve(configPath);
  const resolvedUserDataPath = path.resolve(userDataPath);
  if (!resolvedConfigPath.startsWith(resolvedUserDataPath + path.sep)) {
    return { repaired: 0, backupPath: null };
  }

  // Normalize the current resources path for comparison
  const normalizedResourcesPath = path.normalize(resourcesPath);

  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    if (!config?.mcpServers || typeof config.mcpServers !== 'object') {
      return { repaired: 0, backupPath: null };
    }

    // Safety check 2: only modify router configs (identified by configPaths array)
    if (!Array.isArray(config.configPaths)) {
      return { repaired: 0, backupPath: null };
    }

    /**
     * Check if a path is stale (points to a different resources location).
     * A path is stale if:
     * 1. It contains '/resources/' or '\resources\' (looks like a bundled MCP path)
     * 2. It does NOT start with the current resourcesPath
     * 
     * This covers all staleness scenarios:
     * - macOS AppTranslocation: temp folder → /Applications/
     * - Any other app relocation
     */
    const isStaleResourcePath = (pathValue: string): boolean => {
      // Must contain 'resources' path component to be a bundled MCP path
      const resourcesMarker = /[/\\]resources[/\\]/i;
      if (!resourcesMarker.test(pathValue)) {
        return false;
      }
      // Path is stale if it doesn't start with current resources path
      const normalizedPath = path.normalize(pathValue);
      return !normalizedPath.startsWith(normalizedResourcesPath);
    };

    /**
     * Repair a stale path by extracting the suffix after 'resources/' and
     * joining it with the current resourcesPath.
     */
    const repairPath = (stalePathValue: string): string | null => {
      // Extract everything after 'resources/' or 'resources\'
      const match = stalePathValue.match(/resources[/\\](.+)$/i);
      if (!match) {
        return null;
      }
      // Strip any leading separator to avoid path.join treating it as absolute
      const suffix = match[1].replace(/^[/\\]+/, '');
      return path.join(resourcesPath, suffix);
    };

    const servers = config.mcpServers as Record<string, Record<string, unknown>>;
    let repaired = 0;

    for (const [_serverName, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== 'object') continue;

      // Only repair bundled connectors (identified by catalogId)
      const catalogId = entry.catalogId;
      if (typeof catalogId !== 'string' || !catalogId.startsWith('bundled-')) continue;

      let serverModified = false;

      // Repair args paths
      if (Array.isArray(entry.args)) {
        for (let i = 0; i < entry.args.length; i++) {
          const arg = entry.args[i];
          if (typeof arg === 'string' && isStaleResourcePath(arg)) {
            const repairedPath = repairPath(arg);
            if (repairedPath && repairedPath !== arg) {
              entry.args[i] = repairedPath;
              serverModified = true;
            }
          }
        }
      }

      // Repair env paths (especially NODE_PATH and other path-like values)
      if (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)) {
        const env = entry.env as Record<string, unknown>;
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === 'string' && isStaleResourcePath(value)) {
            const repairedPath = repairPath(value);
            if (repairedPath && repairedPath !== value) {
              env[key] = repairedPath;
              serverModified = true;
            }
          }
        }
      }

      if (serverModified) {
        repaired++;
      }
    }

    if (repaired === 0) {
      return { repaired: 0, backupPath: null };
    }

    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);

    return { repaired, backupPath };
  });
};

/**
 * Generated MCPs - bundles created by build-bundled-mcps.js, stored in mcp-generated/
 * These are TypeScript MCPs compiled to server.cjs via esbuild.
 */
const GENERATED_MCP_SCRIPT_NAMES: Record<string, string> = {
  'discourse': 'server.cjs',
  'google-workspace': 'server.cjs',
  'microsoft-mail': 'server.cjs',
  'microsoft-calendar': 'server.cjs',
  'microsoft-files': 'server.cjs',
  'microsoft-teams': 'server.cjs',
};

/**
 * Hand-written MCPs - source code in resources/mcp/, not generated
 * These stay in the mcp/ directory.
 */
const HANDWRITTEN_MCP_SCRIPT_NAMES: Record<string, string> = {
  'rebel-inbox': 'server.cjs',
  'rebel-meetings': 'server.cjs',
  'rebel-search-and-conversations': 'server.cjs',
  'rebel-automations': 'server.cjs',
  'rebel-spaces': 'server.cjs',
  'rebel-settings': 'server.cjs',
  'rebel-mcp-connectors': 'server.cjs',
  'rebel-diagnostics': 'server.cjs',
  'rebel-canvas': 'server.cjs',
};

/**
 * Combined mapping of all bundled MCP directory names to their expected script filenames.
 * Used for path validation - checks both generated and hand-written MCPs.
 */
const BUNDLED_MCP_SCRIPT_NAMES: Record<string, string> = {
  ...GENERATED_MCP_SCRIPT_NAMES,
  ...HANDWRITTEN_MCP_SCRIPT_NAMES,
};

/**
 * Reconcile stale bundled MCP script paths at startup.
 * 
 * This handles cases where:
 * 1. The script path points to a file that no longer exists (e.g., after app update)
 * 2. The script path ends with build/index.js (legacy format) instead of server.cjs
 * 3. Generated MCPs have paths pointing to old /mcp/ instead of /mcp-generated/
 * 
 * Only affects entries with:
 * - command: 'node'
 * - args[0] pointing to a path under resources/mcp/ or resources/mcp-generated/
 * 
 * This is more conservative than repairBundledMcpScriptPaths - it only rewrites
 * when the current path doesn't exist on disk OR uses the old script format.
 * 
 * @param configPath - Path to the MCP router config file
 * @param userDataPath - The app's userData directory
 * @param isPackaged - Whether the app is running as a packaged build
 * @param resourcesPath - The current resources path
 * @param fsAccess - Optional fs.access function for testing
 * @returns Object with count of servers reconciled and backup path if created
 */
export const reconcileBundledMcpScriptPaths = async (
  configPath: string,
  userDataPath: string,
  isPackaged: boolean,
  resourcesPath: string,
  fsAccess: (path: string) => Promise<void> = (p) => fs.access(p)
): Promise<{ reconciled: number; backupPath: string | null }> => {
  // Only applies to packaged builds
  if (!isPackaged) {
    return { reconciled: 0, backupPath: null };
  }

  // Safety check 1: only modify configs in userData directory
  const resolvedConfigPath = path.resolve(configPath);
  const resolvedUserDataPath = path.resolve(userDataPath);
  if (!resolvedConfigPath.startsWith(resolvedUserDataPath + path.sep)) {
    return { reconciled: 0, backupPath: null };
  }

  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    if (!config?.mcpServers || typeof config.mcpServers !== 'object') {
      return { reconciled: 0, backupPath: null };
    }

    // Safety check 2: only modify router configs
    if (!Array.isArray(config.configPaths)) {
      return { reconciled: 0, backupPath: null };
    }

    const servers = config.mcpServers as Record<string, Record<string, unknown>>;
    let reconciled = 0;

    const googleWorkspacePackages = new Set([
      '@anthropic-ai/google-workspace-mcp',
      'google-workspace-mcp',
    ]);

    const isGoogleWorkspacePackageArg = (arg: unknown): arg is string => {
      if (typeof arg !== 'string') return false;
      if (googleWorkspacePackages.has(arg)) return true;
      // Handle version-pinned forms like "@anthropic-ai/google-workspace-mcp@1.2.3"
      return (
        arg.startsWith('@anthropic-ai/google-workspace-mcp@') ||
        arg.startsWith('google-workspace-mcp@')
      );
    };

    /**
     * Resolve the correct path for a bundled MCP script.
     * Generated MCPs use mcp-generated/, hand-written MCPs use mcp/.
     */
    const resolveBundledScriptPath = async (mcpDirName: string): Promise<string | null> => {
      const expectedScriptName = BUNDLED_MCP_SCRIPT_NAMES[mcpDirName];
      if (!expectedScriptName) return null;

      // Determine which directory to use based on whether it's a generated or hand-written MCP
      const isGenerated = mcpDirName in GENERATED_MCP_SCRIPT_NAMES;
      const mcpBaseDir = isGenerated ? 'mcp-generated' : 'mcp';
      
      const candidate = path.join(resourcesPath, mcpBaseDir, mcpDirName, expectedScriptName);
      try {
        await fsAccess(candidate);
        return candidate;
      } catch {
        return null;
      }
    };

    for (const [serverName, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== 'object') continue;

      // Special-case: Some users may have imported a Google Workspace MCP config that points
      // at the upstream npm package (e.g., via npx), which isn't shipped in packaged builds.
      // If the server *looks like* Rebel's GoogleWorkspace entry, rewrite it to the bundled script.
      const catalogId = entry.catalogId;
      const isGoogleWorkspaceServer =
        serverName === 'GoogleWorkspace' ||
        serverName.startsWith('GoogleWorkspace-') ||
        catalogId === 'bundled-google';

      if (isGoogleWorkspaceServer && Array.isArray(entry.args)) {
        const command = typeof entry.command === 'string' ? entry.command : null;
        const args = entry.args;

        if (command && (command === 'npx' || command === 'node')) {
          const packageIndex = args.findIndex(isGoogleWorkspacePackageArg);

          if (packageIndex !== -1) {
            const bundledScript = await resolveBundledScriptPath('google-workspace');
            if (bundledScript) {
              // Preserve any trailing args after the package name (e.g., "--debug").
              const trailingArgs = args.slice(packageIndex + 1).filter((a): a is string => typeof a === 'string');

              entry.command = 'node';
              entry.args = [bundledScript, ...trailingArgs];
              reconciled++;
              continue;
            }
          }
        }
      }

      // Only process stdio entries with command: 'node'
      if (entry.command !== 'node') continue;
      if (!Array.isArray(entry.args) || entry.args.length === 0) continue;

      const scriptPath = entry.args[0];
      if (typeof scriptPath !== 'string') continue;

      // Check if this looks like a bundled MCP path
      // Match both /mcp/<name>/ and /mcp-generated/<name>/
      const mcpMatch = scriptPath.match(/[/\\]mcp(?:-generated)?[/\\]([^/\\]+)[/\\]/i);
      if (!mcpMatch) continue;

      const mcpDirName = mcpMatch[1].toLowerCase();
      const expectedScriptName = BUNDLED_MCP_SCRIPT_NAMES[mcpDirName];
      if (!expectedScriptName) continue; // Unknown MCP, skip

      // Determine the correct directory for this MCP
      const isGenerated = mcpDirName in GENERATED_MCP_SCRIPT_NAMES;
      const correctMcpBaseDir = isGenerated ? 'mcp-generated' : 'mcp';

      // Check if the path needs reconciliation:
      // 1. Path doesn't exist on disk
      // 2. Path ends with build/index.js (legacy format)
      // 3. Generated MCP is pointing to old /mcp/ location instead of /mcp-generated/
      const isLegacyFormat = /[/\\]build[/\\]index\.js$/i.test(scriptPath);
      const isWrongDirectory = isGenerated && /[/\\]mcp[/\\](?!-generated)/i.test(scriptPath);
      let pathExists = true;
      
      if (!isLegacyFormat && !isWrongDirectory) {
        // Only check fs.access if not already known to need reconciliation
        try {
          await fsAccess(scriptPath);
        } catch {
          pathExists = false;
        }
      }

      if (pathExists && !isLegacyFormat && !isWrongDirectory) {
        continue; // Path is fine, skip
      }

      // Build the correct path
      const correctPath = path.join(resourcesPath, correctMcpBaseDir, mcpDirName, expectedScriptName);

      // Only update if the correct path is different and exists
      if (correctPath === scriptPath) continue;
      
      try {
        await fsAccess(correctPath);
      } catch {
        // Correct path doesn't exist either - don't update
        continue;
      }

      // Update the path
      entry.args[0] = correctPath;
      reconciled++;
    }

    if (reconciled === 0) {
      return { reconciled: 0, backupPath: null };
    }

    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);

    return { reconciled, backupPath };
  });
};

// =============================================================================
// Startup Migration: Reconcile npx Package Versions
// =============================================================================

const catalog = catalogData as ConnectorCatalog;

/**
 * Extract the npm package specifier from npx args (the first arg after "-y" / "--yes").
 * Returns null if not found.
 *
 * @example
 * findNpxPackageArg(["-y", "@harrybloom18/xero-mcp-server@0.0.14-fix.1"]) → "@harrybloom18/xero-mcp-server@0.0.14-fix.1"
 * findNpxPackageArg(["--yes", "mcp-toolbox", "--prebuilt", "looker"]) → "mcp-toolbox"
 */
const findNpxPackageArg = (args: unknown[]): { index: number; value: string } | null => {
  const yIndex = args.findIndex(a => a === '-y' || a === '--yes');
  if (yIndex === -1 || yIndex + 1 >= args.length) return null;
  const pkg = args[yIndex + 1];
  if (typeof pkg !== 'string' || !pkg) return null;
  return { index: yIndex + 1, value: pkg };
};

/**
 * Extract the unscoped portion of an npm package name.
 * For scoped packages like `@scope/mcp-server-zendesk`, returns `mcp-server-zendesk`.
 * For unscoped packages like `mcp-toolbox`, returns `mcp-toolbox`.
 */
const unscopedPackageName = (name: string): string => {
  const slashIndex = name.indexOf('/');
  return slashIndex !== -1 && name.startsWith('@') ? name.slice(slashIndex + 1) : name;
};

const allowedCatalogPackageRenames: Record<string, Array<{ from: string; to: string }>> = {
  xero: [
    { from: '@harrybloom18/xero-mcp-server', to: '@mindstone/mcp-server-xero' },
    { from: '@xeroapi/xero-mcp-server', to: '@mindstone/mcp-server-xero' },
  ],
};

export const isAllowedCatalogNpxPackageMigration = (
  catalogId: string,
  currentPackageName: string,
  targetPackageName: string,
): boolean => {
  if (unscopedPackageName(currentPackageName) === unscopedPackageName(targetPackageName)) {
    return true;
  }

  return allowedCatalogPackageRenames[catalogId]?.some(
    ({ from, to }) => currentPackageName === from && targetPackageName === to,
  ) ?? false;
};

/**
 * Split an npm package specifier into name and version.
 * Handles scoped packages (e.g., @scope/name@version).
 *
 * @example
 * splitPackageSpecifier("@harrybloom18/xero-mcp-server@0.0.14-fix.1") → { name: "@harrybloom18/xero-mcp-server", version: "0.0.14-fix.1" }
 * splitPackageSpecifier("mcp-toolbox") → { name: "mcp-toolbox", version: null }
 */
const splitPackageSpecifier = (specifier: string): { name: string; version: string | null } => {
  // For scoped packages (@scope/name@version), find the @ after the scope
  const atIndex = specifier.startsWith('@')
    ? specifier.indexOf('@', 1)
    : specifier.indexOf('@');
  if (atIndex === -1) {
    return { name: specifier, version: null };
  }
  return {
    name: specifier.slice(0, atIndex),
    version: specifier.slice(atIndex + 1),
  };
};

/**
 * Reconcile npx package versions in user config against the connector catalog.
 *
 * When we ship a new version of an npx-based connector (e.g., bumping
 * `@harrybloom18/xero-mcp-server` from `0.0.14-fix.1` to `0.0.14-fix.3`),
 * users who already have the connector installed still have the old version
 * pinned in their config. Even disconnecting/reconnecting won't help because
 * npx caches the old package.
 *
 * This migration runs at startup and updates the args in the user's config
 * to match the catalog. On next MCP spawn, npx will see the new version
 * specifier and fetch the updated package.
 *
 * Matching strategy:
 * 1. Server must have a `catalogId` (confirming it was installed from catalog)
 * 2. Server must use `command: "npx"` with `-y`/`--yes` flag
 * 3. The unscoped package name must match (allows scope/org changes driven by catalog)
 * 4. All other config (env vars, secrets, email, workspace) is preserved
 *
 * Note: This intentionally overwrites user-modified versions — the catalog is
 * the source of truth for managed connectors (those with a catalogId). If a user
 * manually pins a newer version, it will be reverted to the catalog version on
 * next startup. This is by design: managed connectors should track the version
 * we've tested and shipped.
 *
 * Safety guards:
 * - Only modifies configs within the app's userData directory
 * - Only modifies router configs (must have `configPaths` array)
 * - Creates a backup before any modification
 * - Idempotent: safe to run multiple times
 *
 * @param configPath - Path to the MCP router config file
 * @param userDataPath - The app's userData directory
 * @returns Object with count of servers updated and backup path if created
 */
export const reconcileNpxPackageVersions = async (
  configPath: string,
  userDataPath: string,
  catalogOverride: ConnectorCatalog = catalog,
): Promise<{ updated: number; backupPath: string | null }> => {
  // Safety check 1: only modify configs in userData directory
  const resolvedConfigPath = path.resolve(configPath);
  const resolvedUserDataPath = path.resolve(userDataPath);
  if (!resolvedConfigPath.startsWith(resolvedUserDataPath + path.sep)) {
    return { updated: 0, backupPath: null };
  }

  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    if (!config?.mcpServers || typeof config.mcpServers !== 'object') {
      return { updated: 0, backupPath: null };
    }

    // Safety check 2: only modify router configs
    if (!Array.isArray(config.configPaths)) {
      return { updated: 0, backupPath: null };
    }

    // Build a lookup: catalogId → catalog npx args (only for npx-based connectors)
    const catalogNpxArgs = new Map<string, string[]>();
    for (const entry of catalogOverride.connectors) {
      if (entry.mcpConfig?.command === 'npx' && Array.isArray(entry.mcpConfig.args)) {
        catalogNpxArgs.set(entry.id, entry.mcpConfig.args);
      }
    }

    const servers = config.mcpServers as Record<string, Record<string, unknown>>;
    let updated = 0;

    for (const [, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== 'object') continue;

      // Must have a catalogId matching an npx-based catalog entry
      const catalogId = entry.catalogId;
      if (typeof catalogId !== 'string') continue;
      const catalogArgs = catalogNpxArgs.get(catalogId);
      if (!catalogArgs) continue;

      // Must be an npx command
      if (entry.command !== 'npx') continue;
      if (!Array.isArray(entry.args)) continue;

      // Extract current package specifier from user config
      const currentPkg = findNpxPackageArg(entry.args);
      if (!currentPkg) continue;

      // Extract catalog package specifier
      const catalogPkg = findNpxPackageArg(catalogArgs);
      if (!catalogPkg) continue;

      // Unscoped package name must match unless an explicit catalogId-scoped
      // package rename is allowlisted. This allows normal scope/org changes
      // while keeping arbitrary package swaps blocked.
      const current = splitPackageSpecifier(currentPkg.value);
      const target = splitPackageSpecifier(catalogPkg.value);
      if (!isAllowedCatalogNpxPackageMigration(catalogId, current.name, target.name)) continue;

      // Skip if already at the target specifier (same name + version)
      if (currentPkg.value === catalogPkg.value) continue;

      // Update the package specifier in the user's args
      if (current.name !== target.name) {
        log.info(
          { catalogId, oldPackage: current.name, newPackage: target.name },
          'Catalog-driven package name change detected, updating specifier',
        );
      }
      entry.args[currentPkg.index] = catalogPkg.value;
      updated++;
    }

    if (updated === 0) {
      return { updated: 0, backupPath: null };
    }

    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);

    return { updated, backupPath };
  });
};

// =============================================================================
// Startup Migration: Reconcile HTTP URLs from Catalog
// =============================================================================

/**
 * Reconcile HTTP/SSE MCP server URLs in user config against the connector catalog.
 *
 * When a vendor deprecates an endpoint (e.g., Webflow moved off its unstable
 * `/beta/mcp` endpoint onto the stable `/mcp` endpoint), existing users' stored
 * configs still point at the old URL. Removing and re-adding the connector
 * would fix it, but that's frustrating and destroys OAuth state.
 *
 * This migration runs at startup and updates the `url` field of user config
 * entries whose `catalogId` matches a catalog connector with a different URL.
 *
 * Matching strategy:
 * 1. Server must have a `catalogId` (confirming it was installed from catalog)
 * 2. Catalog entry must have an `mcpConfig.url` (direct HTTP/SSE connectors)
 * 3. Same-origin guard: only update when the catalog URL's origin (scheme +
 *    host + port) matches the existing URL's origin. This prevents a catalog
 *    mis-edit from silently redirecting a user's connector to a different
 *    scheme, host, or port. Only the path (and query) can change.
 * 4. All other config (oauth, type, email, credentials, tokens) is preserved.
 *    OAuth tokens stored per-packageId under `~/.super-mcp/oauth-tokens/` are
 *    unaffected; they continue to authorize against the same origin.
 *
 * Note: This intentionally overwrites user-modified URLs — the catalog is the
 * source of truth for managed connectors (those with a catalogId). Users who
 * manually pin a custom URL via the advanced config should use a non-catalog
 * server entry (no catalogId) instead.
 *
 * Safety guards:
 * - Only modifies configs within the app's userData directory
 * - Only modifies router configs (must have `configPaths` array)
 * - Same-origin guard blocks cross-domain URL swaps
 * - Creates a backup before any modification
 * - Idempotent: safe to run multiple times
 *
 * @param configPath - Path to the MCP router config file
 * @param userDataPath - The app's userData directory
 * @returns Object with count of servers updated and backup path if created
 */
export const reconcileHttpUrls = async (
  configPath: string,
  userDataPath: string,
): Promise<{ updated: number; backupPath: string | null }> => {
  // Safety check 1: only modify configs in userData directory
  const resolvedConfigPath = path.resolve(configPath);
  const resolvedUserDataPath = path.resolve(userDataPath);
  if (!resolvedConfigPath.startsWith(resolvedUserDataPath + path.sep)) {
    return { updated: 0, backupPath: null };
  }

  return withConfigMutation(async () => {
    const config = await readConfig(configPath);
    if (!config?.mcpServers || typeof config.mcpServers !== 'object') {
      return { updated: 0, backupPath: null };
    }

    // Safety check 2: only modify router configs
    if (!Array.isArray(config.configPaths)) {
      return { updated: 0, backupPath: null };
    }

    // Build a lookup: catalogId → catalog URL (only for direct HTTP/SSE connectors)
    const catalogUrls = new Map<string, string>();
    for (const entry of catalog.connectors) {
      const url = entry.mcpConfig?.url;
      if (typeof url === 'string' && url.length > 0) {
        catalogUrls.set(entry.id, url);
      }
    }

    const servers = config.mcpServers as Record<string, Record<string, unknown>>;
    let updated = 0;

    for (const [serverName, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== 'object') continue;

      // Must have a catalogId matching a catalog entry with a URL
      const catalogId = entry.catalogId;
      if (typeof catalogId !== 'string') continue;
      const catalogUrl = catalogUrls.get(catalogId);
      if (!catalogUrl) continue;

      // Must have a current URL
      const currentUrl = entry.url;
      if (typeof currentUrl !== 'string' || !currentUrl) continue;

      // Skip if already matches catalog
      if (currentUrl === catalogUrl) continue;

      // Same-origin guard — never redirect to a different host via catalog update
      let currentOrigin: string;
      let catalogOrigin: string;
      try {
        currentOrigin = new URL(currentUrl).origin;
        catalogOrigin = new URL(catalogUrl).origin;
      } catch {
        // Malformed URL — leave alone
        continue;
      }
      if (currentOrigin !== catalogOrigin) {
        log.warn(
          { catalogId, serverName, currentOrigin, catalogOrigin },
          'Skipping catalog URL reconciliation — origin mismatch (cross-domain)',
        );
        continue;
      }

      log.info(
        { catalogId, serverName, oldUrl: currentUrl, newUrl: catalogUrl },
        'Catalog-driven URL change detected, updating user config',
      );
      entry.url = catalogUrl;
      updated++;
    }

    if (updated === 0) {
      return { updated: 0, backupPath: null };
    }

    const backupPath = await createConfigBackup(configPath);
    await writeConfig(configPath, config);

    return { updated, backupPath };
  });
};
