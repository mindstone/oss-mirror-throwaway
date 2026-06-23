/**
 * Bundled OAuth MCP Cloud Registration
 *
 * Discovers bundled OAuth MCPs (GoogleWorkspace, Slack, HubSpot,
 * Microsoft365) by scanning credential directories on disk. Builds
 * MCP server payloads ready for registration via upsertMcpServersBatch().
 *
 * Called from:
 * - initCoreServices() at startup (step 9e)
 * - handleMcpConfig() after cloud config sync (re-registers after overwrite)
 * - handleAuthRelay() after new auth credentials arrive
 *
 * Safe to call on both desktop and cloud:
 * - Desktop: credentials exist at desktop paths, payloads match existing registrations (harmless upsert)
 * - Cloud: discovers credentials written by auth relay, fills the registration gap
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { McpServerUpsertPayload } from '@shared/types';
import { type OAuthRelayProvider, resolveProviderBasePath } from '@shared/authRelayConfig';
import { generateInstanceId } from '@shared/utils/mcpInstanceUtils';
import { createScopedLogger } from '@core/logger';
import {
  buildGoogleWorkspaceInstancePayload,
  buildSlackInstancePayload,
  buildMicrosoft365MailPayload,
  buildMicrosoft365CalendarPayload,
  buildMicrosoft365FilesPayload,
  buildMicrosoft365TeamsPayload,
  buildMicrosoft365SharePointPayload,
} from './bundledMcpManager';
import {
  resolveOAuthCredentials,
  googleCredentialSource,
  hubspotCredentialSource,
  resolveMicrosoftClientId,
  microsoftCredentialSource,
  slackCredentialSource,
} from './oauthCredentials';
import { getPlatformConfig } from '@core/platform';
import { getSettings } from '@core/services/settingsStore';
import { findCatalogEntryById } from '@core/services/connectorCatalogService';
import { getStoredScopeTier } from './hubspotAuthService';
import { getTelemetrySaltHex } from './hubspotTelemetry';

const log = createScopedLogger({ service: 'bundledMcpCloudRegistration' });

// ---------------------------------------------------------------------------
// Provider credential directory mapping
// ---------------------------------------------------------------------------
// Uses the shared resolveProviderBasePath() from @shared/authRelayConfig —
// single source of truth for provider-to-path mapping.

interface ProviderPaths {
  google: string;
  slack: string;
  hubspot: string;
  microsoft: string;
}

/** Map of short provider keys to OAuthRelayProvider names. */
const PROVIDER_KEY_MAP: Record<keyof ProviderPaths, OAuthRelayProvider> = {
  google: 'google-workspace',
  slack: 'slack',
  hubspot: 'hubspot',
  microsoft: 'microsoft',
};

