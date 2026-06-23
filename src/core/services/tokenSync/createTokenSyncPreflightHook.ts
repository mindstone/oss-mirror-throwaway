import type { HookCallback, HookJSONOutput } from '@core/agentRuntimeTypes';
import type { OAuthToolResolver } from '@core/setOAuthToolResolver';
import {
  NULL_TOKEN_SYNC_COORDINATOR,
  type TokenSyncCoordinator,
} from '@core/setTokenSyncCoordinator';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const DEFAULT_DEADLINE_BUDGET_MS = 3_000;

export function createTokenSyncPreflightHook(args: {
  coordinator: TokenSyncCoordinator;
  resolver: OAuthToolResolver;
  clock?: () => number;
  deadlineMs?: number;
}): HookCallback {
  const clock = args.clock ?? Date.now;
  const deadlineBudgetMs = args.deadlineMs ?? DEFAULT_DEADLINE_BUDGET_MS;

  const hook: HookCallback = async (input, _toolUseID, options): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (options.signal.aborted) return {};
    if (args.coordinator === NULL_TOKEN_SYNC_COORDINATOR) return {};
    if (!input.tool_name || typeof input.tool_name !== 'string') return {};

    const classified = args.resolver.resolve(input.tool_name);
    if (!classified) return {};

    try {
      // best-effort freshness; ok:false is non-fatal here.
      void (await args.coordinator.ensureFreshish({
        provider: classified.provider,
        accountKey: classified.accountKey,
        deadlineMs: clock() + Math.max(0, deadlineBudgetMs),
      }));
    } catch (error) {
      ignoreBestEffortCleanup(error, {
        operation: 'token_sync_preflight_best_effort',
        reason: 'pre-tool token sync failures should not block tool execution',
      });
      // Best-effort sync only. Tool call proceeds regardless.
    }

    return {};
  };

  return hook;
}
