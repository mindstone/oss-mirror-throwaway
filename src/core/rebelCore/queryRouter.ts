/**
 * Query Router — Entry point for agent turns through Rebel Core.
 *
 * Only agentTurnExecutor imports queryWithRuntime(). Other query() consumers
 * (compaction, BTS, warmup, useCase) call the Anthropic API directly.
 *
 * Extracts proxy configuration from env vars and delegates to rebelCoreQuery().
 *
 * @see docs/project/PROVIDER_RESOLUTION_AND_ROUTING.md — the routing flow this is the entry point of
 * @see docs/project/REBEL_CORE.md — runtime architecture
 * @see docs/project/PROXY_AUTH_BOUNDARY.md — proxyConfig / provider-identity-header contract parsed here
 */
import type { AgentMessage } from '@core/agentRuntimeTypes';
import { createScopedLogger } from '@core/logger';
import type { AppNavigationService } from '@core/appNavigationService';
import type { ScreenshotCaptureService } from '@core/screenshotCaptureService';
import { getSettings } from '@core/services/settingsStore';
import { rebelCoreQuery } from './rebelCoreQuery';
import type { ProfileConnectivity } from '@shared/utils/connectivityHelpers';
import type { OnMcpErrorCallback } from './types';
import type { TurnParams } from './turnParams';
import type { RuntimeActivityEvent } from './runtimeActivity';
import { getPlatformConfig } from '@core/platform';
import type { RoutingModelId } from '@shared/utils/modelChoiceCodec';

const log = createScopedLogger({ service: 'queryRouter' });

export interface QueryRouterContext {
  superMcpUrl?: string | null;
  sessionId?: string;
  origin?: string;
  /** Turn ID from the executor — used for transcript logging. Falls back to randomUUID() if absent. */
  turnId?: string;
  /**
   * User home directory. Enables the `~/mcp-servers/<project>/` write-sandbox
   * exception for the build-custom-mcp-server skill. See
   * `src/core/rebelCore/toolPathResolver.ts`.
   */
  homePath?: string;
  /** App user-data directory (desktop: app.getPath('userData')). Enables dynamic Bash-guard matching for MCP config paths. */
  userDataPath?: string;
  /**
   * Bundled rebel-system directory path (desktop: getSystemSettingsPath()).
   * Allows Read/Edit through the `<workspace>/rebel-system/` symlink, whose
   * realpath resolves outside the workspace root. Cloud/mobile pass undefined
   * — the symlink does not exist there.
   */
  rebelSystemRoot?: string;
  onMcpError?: OnMcpErrorCallback;
  /** Desktop-only capability. Undefined on cloud/mobile. */
  captureRebelWindow?: ScreenshotCaptureService['captureRebelWindow'];
  /** Desktop-only internal app navigation capability. Undefined on cloud/mobile. */
  navigateApp?: AppNavigationService['navigateApp'];
  getCacheAgeMs?: () => number;
  onStreamActivity?: (event: RuntimeActivityEvent) => void;
  onToolDispatch?: (toolUseId: string, controller: AbortController) => void;
  onToolSettle?: (toolUseId: string) => void;
  onFileChanged?: (filePath: string) => void;
  getLatestSuperMcpUrl?: () => string | null;
  /** Pre-built execution client — bypasses internal client creation in rebelCoreQuery when provided. */
  executionClient?: import('./modelClient').ModelClient;
  /** Pre-built planning client — bypasses internal planning client creation in rebelCoreQuery when provided. */
  planningClient?: import('./modelClient').ModelClient;
  /** Actual execution model name — overrides the Claude model from env vars when an injected executionClient uses a different model. */
  executionModelOverride?: RoutingModelId;
  /** Actual planning model name — overrides the Claude model from env vars when an injected planningClient uses a different model. */
  planningModelOverride?: RoutingModelId;
  /**
   * True iff the user explicitly overrode the model/profile for THIS turn (per-conversation override),
   * NOT for users on a default working profile. Used to disable Smart picking for the turn so the user's
   * pick is honoured exactly. Distinct from `executionModelOverride`, which is set whenever a direct
   * (non-proxy) execution client is injected — including for default working profiles.
   */
  perConversationModelOverride?: boolean;
  /** Codex OAuth mode — forwarded to rebelCoreQuery for fallback/subagent client creation */
  codexMode?: import('./codexModeTypes').CodexModeConfig;
  /** Optional connection liveness snapshot for connection-managed profiles. */
  connectivity?: ProfileConnectivity;
  /** Host surface for built-in tools that gate desktop-only workspace capabilities. */
  surfaceCapability?: 'desktop' | 'cloud';
  /** Stage 1 default is false; later stages thread explicit council intent. */
  wasExplicitCouncilIntent?: boolean;
}