function getProviderPaths(dataPath: string): ProviderPaths {
  const resolve = (provider: OAuthRelayProvider) =>
    resolveProviderBasePath(provider, dataPath, '');

  return {
    google: resolve(PROVIDER_KEY_MAP.google),
    slack: resolve(PROVIDER_KEY_MAP.slack),
    hubspot: resolve(PROVIDER_KEY_MAP.hubspot),
    microsoft: resolve(PROVIDER_KEY_MAP.microsoft),
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function hasTokenFiles(credentialsDir: string): Promise<boolean> {
  if (!await dirExists(credentialsDir)) return false;
  try {
    const files = await fs.readdir(credentialsDir);
    return files.some(f => f.endsWith('.token.json'));
  } catch {
    return false;
  }
}

/**
 * Check whether a token file exists for a specific email.
 * Token filenames use the pattern: sanitized-email.token.json
 * where non-alphanumeric chars are replaced with hyphens.
 */
async function hasTokenForEmail(credentialsDir: string, email: string): Promise<boolean> {
  const sanitized = email.replace(/[^a-zA-Z0-9]/g, '-');
  const tokenFile = path.join(credentialsDir, `${sanitized}.token.json`);
  return fileExists(tokenFile);
}

// ---------------------------------------------------------------------------
// Per-provider discovery
// ---------------------------------------------------------------------------

/** Google Workspace: multi-instance, one directory per account. */
async function discoverGoogleWorkspace(basePath: string): Promise<McpServerUpsertPayload[]> {
  if (!await dirExists(basePath)) return [];

  const creds = resolveOAuthCredentials(googleCredentialSource);
  if (!creds) {
    log.debug('No Google OAuth credentials available — skipping Google Workspace');
    return [];
  }

  const payloads: McpServerUpsertPayload[] = [];

  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(basePath, { withFileTypes: true });
  } catch (err) {
    // basePath existence was just checked above, so a read failure here is
    // unexpected — silently presenting it as "no Google Workspace connectors"
    // would hide a real problem. Make it observable before the empty fallback.
    log.warn({ err, basePath }, 'Failed to read Google Workspace connector directory — skipping (connectors will appear missing)');
    return [];
  }

  let surface: 'desktop' | 'cloud' | 'mobile' | 'cli' = 'desktop';
  try {
    surface = getPlatformConfig().surface;
  } catch {
    // PlatformConfig not initialised — treat as desktop. Production callers run
    // after bootstrap; this keeps early cold-start discovery fail-open for local
    // refresh while cloud remains explicitly gated once surface is available.
  }
  const isCloud = surface === 'cloud';
  const disableRefresh = isCloud && process.env.OSS_SYNC_DISABLED === '1';

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip non-instance directories (e.g., bare "credentials" in shared staging dir)
    if (entry.name === 'credentials') continue;

    const instanceDir = path.join(basePath, entry.name);
    const accountsPath = path.join(instanceDir, 'accounts.json');
    const credentialsDir = path.join(instanceDir, 'credentials');

    const accounts = await readJsonSafe<{ accounts?: Array<{ email?: string }> }>(accountsPath);
    const email = accounts?.accounts?.[0]?.email;
    if (!email) continue;

    if (!await hasTokenFiles(credentialsDir)) continue;

    const instanceId = generateInstanceId('GoogleWorkspace', email);

    const payload = buildGoogleWorkspaceInstancePayload({
      instanceId,
      email,
      description: `${email} - Calendar, Drive, Gmail, Contacts access`,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      accountsPath,
      credentialsPath: credentialsDir,
    });

    if (disableRefresh) {
      payload.env = {
        ...(payload.env ?? {}),
        GOOGLE_WORKSPACE_DISABLE_REFRESH: '1',
      };
    }

    payloads.push(payload);

    log.info(
      {
        email,
        instanceId,
        surface,
        googleWorkspaceDisableRefresh: disableRefresh,
      },
      'Discovered Google Workspace instance',
    );
  }

  return payloads;
}

