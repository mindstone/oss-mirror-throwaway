import fs from 'node:fs';
import { createScopedLogger } from '@core/logger';
import { parseUseToolEnvelopeJson } from '@core/rebelCore/superMcpEnvelope';
import type { PrefetchDocumentFn, PrefetchToolResult, ServerInstanceInfo } from '@core/services/documentPrefetchService';
import { withSuperMcpClient, getTextEntryFromToolResult, resolveMcpConfigPath } from './mcpService';
import type { AppSettings } from '@shared/types';

const log = createScopedLogger({ service: 'documentPrefetchAdapter' });

interface UseToolEnvelope {
  package_id: string;
  tool_id: string;
  result: unknown;
  telemetry?: { materialized?: boolean };
}

interface MaterializedResult {
  status: 'materialized';
  file_path: string;
  size_chars: number;
  preview: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractTextFromToolResult(result: unknown): string {
  if (!isRecord(result)) return String(result ?? '');
  const content = result.content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const textBlocks = content
    .filter((b: unknown) => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b: unknown) => (b as { text: string }).text);
  return textBlocks.join('\n');
}

export function createMcpPrefetchFn(): PrefetchDocumentFn {
  return async ({ serverInstanceId, toolName, args, timeoutMs, signal }): Promise<PrefetchToolResult> => {
    const toolId = `${serverInstanceId}__${toolName}`;

    return await withSuperMcpClient(async (client) => {
      const fetchPromise = client.callTool({
        name: 'use_tool',
        arguments: {
          package_id: serverInstanceId,
          tool_id: toolId,
          args,
          max_output_chars: 15000,
        },
      }, undefined, { timeout: timeoutMs });

      // Respect abort signal
      let result: unknown;
      if (signal) {
        result = await Promise.race([
          fetchPromise,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new Error('Prefetch aborted'));
            signal.addEventListener('abort', () => reject(new Error('Prefetch aborted')), { once: true });
          }),
        ]);
      } else {
        result = await fetchPromise;
      }

      const textEntry = getTextEntryFromToolResult(result);
      if (!textEntry) throw new Error('No text response from tool');

      // Parse the use_tool envelope. Super-MCP may append a non-JSON suffix
      // (continuation hint, large-output warning, oversized-output placeholder)
      // separated by "\n\n" — the helper strips it before parsing.
      const envelope = parseUseToolEnvelopeJson<UseToolEnvelope>(textEntry.text);
      if (!envelope) {
        // If not valid JSON, treat the raw text as inline content
        return { content: textEntry.text, charCount: textEntry.text.length, isMaterialized: false };
      }

      // Check if materialized
      if (envelope.telemetry?.materialized && isRecord(envelope.result)) {
        const matResult = envelope.result as unknown as MaterializedResult;
        if (matResult.status === 'materialized' && matResult.file_path) {
          return {
            content: matResult.preview ?? '',
            charCount: matResult.size_chars ?? 0,
            isMaterialized: true,
            materializedPath: matResult.file_path,
          };
        }
      }

      // Inline content: extract text from the inner tool result
      const innerContent = extractTextFromToolResult(envelope.result);
      return {
        content: innerContent,
        charCount: innerContent.length,
        isMaterialized: false,
      };
    });
  };
}

export async function resolveActiveServerInstances(settings: AppSettings): Promise<ServerInstanceInfo[]> {
  try {
    const configPath = resolveMcpConfigPath(settings);
    if (!configPath) return [];

    let config: Record<string, unknown>;
    try {
      const content = await fs.promises.readFile(configPath, 'utf-8');
      config = JSON.parse(content) as Record<string, unknown>;
    } catch (err) {
      // Config absent (ENOENT) is normal — recover silently. A corrupt/unreadable
      // config silently presenting as "no active servers" would hide the failure,
      // so make it observable before the empty fallback.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, configPath }, 'Failed to read MCP config for prefetch — treating as no active servers');
      }
      return [];
    }

    const instances: ServerInstanceInfo[] = [];
    const disabledServers = new Set<string>(
      Array.isArray(config.disabledServers) ? (config.disabledServers as string[]) : []
    );

    // Handle both mcpServers (new) and mcp-servers (legacy) config shapes
    const servers = (config.mcpServers ?? config['mcp-servers'] ?? {}) as Record<string, unknown>;

    for (const [serverId, serverConfig] of Object.entries(servers)) {
      if (!isRecord(serverConfig)) continue;
      const catalogId = typeof serverConfig.catalogId === 'string' ? serverConfig.catalogId : '';

      instances.push({
        instanceId: serverId,
        catalogId,
        isDisabled: disabledServers.has(serverId),
      });
    }

    return instances;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to resolve active server instances');
    return [];
  }
}