/**
 * Extract proxy configuration from env vars.
 * The executor sets ANTHROPIC_BASE_URL and ANTHROPIC_CUSTOM_HEADERS via
 * queryOptionsBuilder proxy env builders; we parse them into an explicit
 * proxyConfig object for rebelCoreQuery → clientFactory.
 *
 * IMPORTANT: ANTHROPIC_CUSTOM_HEADERS carries provider-identity headers
 * (x-openrouter-turn, x-codex-turn) that clientFactory uses to decide
 * whether the proxy handles auth. If these headers are lost upstream
 * (e.g., by object-spread overwriting in queryOptionsBuilder), clientFactory
 * will require a direct Anthropic API key and throw for proxy-only users.
 * See: docs-private/postmortems/260417_openrouter_adhoc_auth_failure_postmortem.md
 *
 * Stage 2 (R4): The values it decodes are now sourced from `plan.headers` upstream
 * (queryOptionsBuilder applies the plan via applyAuthPlanToEnv → ANTHROPIC_CUSTOM_HEADERS).
 * The decoded headers are still consumed by clientFactory.ts:78-104 (proxy-handles-auth contract).
 */
export function extractProxyConfig(env?: Record<string, string>): {
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
} | null {
  if (!env?.ANTHROPIC_BASE_URL) return null;

  const result: { baseURL: string; defaultHeaders?: Record<string, string> } = {
    baseURL: env.ANTHROPIC_BASE_URL,
  };

  if (env.ANTHROPIC_CUSTOM_HEADERS) {
    const headers: Record<string, string> = {};
    for (const line of env.ANTHROPIC_CUSTOM_HEADERS.split(/\r?\n/)) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        headers[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim();
      }
    }
    if (Object.keys(headers).length > 0) {
      result.defaultHeaders = headers;
    }
  }

  return result;
}

export async function* queryWithRuntime(
  params: TurnParams,
  routerContext?: QueryRouterContext,
): AsyncGenerator<AgentMessage, void, undefined> {
  const proxyConfig = extractProxyConfig(params.env);
  const settings = getSettings();
  const defaultSurfaceCapability: 'desktop' | 'cloud' = (() => {
    try {
      return getPlatformConfig().surface === 'cloud' ? 'cloud' : 'desktop';
    } catch {
      return process.env.REBEL_SURFACE === 'cloud' ? 'cloud' : 'desktop';
    }
  })();

  log.info(
    { isProxied: !!proxyConfig },
    'Routing turn through Rebel Core',
  );

  yield* rebelCoreQuery(params, {
    settings,
    cwd: params.cwd,
    ...(routerContext?.homePath ? { homePath: routerContext.homePath } : {}),
    ...(routerContext?.userDataPath ? { userDataPath: routerContext.userDataPath } : {}),
    ...(routerContext?.rebelSystemRoot ? { rebelSystemRoot: routerContext.rebelSystemRoot } : {}),
    sessionId: routerContext?.sessionId,
    ...(routerContext?.origin ? { origin: routerContext.origin } : {}),
    turnId: routerContext?.turnId,
    superMcpUrl: routerContext?.superMcpUrl,
    onMcpError: routerContext?.onMcpError,
    captureRebelWindow: routerContext?.captureRebelWindow,
    navigateApp: routerContext?.navigateApp,
    proxyConfig: proxyConfig ?? undefined,
    getCacheAgeMs: routerContext?.getCacheAgeMs,
    onStreamActivity: routerContext?.onStreamActivity,
    onToolDispatch: routerContext?.onToolDispatch,
    onToolSettle: routerContext?.onToolSettle,
    onFileChanged: routerContext?.onFileChanged,
    getLatestSuperMcpUrl: routerContext?.getLatestSuperMcpUrl,
    executionClient: routerContext?.executionClient,
    planningClient: routerContext?.planningClient,
    executionModelOverride: routerContext?.executionModelOverride,
    planningModelOverride: routerContext?.planningModelOverride,
    perConversationModelOverride: routerContext?.perConversationModelOverride,
    codexMode: routerContext?.codexMode,
    connectivity: routerContext?.connectivity,
    surfaceCapability: routerContext?.surfaceCapability ?? defaultSurfaceCapability,
    wasExplicitCouncilIntent: routerContext?.wasExplicitCouncilIntent ?? false,
  });
}

export type { TurnParams } from './turnParams';
