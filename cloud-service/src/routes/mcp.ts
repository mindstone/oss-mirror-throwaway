/**
 * MCP config route handler — receives merged config + OAuth tokens from migration.
 */

import http from 'node:http';
import { getSettings } from '@core/services/settingsStore';
import { resolveMcpConfigPath } from '@core/services/mcp/mcpConfigResolver';
import { sendJson, readBody, log, sendRouteError, RouteError } from '../httpUtils';
import { discoverBundledOAuthMcps } from '../services/mcp/bundledMcpCloudRegistrationBridge';
import { assertTestDataRootSafe, isTestContext } from '../testDataRootGuard';

export async function handleMcpConfig(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'PUT') return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only PUT' }));

  const body = await readBody(req) as {
    config?: { mcpServers?: Record<string, unknown>; security?: Record<string, unknown>; userDisabledToolsByServer?: Record<string, string[]>; disabledServers?: string[] };
    oauthTokens?: Array<{ packageId: string; type: 'tokens' | 'client'; data: Record<string, unknown> }>;
  } | null;

  if (!body?.config) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing config object' }));

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');

  const dataPath = process.env.REBEL_USER_DATA || '/data';
  const configPath = resolveMcpConfigPath(getSettings()) ?? path.join(dataPath, 'mcp', 'super-mcp-router.json');

  // Write flattened MCP config (no configPaths — all servers inline)
  const configToWrite = {
    mcpServers: body.config.mcpServers || {},
    ...(body.config.security ? { security: body.config.security } : {}),
    ...(body.config.userDisabledToolsByServer ? { userDisabledToolsByServer: body.config.userDisabledToolsByServer } : {}),
    ...(body.config.disabledServers ? { disabledServers: body.config.disabledServers } : {}),
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(configToWrite, null, 2), { encoding: 'utf-8', mode: 0o600 });
  log({ level: 'info', msg: 'MCP config written', serverCount: Object.keys(configToWrite.mcpServers).length });

  // Write OAuth token files
  if (body.oauthTokens && Array.isArray(body.oauthTokens)) {
    if (isTestContext()) {
      assertTestDataRootSafe(process.env.REBEL_USER_DATA, { label: 'MCP OAuth REBEL_USER_DATA' });
    }
    const tokenDir = isTestContext()
      ? path.join(dataPath, '.super-mcp', 'oauth-tokens')
      : path.join(os.homedir(), '.super-mcp', 'oauth-tokens');
    await fs.mkdir(tokenDir, { recursive: true, mode: 0o700 });

    for (const token of body.oauthTokens) {
      if (!token.packageId || !token.type || !token.data) continue;
      // Sanitize packageId to prevent path traversal (strip slashes, dots, etc.)
      const safeId = token.packageId.replace(/[^a-zA-Z0-9_\-.]/g, '_');
      const safeType = token.type === 'tokens' || token.type === 'client' ? token.type : 'tokens';
      const fileName = `${safeId}_${safeType}.json`;
      const tokenPath = path.join(tokenDir, fileName);
      // Verify resolved path is still within tokenDir
      if (!tokenPath.startsWith(tokenDir)) continue;
      await fs.writeFile(tokenPath, JSON.stringify(token.data, null, 2), { mode: 0o600 });
    }
    log({ level: 'info', msg: 'OAuth tokens written', count: body.oauthTokens.length });
  }

  // Register bundled OAuth MCPs that have credentials on disk.
  // The synced config now includes all server types (HTTP, SSE, and stdio).
  // This re-adds GoogleWorkspace, Slack, HubSpot, Salesforce, Microsoft365, Zendesk
  // entries based on auth credentials already relayed to disk.
  let oauthCount = 0;
  try {
    const { upsertMcpServersBatch } = await import('@core/services/mcpConfigManager');
    const oauthPayloads = await discoverBundledOAuthMcps(dataPath);
    if (oauthPayloads.length > 0) {
      const { count } = await upsertMcpServersBatch(configPath, oauthPayloads);
      oauthCount = count;
      log({ level: 'info', msg: 'Bundled OAuth MCPs registered after config sync', count });
    }
  } catch (err) {
    log({ level: 'warn', msg: 'Failed to register bundled OAuth MCPs after config sync', error: (err as Error).message });
  }

  // Re-run catalog-env backfill BEFORE scheduling the Super-MCP restart so
  // post-boot writes (this PUT — including desktop→cloud migration that
  // strips sandbox keys via cloudMigrationService — and any OAuth upserts
  // above) get the same SF-7 repair the boot-time backfill in
  // `cloud-service/src/bootstrap.ts` applies once at startup. Without this,
  // bundled-runway entries that arrive without `RUNWAY_ALLOWED_ROOT` /
  // `RUNWAY_DOWNLOAD_ROOT` would be picked up by the restart with no
  // sandbox env, and the spawn path falls back to tmpdir. Plan: SF-7 in
  // docs/plans/260520_runway_sandbox_central_trusted_roots.md.
  try {
    const { backfillCatalogEnvForExistingServers } = await import(
      '@main/services/catalogEnvBackfillMigration'
    );
    const backfillResult = await backfillCatalogEnvForExistingServers(configPath, {
      scrubStaleDefaultOnlyEnvKeys: true,
    });
    if (backfillResult.repaired.length > 0) {
      log({
        level: 'info',
        msg: 'Catalog-env backfill repaired entries after MCP config write',
        repaired: backfillResult.repaired.length,
        scrubbedSandboxKeysByEntry: backfillResult.repaired
          .filter((r) => r.scrubbedSandboxEnvKeys && r.scrubbedSandboxEnvKeys.length > 0)
          .map((r) => ({ serverName: r.serverName, scrubbed: r.scrubbedSandboxEnvKeys })),
      });
    }
  } catch (err) {
    log({
      level: 'warn',
      msg: 'Catalog-env backfill failed after MCP config write (non-fatal)',
      error: (err as Error).message,
    });
  }

  // Schedule Super-MCP restart to pick up new config (includes synced servers + OAuth MCPs).
  // Uses requestRestartForConfigChangeDetached to defer restart if agent turns are active
  // without coupling this route's latency to the deferred execution.
  try {
    const { superMcpHttpManager } = await import('@core/services/superMcpHttpManager');
    if (superMcpHttpManager.isConfigured()) {
      superMcpHttpManager.requestRestartForConfigChangeDetached({
        configPath,
        context: 'cloud-config-sync',
        onRestartError: (err) => {
          log({ level: 'warn', msg: 'Failed to restart Super-MCP after config update', error: (err as Error).message });
        },
      });
      log({ level: 'info', msg: 'Super-MCP restart scheduled after config update' });
    }
  } catch (err) {
    log({ level: 'warn', msg: 'Failed to schedule Super-MCP restart after config update', error: (err as Error).message });
  }

  return sendJson(res, 200, { success: true, serverCount: Object.keys(configToWrite.mcpServers).length + oauthCount });
}