/** Slack: multi-instance, one workspace per teamId. */
async function discoverSlack(basePath: string): Promise<McpServerUpsertPayload[]> {
  if (!await dirExists(basePath)) return [];

  const configPath = path.join(basePath, 'config.json');
  const config = await readJsonSafe<{ workspaces?: Array<{ teamId?: string; teamName?: string }> }>(configPath);
  if (!config?.workspaces || !Array.isArray(config.workspaces)) return [];

  // Resolve OAuth client credentials so the OSS Slack MCP can refresh tokens.
  // On cloud, `SLACK_DISABLE_REFRESH=1` is only injected when
  // `OSS_SYNC_DISABLED=1` is set (advanced opt-out of sync-led model).
  const creds = resolveOAuthCredentials(slackCredentialSource);
  if (!creds) {
    log.debug('No Slack OAuth credentials available — bundled MCP will not be able to refresh tokens');
  }

  let surface: 'desktop' | 'cloud' | 'mobile' | 'cli' = 'desktop';
  try {
    surface = getPlatformConfig().surface;
  } catch {
    // PlatformConfig not initialised — treat as desktop. This branch only
    // matters for very early call sites; production callers run after
    // bootstrap so the throw should not happen there.
  }
  const isCloud = surface === 'cloud';
  const disableRefresh = isCloud && process.env.OSS_SYNC_DISABLED === '1';

  const payloads: McpServerUpsertPayload[] = [];

  for (const workspace of config.workspaces) {
    if (!workspace.teamId || !workspace.teamName) continue;

    const tokenPath = path.join(basePath, 'workspaces', `${workspace.teamId}.json`);
    const tokens = await readJsonSafe<{ botToken?: string; userToken?: string }>(tokenPath);
    if (!tokens?.botToken) continue;

    const payload = buildSlackInstancePayload({
      teamId: workspace.teamId,
      teamName: workspace.teamName,
      botToken: tokens.botToken,
      userToken: tokens.userToken,
      configPath: basePath,
      ...(creds ? { clientId: creds.clientId, clientSecret: creds.clientSecret } : {}),
    });

    if (disableRefresh) {
      // Sync opt-out mode: force cloud-side MCP to read tokens but never
      // refresh (`OSS_SYNC_DISABLED=1`).
      //
      // STAGE 1 DEPENDENCY: this env flag is a contract with the OSS package
      // `@mindstone-engineering/mcp-server-slack` (Stage 1 work in flight).
      // The OSS package's tokenProvider must check `SLACK_DISABLE_REFRESH=1`
      // and refuse to call `oauth.v2.access`, returning the structured
      // `auth_required` response shape instead. If the OSS package ignores
      // this flag, Risk 4b (cross-machine refresh-token race) re-opens
      // SILENTLY — there is no host-side check that would catch it. Stage 1
      // acceptance gates must include a test that confirms the published
      // package honors the flag.
      payload.env = { ...(payload.env ?? {}), SLACK_DISABLE_REFRESH: '1' };
    }

    payloads.push(payload);

    log.info(
      {
        teamId: workspace.teamId,
        teamName: workspace.teamName,
        surface,
        slackDisableRefresh: disableRefresh,
        hasClientCreds: !!creds,
      },
      'Discovered Slack workspace',
    );
  }

  return payloads;
}

