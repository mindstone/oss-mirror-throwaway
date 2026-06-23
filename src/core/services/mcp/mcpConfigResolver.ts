import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import type { McpServerConfigEntry, McpServers } from '@core/agentRuntimeTypes';
import type { AppSettings, McpServerPreview } from '@shared/types';

const log = createScopedLogger({ service: 'mcpConfigResolver' });

export type HeaderRecord = Record<string, string>;

export interface TransportInference {
  type: 'http' | 'sse';
  confidence: 'high' | 'low';
  reason: string;
}

interface NormalizedEntryResult {
  entry: McpServerConfigEntry;
  inference?: TransportInference;
}

const SSE_URL_HINTS = ['event-stream', 'eventstream', '/sse', '/stream'];
const SSE_QUERY_HINTS = new Set(['stream', 'streaming', 'eventstream']);
const SSE_QUERY_VALUES = new Set(['1', 'true', 'yes']);
const SSE_TRANSPORT_HINTS = new Set(['sse', 'eventsource', 'event-stream']);
const SSE_PROBE_TIMEOUT_MS = 2000;

export const SERVER_RECORD_KEYS = [
  'mcpServers',
  'mcp_servers',
  'servers',
  'superServers',
  'upstreamServers',
  'mcp'
];

const mapMcpType = (value: string): string | undefined => {
  const normalized = value.toLowerCase();
  if (normalized === 'stdio' || normalized === 'sdk') {
    return normalized;
  }
  if (normalized === 'sse' || normalized === 'eventsource' || normalized === 'streamable' || normalized === 'streamable-http') {
    return 'sse';
  }
  if (normalized === 'http' || normalized === 'https' || normalized === 'rest') {
    return 'http';
  }
  return normalized;
};

const sanitizeHeaders = (value: unknown): HeaderRecord | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const result: HeaderRecord = {};
  for (const [key, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof headerValue === 'string' || typeof headerValue === 'number' || typeof headerValue === 'boolean') {
      result[key] = String(headerValue);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const getHeaderValue = (headers: HeaderRecord | undefined, target: string): string | undefined => {
  if (!headers) {
    return undefined;
  }
  const normalized = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) {
      return value;
    }
  }
  return undefined;
};

const inferRemoteTransport = (url: string, headers?: HeaderRecord): TransportInference | null => {
  const acceptHeader = getHeaderValue(headers, 'accept')?.toLowerCase();
  if (acceptHeader?.includes('text/event-stream')) {
    return {
      type: 'sse',
      confidence: 'high',
      reason: 'accept-header'
    };
  }

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      type: 'http',
      confidence: 'high',
      reason: 'invalid-url'
    };
  }

  const searchParams = parsedUrl.searchParams;
  const transportParam = searchParams.get('transport')?.toLowerCase();
  if (transportParam && SSE_TRANSPORT_HINTS.has(transportParam)) {
    return {
      type: 'sse',
      confidence: 'low',
      reason: 'transport-param'
    };
  }

  for (const hint of SSE_QUERY_HINTS) {
    const value = searchParams.get(hint)?.toLowerCase();
    if (value && SSE_QUERY_VALUES.has(value)) {
      return {
        type: 'sse',
        confidence: 'low',
        reason: 'query-hint'
      };
    }
  }

  const lowerHref = parsedUrl.href.toLowerCase();
  if (SSE_URL_HINTS.some((hint) => lowerHref.includes(hint))) {
    return {
      type: 'sse',
      confidence: 'low',
      reason: 'url-hint'
    };
  }

  if (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:') {
    return {
      type: 'http',
      confidence: 'high',
      reason: 'default-http'
    };
  }

  return {
    type: 'http',
    confidence: 'high',
    reason: 'non-http-protocol'
  };
};

const shouldProbeSse = (inference?: TransportInference): boolean => {
  return Boolean(inference && inference.type === 'sse' && inference.confidence === 'low');
};

