import { createHash } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getSettings } from '@core/services/settingsStore';
import { resolveMcpConfigPath } from '@core/services/mcp/mcpConfigResolver';
import {
  type RelayProvider,
  RELAY_PROVIDERS,
  resolveProviderBasePath,
  isSafeRelativePath,
} from '@shared/authRelayConfig';
import { sendJson, readBody, log, sendRouteError, RouteError } from '../httpUtils';
import { discoverBundledOAuthMcps } from '../services/mcp/bundledMcpCloudRegistrationBridge';

const DATA_PATH = process.env.REBEL_USER_DATA || '/data';

export async function handleAuthRelay(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST' }));

  const body = await readBody(req) as {
    provider?: RelayProvider;
    relativePath?: string;
    data?: Record<string, unknown>;
  } | null;

  if (!body || typeof body !== 'object') {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing request body' }));
  }

  const { provider, relativePath, data } = body;
  if (!provider || typeof provider !== 'string') {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing provider' }));
  }

  if (!relativePath || typeof relativePath !== 'string') {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing relativePath' }));
  }

  if (!data || typeof data !== 'object') {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing token/config data' }));
  }

  if (!isSafeRelativePath(relativePath)) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Unsafe relativePath' }));
  }

  if (!(RELAY_PROVIDERS as readonly string[]).includes(provider)) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Unknown provider' }));
  }

  const basePath = resolveProviderBasePath(provider, DATA_PATH, os.homedir());
  const normalizedBase = path.resolve(basePath);
  // Defense-in-depth: normalize Windows backslashes from desktop clients
  const safeRelativePath = relativePath.replace(/\\/g, '/');
  const targetPath = path.resolve(normalizedBase, safeRelativePath);
  if (targetPath !== normalizedBase && !targetPath.startsWith(`${normalizedBase}${path.sep}`)) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Unsafe target path' }));
  }

  const fs = await import('node:fs/promises');
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(targetPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });

  log({ level: 'info', msg: 'Auth relay file written', provider, relativePath });

  if (provider === 'super-mcp') {
    try {
      const { superMcpHttpManager } = await import('@core/services/superMcpHttpManager');
      if (superMcpHttpManager.isConfigured()) {
        superMcpHttpManager.requestRestartForConfigChangeDetached({
          configPath: resolveMcpConfigPath(getSettings()) ?? path.join(DATA_PATH, 'mcp', 'super-mcp-router.json'),
          context: 'cloud-auth-relay',
          onRestartError: (err) => {
            log({ level: 'warn', msg: 'Super-MCP restart failed after auth relay', error: (err as Error).message });
          },
        });
        log({ level: 'info', msg: 'Super-MCP restart scheduled after auth relay' });
      }
    } catch (err) {
      log({ level: 'warn', msg: 'Failed to schedule Super-MCP restart after auth relay', error: (err as Error).message });
    }
  }

  // For bundled OAuth providers, discover and register the corresponding MCP(s).
  // Auth tokens may arrive after initial bootstrap (e.g., user connects a new account),
  // so we need to register the MCP entry whenever new credentials appear.
  // Only restart Super-MCP if the config file actually changed (token refreshes alone
  // should NOT trigger a restart — Super-MCP reads tokens lazily at request time).
  if (provider !== 'super-mcp') {
    try {
      const { upsertMcpServersBatch } = await import('@core/services/mcpConfigManager');
      const mcpConfigPath = resolveMcpConfigPath(getSettings()) ?? path.join(DATA_PATH, 'mcp', 'super-mcp-router.json');

      // Hash the MCP config before upsert to detect actual config changes
      const configHashBefore = await hashFileContents(mcpConfigPath);

      const oauthPayloads = await discoverBundledOAuthMcps(DATA_PATH);
      if (oauthPayloads.length > 0) {
        await upsertMcpServersBatch(mcpConfigPath, oauthPayloads);
        log({ level: 'info', msg: 'Bundled OAuth MCPs registered after auth relay', provider, count: oauthPayloads.length });

        // Only restart Super-MCP if the config file actually changed
        // (new server added/removed, not just a token refresh)
        const configHashAfter = await hashFileContents(mcpConfigPath);
        if (configHashBefore !== configHashAfter) {
          try {
            const { superMcpHttpManager } = await import('@core/services/superMcpHttpManager');
            if (superMcpHttpManager.isConfigured()) {
              superMcpHttpManager.requestRestartForConfigChangeDetached({
                configPath: mcpConfigPath,
                context: 'cloud-oauth-mcp-config-change',
                onRestartError: (err) => {
                  log({ level: 'warn', msg: 'Super-MCP restart failed after OAuth MCP registration', error: (err as Error).message });
                },
              });
              log({ level: 'info', msg: 'Super-MCP restart scheduled after OAuth MCP config change' });
            }
          } catch (restartErr) {
            log({ level: 'warn', msg: 'Failed to schedule Super-MCP restart after OAuth MCP registration', error: (restartErr as Error).message });
          }
        } else {
          log({ level: 'debug', msg: 'MCP config unchanged after auth relay, skipping Super-MCP restart', provider });
        }
      }
    } catch (err) {
      log({ level: 'warn', msg: 'Failed to register bundled OAuth MCPs after auth relay', provider, error: (err as Error).message });
    }
  }

  return sendJson(res, 200, { success: true });
}

/**
 * Hash the contents of a file for change detection.
 * Returns a hex digest, or an empty string if the file doesn't exist.
 */
async function hashFileContents(filePath: string): Promise<string> {
  try {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch (err) {
    // File doesn't exist yet — treat as empty hash
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}
