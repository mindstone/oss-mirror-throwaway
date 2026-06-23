/**
 * Safety Prompt IPC handlers.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { DEFAULT_SAFETY_PROMPT, getSafetyPrompt, getSafetyPromptVersion, getSafetyPromptWithMeta, revertToVersion, updateSafetyPrompt } from '@core/safetyPromptStore';
import { clearCache, consolidateSafetyPrompt, generatePrincipleOptions, applySelectedPrinciple, generateDenyPrincipleOptions, applySelectedDenyPrinciple } from '@core/safetyPromptLogic';
import type { BlockedActionContext, PrincipleOptionScope, SafetyPromptUpdater } from '@core/safetyPromptTypes';
import { addVersionChangeEntry } from '@core/safetyActivityLogStore';
import { getBroadcastService } from '@core/broadcastService';
import { createScopedLogger } from '@core/logger';
import { reEvaluatePendingApprovals } from '../services/safety/approvalReEvalService';
import { registerHandler } from './utils/registerHandler';
import { SLACK_OUTBOUND_TOOL_IDS } from '@core/services/safety/outboundBroadcastGates/slackGates';
const log = createScopedLogger({ service: 'safetyPromptHandlers' });

// Slack tools that take a `channel` arg — sourced from the Slack gate so the
// channel-name enrichment below stays in sync with the outbound-broadcast
// safety hook's view of which Slack tools post to a channel.
const SLACK_CHANNEL_TOOLS = new Set<string>(SLACK_OUTBOUND_TOOL_IDS);

interface SafetyPromptUpdateArgs {
  prompt: string;
  updatedBy?: SafetyPromptUpdater;
}

interface SafetyPromptRevertArgs {
  targetVersion: number;
}

/**
 * Best-effort enrichment: if the blocked action involves a Slack tool with
 * a channel ID, try to inject a human-readable _channelDisplayName.
 * Uses lazy import to avoid pulling Electron-specific adapter into cloud builds.
 */
async function enrichWithChannelName(args: BlockedActionContext): Promise<BlockedActionContext> {
  let channelId: string | undefined;
  const toolInput = args.toolInput as Record<string, unknown> | undefined;
  if (!toolInput) return args;

  // Direct Slack tool
  if (SLACK_CHANNEL_TOOLS.has(args.toolName)) {
    channelId = typeof toolInput.channel === 'string' ? toolInput.channel : undefined;
  }

  // Router-wrapped Slack tool (mcp__super-mcp-router__use_tool)
  if (!channelId && args.toolName === 'mcp__super-mcp-router__use_tool') {
    const toolId = toolInput.tool_id as string | undefined;
    if (toolId && SLACK_CHANNEL_TOOLS.has(toolId)) {
      const innerArgs = toolInput.args as Record<string, unknown> | undefined;
      channelId = typeof innerArgs?.channel === 'string' ? (innerArgs.channel as string) : undefined;
    }
  }

  if (!channelId) return args;

  // Lazy import to avoid breaking cloud-service (no inbound triggers there)
  let channelName: string | undefined;
  try {
    const { getSlackChannelNameFromCache } = await import('../services/inboundTriggers/slackMentionAdapter');
    channelName = getSlackChannelNameFromCache(channelId);
  } catch (err) {
    // Expected in cloud-service where slackMentionAdapter doesn't exist
    log.debug({ err }, 'Channel name enrichment unavailable (expected in cloud)');
  }

  if (!channelName) return args;

  // Return enriched copy (don't mutate original)
  const enrichedToolInput = { ...toolInput, _channelDisplayName: `#${channelName}` };
  return { ...args, toolInput: enrichedToolInput };
}

/**
 * Broadcast a `safety-prompt:updated` push event to all connected surfaces
 * (desktop renderer, cloud-routed mobile) so stale in-memory copies / hooks
 * invalidate. Called from every successful safety-prompt mutation path.
 *
 * @see D10 / F24 in docs/plans/260416_centralize_approval_and_diff_viewing_ux.md
 * @see F-R2-1 (round-2 remediation): revert/reset/consolidation were missing this.
 * @see F-R3-4: exported so bundledInboxBridge can call after direct updateSafetyPrompt().
 */
export function broadcastSafetyPromptUpdated(): void {
  const meta = getSafetyPromptWithMeta();
  getBroadcastService().sendToAllWindows('safety-prompt:updated', {
    version: meta.version,
    lastUpdatedAt: meta.lastUpdatedAt,
    lastUpdatedBy: meta.lastUpdatedBy,
  });
}