/** HubSpot: one MCP instance per account email. */
async function discoverHubSpot(basePath: string): Promise<McpServerUpsertPayload[]> {
  if (!await dirExists(basePath)) return [];

  const creds = resolveOAuthCredentials(hubspotCredentialSource);
  if (!creds) {
    log.debug('No HubSpot OAuth credentials available — skipping');
    return [];
  }

  const accounts = await readJsonSafe<{ accounts?: Array<{ email?: string; scopeTier?: 'readonly' | 'full' }> }>(
    path.join(basePath, 'accounts.json'),
  );
  const accountEntries: Array<{ email: string }> = [];
  for (const account of accounts?.accounts ?? []) {
    const email = account.email?.trim();
    if (email) {
      accountEntries.push({ email });
    }
  }
  if (accountEntries.length === 0) return [];

  // Surface-gate the refresh-disable flag (mirrors `discoverSlack`).
  // `HUBSPOT_DISABLE_REFRESH=1` is only applied when `OSS_SYNC_DISABLED=1`.
  // Injecting HUBSPOT_DISABLE_REFRESH=1 unconditionally — as the original Stage 5
  // landing did — caused desktop subprocesses to bounce every CRM call to
  // `auth_required/refresh_disabled` after the access token expired (30-60
  // min TTL), because the host-side refresher the Stage 5 design implied
  // was never built. See 260517 postmortem.
  let surface: 'desktop' | 'cloud' | 'mobile' | 'cli' = 'desktop';
  try {
    surface = getPlatformConfig().surface;
  } catch {
    // PlatformConfig not initialised — treat as desktop. This branch only
    // matters for very early call sites; production callers run after
    // bootstrap so the throw should not happen there.
  }
  const isCloud = surface === 'cloud';
  const disableRefresh = isCloud && process.env.OSS_SYNC_DISABLED === '1';

  // Catalog is the source of truth for the HubSpot OSS package pin.
  // The previous hardcoded literal inside the per-account payload push
  // masked catalog-load failures; v2 of the OSS release automation plan
  // (260525) requires this lookup to fail loudly. One lookup per call,
  // reused across all accounts in this discovery run.
  const hubspotCatalogEntry = findCatalogEntryById('bundled-hubspot');
  if (!hubspotCatalogEntry?.mcpConfig?.args || hubspotCatalogEntry.mcpConfig.args.length === 0) {
    throw new Error(
      'Catalog entry "bundled-hubspot" missing mcpConfig.args. The connector catalog is the source of truth for OSS package pins; falling back to a hardcoded version is no longer supported (per docs/plans/260525_oss_release_automation.md v2). This indicates a P0 catalog-load issue.',
    );
  }
  const hubspotCommand = hubspotCatalogEntry.mcpConfig.command ?? 'npx';
  const hubspotArgs = hubspotCatalogEntry.mcpConfig.args;

  const telemetrySaltHex = await getTelemetrySaltHex();
  const payloads: McpServerUpsertPayload[] = [];
  for (const account of accountEntries) {
    const email = account.email;
    const instanceId = generateInstanceId('HubSpot', email);
    try {
      if (!await hasTokenForEmail(path.join(basePath, 'credentials'), email)) {
        continue;
      }

      const scopeTier = await getStoredScopeTier(email);
      const env: Record<string, string> = {
        HUBSPOT_CLIENT_ID: creds.clientId,
        HUBSPOT_CLIENT_SECRET: creds.clientSecret,
        HUBSPOT_CONFIG_DIR: basePath,
        HUBSPOT_ACCOUNT_EMAIL: email,
        HUBSPOT_SCOPE_TIER: scopeTier,
        HUBSPOT_TELEMETRY_SALT: telemetrySaltHex,
        HUBSPOT_SOURCE_LABEL: 'Mindstone Rebel',
        LOG_MODE: 'strict',
      };
      if (disableRefresh) {
        env.HUBSPOT_DISABLE_REFRESH = '1';
      }

      payloads.push({
        name: instanceId,
        transport: 'stdio',
        command: hubspotCommand,
        args: [...hubspotArgs],
        description:
          `${email} - HubSpot CRM (95 tools). Contacts, companies, deals, tickets, tasks, products, line items. ` +
          'File uploads & attachments. Lists/segments with batch export. Forms, analytics, marketing emails. ' +
          'Conversation thread reads (ticket threads + messages).',
        catalogId: 'bundled-hubspot',
        email,
        env,
      });

      log.info(
        {
          instanceId,
          surface,
          hubspotDisableRefresh: disableRefresh,
          hasScopeTier: Boolean(scopeTier),
        },
        'Discovered HubSpot account for cloud registration',
      );
    } catch (err) {
      log.warn(
        { instanceId, err },
        'discoverHubSpot: failed to register one account; continuing with remaining accounts',
      );
    }
  }

  return payloads;
}