const probeSseEndpoint = async (url: string, headers?: HeaderRecord): Promise<boolean> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }

  const protocol = parsedUrl.protocol === 'http:' ? http : parsedUrl.protocol === 'https:' ? https : null;
  if (!protocol) {
    return false;
  }

  const requestHeaders: HeaderRecord = { ...(headers ?? {}) };
  if (!getHeaderValue(requestHeaders, 'accept')) {
    requestHeaders['Accept'] = 'text/event-stream';
  }
  if (!getHeaderValue(requestHeaders, 'cache-control')) {
    requestHeaders['Cache-Control'] = 'no-cache';
  }

  return new Promise<boolean>((resolve) => {
    const controller = protocol.request(
      {
        method: 'GET',
        headers: requestHeaders,
        timeout: SSE_PROBE_TIMEOUT_MS,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`
      },
      (response) => {
        const contentType = Array.isArray(response.headers['content-type'])
          ? response.headers['content-type'][0]
          : response.headers['content-type'];
        const isSse = Boolean(
          response.statusCode && response.statusCode >= 200 && response.statusCode < 400 &&
          typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream')
        );
        response.destroy();
        resolve(isSse);
      }
    );

    controller.on('error', () => resolve(false));
    controller.setTimeout(SSE_PROBE_TIMEOUT_MS, () => {
      controller.destroy();
      resolve(false);
    });

    controller.end();
  });
};

export const ensureRemoteTransportCompatibility = async (
  record: Record<string, McpServerConfigEntry>,
  inferenceByServer: Map<string, TransportInference | undefined>
): Promise<void> => {
  const entries = Object.entries(record);
  await Promise.all(
    entries.map(async ([name, entry]) => {
      if (!entry || (entry as Record<string, unknown>).type !== 'sse') {
        return;
      }
      const inference = inferenceByServer.get(name);
      if (!shouldProbeSse(inference)) {
        return;
      }
      const remoteEntry = entry as unknown as { url?: string; headers?: HeaderRecord; type?: string };
      if (!remoteEntry.url) {
        return;
      }
      const supportsSse = await probeSseEndpoint(remoteEntry.url, remoteEntry.headers);
      if (!supportsSse) {
        remoteEntry.type = 'http';
        log.warn({ name, url: remoteEntry.url }, 'SSE probe failed - falling back to HTTP transport');
      }
    })
  );
};

const CONFIG_METADATA_KEYS = new Set([
  ...SERVER_RECORD_KEYS,
  'configPaths',
  'version',
  '$schema',
]);

function normalizeMcpEntry(
  name: string,
  raw: unknown,
  configDir: string
): NormalizedEntryResult | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  if (Array.isArray(raw)) {
    return null;
  }

  if (CONFIG_METADATA_KEYS.has(name)) {
    return null;
  }

  const rawRecord = raw as Record<string, unknown>;
  if (rawRecord.disabled === true) {
    log.info({ name }, 'Skipping disabled MCP entry from config');
    return null;
  }

  const source = { ...(raw as Record<string, unknown>) };
  const transport = typeof source.transport === 'string' ? source.transport : undefined;
  if (!source.type && transport) {
    source.type = transport;
  }

  const sanitizedHeaders = sanitizeHeaders((source as Record<string, unknown>).headers);
  if (sanitizedHeaders) {
    (source as Record<string, unknown>).headers = sanitizedHeaders;
  } else if ((source as Record<string, unknown>).headers) {
    delete (source as Record<string, unknown>).headers;
  }

  let inference: TransportInference | undefined;

  const deriveType = (): string | undefined => {
    const explicit = typeof source.type === 'string' ? source.type : undefined;
    if (explicit) {
      return mapMcpType(explicit);
    }
    if (typeof source.command === 'string') {
      return 'stdio';
    }
    if (typeof source.url === 'string') {
      const inferred = inferRemoteTransport(source.url as string, sanitizedHeaders);
      if (inferred) {
        inference = inferred;
        return inferred.type;
      }
    }
    return undefined;
  };

  const type = deriveType();
  if (type) {
    source.type = type;
  }

  if (typeof source.cwd === 'string' && source.cwd.length > 0 && !path.isAbsolute(source.cwd)) {
    source.cwd = path.resolve(configDir, source.cwd);
  }

  if (typeof source.command === 'string' && source.command.length > 0) {
    const command = source.command as string;
    if (!path.isAbsolute(command) && command.startsWith('.')) {
      source.command = path.resolve(configDir, command);
    }
  }

  const description = typeof source.description === 'string' ? source.description : undefined;

  delete source.name;
  delete source.enabled;
  delete source.disabled;
  delete source.transport;

  if (description) {
    source.description = description;
  } else {
    delete source.description;
  }

  if (!source.type && !source.command && !source.url) {
    const hasServerLikeProperties = Boolean(
      rawRecord.args ||
      rawRecord.env ||
      rawRecord.cwd ||
      rawRecord.headers ||
      rawRecord.timeout ||
      rawRecord.catalogId
    );

    if (hasServerLikeProperties) {
      log.error(
        {
          name,
          hasArgs: Boolean(rawRecord.args),
          hasEnv: Boolean(rawRecord.env),
          hasCwd: Boolean(rawRecord.cwd),
        },
        'MCP server entry is missing required "type" field or "command"/"url" - skipping. Add "type": "stdio" with "command", or "type": "http"/"sse" with "url".'
      );
    } else {
      log.debug({ name }, 'Skipping unrecognized MCP config key (not a server entry)');
    }
    return null;
  }

  return {
    entry: source as McpServerConfigEntry,
    inference
  };
}

const normalizeValueToRecord = (
  value: unknown,
  configDir: string,
  inferenceTracker: Map<string, TransportInference | undefined>
): Record<string, McpServerConfigEntry> => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const entries: [string, NormalizedEntryResult | null][] = Object.entries(value as Record<string, unknown>).map(
    ([key, item]) => [key, normalizeMcpEntry(key, item, configDir)]
  );
  return entries.reduce<Record<string, McpServerConfigEntry>>((acc, [key, result]) => {
    if (result) {
      acc[key] = result.entry;
      if (result.inference) {
        inferenceTracker.set(key, result.inference);
      }
    }
    return acc;
  }, {});
};

const normalizeArrayToRecord = (
  value: unknown[],
  configDir: string,
  inferenceTracker: Map<string, TransportInference | undefined>
): Record<string, McpServerConfigEntry> => {
  const result: Record<string, McpServerConfigEntry> = {};
  value.forEach((item, index) => {
    if (!item || typeof item !== 'object') {
      return;
    }
    const container = item as Record<string, unknown>;
    const name = (container.name as string) ?? (container.id as string) ?? `server-${index + 1}`;
    const payload = (container.config as unknown) ?? item;
    const normalized = normalizeMcpEntry(name, payload, configDir);
    if (normalized) {
      result[name] = normalized.entry;
      if (normalized.inference) {
        inferenceTracker.set(name, normalized.inference);
      }
    }
  });
  return result;
};

const tryExtractRecord = (
  value: unknown,
  configDir: string,
  inferenceTracker: Map<string, TransportInference | undefined>
): Record<string, McpServerConfigEntry> => {
  if (!value) return {};
  if (Array.isArray(value)) {
    return normalizeArrayToRecord(value, configDir, inferenceTracker);
  }
  if (typeof value === 'object') {
    return normalizeValueToRecord(value, configDir, inferenceTracker);
  }
  return {};
};

export const extractServerRecord = (
  parsed: unknown,
  resolvedPath: string,
  inferenceTracker: Map<string, TransportInference | undefined>
): Record<string, McpServerConfigEntry> => {
  const configDir = path.dirname(resolvedPath);
  let record = tryExtractRecord(parsed, configDir, inferenceTracker);
  if (Object.keys(record).length === 0 && parsed && typeof parsed === 'object') {
    for (const key of SERVER_RECORD_KEYS) {
      const nested = (parsed as Record<string, unknown>)[key];
      record = tryExtractRecord(nested, configDir, inferenceTracker);
      if (Object.keys(record).length > 0) {
        break;
      }
    }
  }
  return record;
};

const deriveTransport = (entry: McpServerConfigEntry): McpServerPreview['transport'] => {
  const rec = entry as Record<string, unknown>;
  const type = typeof rec.type === 'string' ? rec.type.toLowerCase() : 'stdio';
  if (type === 'sse') {
    return 'sse';
  }
  if (type === 'http' || type === 'https' || type === 'rest') {
    return 'http';
  }
  return 'stdio';
};

const toStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : null;
};

const buildServerPreview = (name: string, entry: McpServerConfigEntry): McpServerPreview => {
  const transport = deriveTransport(entry);
  const rec = entry as Record<string, unknown>;
  const command = typeof rec.command === 'string' ? rec.command : null;
  const url = typeof rec.url === 'string' ? rec.url : null;
  const cwd = typeof rec.cwd === 'string' ? rec.cwd : null;
  const envKeys = rec.env && typeof rec.env === 'object'
    ? Object.keys(rec.env as Record<string, unknown>)
    : [];
  const headersKeys = rec.headers && typeof rec.headers === 'object'
    ? Object.keys(rec.headers as Record<string, unknown>)
    : [];
  const description = typeof rec.description === 'string' ? rec.description : null;
  const catalogId = typeof rec.catalogId === 'string' ? rec.catalogId : null;
  const email = typeof rec.email === 'string' ? rec.email : null;
  const workspace = typeof rec.workspace === 'string' ? rec.workspace : null;
  const lastConnectedAt = typeof rec.lastConnectedAt === 'number' ? rec.lastConnectedAt : null;
  const oauth = rec.oauth === true ? true : undefined;
  return {
    name,
    transport,
    type: typeof rec.type === 'string' ? rec.type : null,
    command,
    args: toStringArray(rec.args) ?? undefined,
    url,
    cwd,
    envKeys: envKeys.length > 0 ? envKeys : undefined,
    headersKeys: headersKeys.length > 0 ? headersKeys : undefined,
    description,
    catalogId,
    email,
    workspace,
    lastConnectedAt,
    ...(oauth === true ? { oauth: true } : {}),
  };
};

export const buildPreviewList = (record?: McpServers): McpServerPreview[] => {
  if (!record) {
    return [];
  }
  return Object.entries(record).map(([name, entry]) => buildServerPreview(name, entry));
};

export const buildPreviewFromNormalizedRecord = (
  record: Record<string, McpServerConfigEntry>
): McpServerPreview[] => {
  return Object.entries(record).map(([name, entry]) => buildServerPreview(name, entry));
};

export const resolveMcpConfigPath = (settings: AppSettings): string | null => {
  const mcpPath = settings.mcpConfigFile?.trim();
  if (!mcpPath) {
    return null;
  }
  const baseDir = settings.coreDirectory ?? process.cwd();
  return path.isAbsolute(mcpPath) ? mcpPath : path.resolve(baseDir, mcpPath);
};