export function registerSafetyPromptHandlers(): void {
  log.info('Registering safety prompt handlers');

  registerHandler('safety-prompt:get', async (_event: HandlerInvokeEvent) => {
    return getSafetyPromptWithMeta();
  });

  registerHandler(
    'safety-prompt:update',
    async (_event: HandlerInvokeEvent, args: SafetyPromptUpdateArgs) => {
      const oldVersion = getSafetyPromptVersion();
      updateSafetyPrompt(args.prompt, args.updatedBy ?? 'user');
      clearCache();
      void reEvaluatePendingApprovals(getSafetyPrompt(), getSafetyPromptVersion())
        .catch((err) => log.warn({ err }, 'Auto re-eval failed (non-critical)'));

      // Activity log: record the version change
      const newVersion = getSafetyPromptVersion();
      addVersionChangeEntry(oldVersion, newVersion);
      getBroadcastService().sendToAllWindows('safety-activity-log:updated', { timestamp: Date.now() });

      // Cross-surface invalidation (D10 / F24 / F-R2-1).
      broadcastSafetyPromptUpdated();

      // Fire async consolidation (non-blocking, with version guard to prevent race conditions)
      const updatedPrompt = getSafetyPrompt();
      const versionAtFireTime = getSafetyPromptVersion();
      consolidateSafetyPrompt(updatedPrompt)
        .then((consolidated) => {
          if (consolidated && consolidated !== updatedPrompt) {
            // Only apply if no other updates happened during consolidation
            if (getSafetyPromptVersion() !== versionAtFireTime) {
              log.debug('Skipping consolidation — prompt was modified during consolidation');
              return;
            }
            updateSafetyPrompt(consolidated, 'system');
            clearCache();
            log.info('Safety Prompt consolidated successfully');
            // Broadcast after consolidation write (F-R2-1).
            broadcastSafetyPromptUpdated();
            void reEvaluatePendingApprovals(getSafetyPrompt(), getSafetyPromptVersion())
              .catch((err) => log.warn({ err }, 'Auto re-eval after consolidation failed (non-critical)'));
          }
        })
        .catch((err) => {
          log.debug({ err }, 'Safety Prompt consolidation failed (non-critical)');
        });

      return getSafetyPromptWithMeta();
    },
  );

  registerHandler(
    'safety-prompt:revert',
    async (_event: HandlerInvokeEvent, args: SafetyPromptRevertArgs) => {
      const oldVersion = getSafetyPromptVersion();
      const reverted = revertToVersion(args.targetVersion);
      if (!reverted) {
        throw new Error(`Version ${args.targetVersion} not found in history`);
      }

      clearCache();
      void reEvaluatePendingApprovals(getSafetyPrompt(), getSafetyPromptVersion())
        .catch((err) => log.warn({ err }, 'Auto re-eval failed (non-critical)'));

      // Activity log: record the version change
      const newVersion = getSafetyPromptVersion();
      addVersionChangeEntry(oldVersion, newVersion);
      getBroadcastService().sendToAllWindows('safety-activity-log:updated', { timestamp: Date.now() });

      // Cross-surface invalidation (F-R2-1).
      broadcastSafetyPromptUpdated();

      return getSafetyPromptWithMeta();
    },
  );

  registerHandler('safety-prompt:reset', async (_event: HandlerInvokeEvent) => {
    const oldVersion = getSafetyPromptVersion();
    updateSafetyPrompt(DEFAULT_SAFETY_PROMPT, 'user');
    clearCache();
    void reEvaluatePendingApprovals(getSafetyPrompt(), getSafetyPromptVersion())
      .catch((err) => log.warn({ err }, 'Auto re-eval failed (non-critical)'));

    // Activity log: record the version change
    const newVersion = getSafetyPromptVersion();
    addVersionChangeEntry(oldVersion, newVersion);
    getBroadcastService().sendToAllWindows('safety-activity-log:updated', { timestamp: Date.now() });

    // Cross-surface invalidation (F-R2-1).
    broadcastSafetyPromptUpdated();

    return getSafetyPromptWithMeta();
  });

  registerHandler(
    'safety-prompt:generate-options',
    async (_event: HandlerInvokeEvent, args: BlockedActionContext) => {
      const currentPrompt = getSafetyPrompt();
      const enrichedArgs = await enrichWithChannelName(args);

      try {
        const result = await generatePrincipleOptions(currentPrompt, enrichedArgs);
        return result;
      } catch (error) {
        log.error({ err: error }, 'Failed to generate principle options');
        return { options: [], error: 'Failed to generate principle options' };
      }
    },
  );

  registerHandler(
    'safety-prompt:apply-selection',
    async (
      _event: HandlerInvokeEvent,
      args: { blockedAction: BlockedActionContext; selectedLabel: string; scope: PrincipleOptionScope },
    ) => {
      const currentPrompt = getSafetyPrompt();
      const enrichedBlockedAction = await enrichWithChannelName(args.blockedAction);

      try {
        const result = await applySelectedPrinciple(currentPrompt, enrichedBlockedAction, args.selectedLabel, args.scope);
        return result;
      } catch (error) {
        log.error({ err: error }, 'Failed to apply selected principle');
        return { update: null, error: 'Failed to apply selected principle' };
      }
    },
  );

  registerHandler(
    'safety-prompt:generate-deny-options',
    async (_event: HandlerInvokeEvent, args: BlockedActionContext) => {
      const currentPrompt = getSafetyPrompt();
      const enrichedArgs = await enrichWithChannelName(args);

      try {
        const result = await generateDenyPrincipleOptions(currentPrompt, enrichedArgs);
        return result;
      } catch (error) {
        log.error({ err: error }, 'Failed to generate deny principle options');
        return { options: [], error: 'Failed to generate deny principle options' };
      }
    },
  );

  registerHandler(
    'safety-prompt:apply-deny-selection',
    async (
      _event: HandlerInvokeEvent,
      args: { blockedAction: BlockedActionContext; selectedLabel: string; scope: PrincipleOptionScope },
    ) => {
      const currentPrompt = getSafetyPrompt();
      const enrichedBlockedAction = await enrichWithChannelName(args.blockedAction);

      try {
        const result = await applySelectedDenyPrinciple(currentPrompt, enrichedBlockedAction, args.selectedLabel, args.scope);
        return result;
      } catch (error) {
        log.error({ err: error }, 'Failed to apply selected deny principle');
        return { update: null, error: 'Failed to apply selected deny principle' };
      }
    },
  );
}