/** Microsoft 365: per-account instance entries, registers 5 MCPs per account. */
async function discoverMicrosoft(basePath: string): Promise<McpServerUpsertPayload[]> {
  if (!await dirExists(basePath)) return [];

  // Must have registered accounts with emails AND matching token files.
  // An empty accounts.json (accounts: []) means the user disconnected — do not re-register.
  const accountsData = await readJsonSafe<{ accounts?: Array<{ email?: string }> }>(
    path.join(basePath, 'accounts.json'),
  );
  const accountEmails = (accountsData?.accounts ?? [])
    .map((a) => a.email)
    .filter((e): e is string => !!e);
  if (accountEmails.length === 0) return [];

  const clientId = resolveMicrosoftClientId(microsoftCredentialSource);
  if (!clientId) {
    log.debug('No Microsoft client ID available — skipping');
    return [];
  }

  // Surface-gate the refresh-disable flag (mirrors discoverHubSpot + Slack).
  // `MICROSOFT_DISABLE_REFRESH=1` is only applied when `OSS_SYNC_DISABLED=1`.
  // Without surface gating, injecting MICROSOFT_DISABLE_REFRESH=1 unconditionally would bounce every Microsoft
  // tool call on desktop to auth_required after the 60-min access token
  // expires — same regression class as the HubSpot Stage 5 landing
  // (postmortem 260517).
  let surface: 'desktop' | 'cloud' | 'mobile' | 'cli' = 'desktop';
  try {
    surface = getPlatformConfig().surface;
  } catch {
    // PlatformConfig not initialised — treat as desktop. Production callers
    // run after bootstrap; this keeps early cold-start discovery fail-open
    // for local refresh while cloud remains explicitly gated once surface
    // is available.
  }
  const isCloud = surface === 'cloud';
  const disableRefresh = isCloud && process.env.OSS_SYNC_DISABLED === '1';

  const payloads: McpServerUpsertPayload[] = [];
  for (const email of accountEmails) {
    if (!await hasTokenForEmail(path.join(basePath, 'credentials'), email)) continue;

    const msConfig = { clientId, configDir: basePath, email };
    const surfacePayloads = [
      buildMicrosoft365MailPayload(msConfig),
      buildMicrosoft365CalendarPayload(msConfig),
      buildMicrosoft365FilesPayload(msConfig),
      buildMicrosoft365TeamsPayload(msConfig),
      buildMicrosoft365SharePointPayload(msConfig),
    ];

    if (disableRefresh) {
      // Stage-1 dependency: the host injects MICROSOFT_DISABLE_REFRESH=1 on
      // cloud only. The OSS Microsoft MCP packages must check this flag and
      // refuse to refresh tokens on their own — same contract as the Slack
      // OSS package. The flag is NOT baked into the connector catalog;
      // Phase B2's skipped post-flip drift detector asserts that it stays
      // out of the catalog mcpConfig.env so the host stays in control.
      for (const payload of surfacePayloads) {
        payload.env = {
          ...(payload.env ?? {}),
          MICROSOFT_DISABLE_REFRESH: '1',
        };
      }
    }

    payloads.push(...surfacePayloads);
    log.info(
      {
        email,
        mcpCount: surfacePayloads.length,
        surface,
        microsoftDisableRefresh: disableRefresh,
      },
      'Discovered Microsoft 365 credentials',
    );
  }
  return payloads;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover bundled OAuth MCPs that have credentials available on disk.
 *
 * Scans known auth credential directories for each provider and builds
 * MCP server payloads for any that have valid credentials. Each provider
 * is discovered independently — a failure in one does not block others.
 *
 * @param dataPath - Base data directory (/data on cloud, app.getPath('userData') on desktop)
 * @returns Array of MCP server payloads to register via upsertMcpServersBatch()
 */
export async function discoverBundledOAuthMcps(
  dataPath: string,
): Promise<McpServerUpsertPayload[]> {
  const paths = getProviderPaths(dataPath);
  const payloads: McpServerUpsertPayload[] = [];

  const discoveries = [
    { name: 'GoogleWorkspace', fn: () => discoverGoogleWorkspace(paths.google) },
    { name: 'Slack', fn: () => discoverSlack(paths.slack) },
    { name: 'HubSpot', fn: () => discoverHubSpot(paths.hubspot) },
    { name: 'Microsoft365', fn: () => discoverMicrosoft(paths.microsoft) },
  ];

  for (const { name, fn } of discoveries) {
    try {
      const results = await fn();
      payloads.push(...results);
    } catch (err) {
      log.warn({ err, provider: name }, 'Failed to discover bundled OAuth MCP credentials');
    }
  }

  if (payloads.length > 0) {
    log.info({ count: payloads.length }, 'Discovered bundled OAuth MCPs from disk');
  }

  // Strip lastConnectedAt from discovery payloads. Discovery re-registers existing
  // servers; it does not represent a new user connection. The build functions set
  // Date.now() which would change the config hash on every call, triggering
  // unnecessary Super-MCP restarts. upsertMcpServersBatch preserves the existing
  // lastConnectedAt when the incoming payload omits it.
  for (const payload of payloads) {
    delete payload.lastConnectedAt;
  }

  return payloads;
}
