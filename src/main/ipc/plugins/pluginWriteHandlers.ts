/**
 * Plugin write-operation IPC handlers.
 *
 * Covers: write-skill, send-message, start-conversation, create-automation,
 * list-automations, inbox-add, inbox-list, get-transcript
 */

import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { registerHandler } from '../utils/registerHandler';
import { pluginsChannels } from '@shared/ipc/channels/plugins';
import { getSettings } from '@core/services/settingsStore';
import { checkMessageRateLimit, recordMessageCall } from '@core/services/pluginMessageRateLimiter';
import { createScopedLogger } from '@core/logger';
import { sharedSkillMutationService } from '../../services/sharedSkillMutationService';
import { getCurrentUserProvider } from '@core/currentUserProvider';
import { addInboxItem, getInboxState } from '../../services/inboxStore';
import type { AutomationScheduler } from '../../services/automationScheduler';
import {
  hasPluginPermission,
  resolveSkillWriteTarget,
  resolveConfiguredPluginSpacePaths,
  checkInboxAddRateLimit,
  recordInboxAddCall,
  checkAutomationCreateRateLimit,
  recordAutomationCreateCall,
  checkTranscriptReadRateLimit,
  recordTranscriptReadCall,
  trimOptional,
  buildInboxText,
  mapPluginPriorityToInbox,
  mapInboxItemForPlugin,
  pluginScheduleToAutomationSchedule,
  formatScheduleForPlugin,
} from './shared';

const log = createScopedLogger({ service: 'pluginWriteHandlers' });

export interface PluginWriteHandlerDeps {
  getScheduler?: () => AutomationScheduler;
}

const buildConversationWritePermissionError = (pluginId: string): string =>
  `Plugin "${pluginId}" is not authorized for "conversations:write". ` +
  'To allow this, update the plugin manifest to include "conversations:write", ' +
  'then re-enable or re-import the plugin in Settings > Plugins. ' +
  'Legacy plugins without a permissions field are read-only until updated.';

export function registerPluginWriteHandlers(deps?: PluginWriteHandlerDeps): void {
  // ── Skill Write ───────────────────────────────────────────────────────

  const writeSkillChannel = pluginsChannels['plugins:write-skill'];
  registerHandler(writeSkillChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = writeSkillChannel.request.parse(request);
    const workspacePath = getSettings().coreDirectory;

    if (!workspacePath) {
      return { ok: false, error: 'Core directory is not configured.' };
    }

    const hasSkillsWritePermission = await hasPluginPermission(validated.pluginId, 'skills:write');
    if (!hasSkillsWritePermission) {
      log.warn(
        { pluginId: validated.pluginId },
        'Plugin attempted to write a skill without skills:write permission',
      );
      return {
        ok: false,
        error: `Plugin "${validated.pluginId}" is not authorized for "skills:write".`,
      };
    }

    const resolvedTarget = await resolveSkillWriteTarget(workspacePath, validated.relativePath);
    if (!resolvedTarget) {
      log.warn(
        { pluginId: validated.pluginId, relativePath: validated.relativePath },
        'Plugin attempted to write skill outside allowed skills paths',
      );
      return { ok: false, error: 'Invalid skill path. Writes are restricted to configured skills directories.' };
    }

    try {
      const writeContext = {
        ...(validated.baseContentHash ? { baseContentHash: validated.baseContentHash } : {}),
        pluginId: validated.pluginId,
      } as Parameters<typeof sharedSkillMutationService.writeManagedSkillFile>[4];

      const writeResult = await sharedSkillMutationService.writeManagedSkillFile(
        resolvedTarget.absolutePath,
        validated.content,
        workspacePath,
        {
          kind: 'agent',
          user: getCurrentUserProvider().getCurrentUser(),
        },
        writeContext,
      );

      if (!writeResult) {
        return {
          ok: false,
          error: 'Skill writes are only allowed for shared skill files in configured spaces.',
        };
      }

      if (writeResult.conflict) {
        return {
          ok: false,
          conflict: true,
          currentHash: writeResult.currentHash,
        };
      }

      return {
        ok: true,
        currentHash: writeResult.currentHash,
      };
    } catch (error) {
      log.error(
        { err: error, pluginId: validated.pluginId, relativePath: resolvedTarget.normalizedRelativePath },
        'Plugin skill write failed',
      );
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to write skill file.',
      };
    }
  });

  // ── Plugin Conversation Actions (send message / start conversation) ───

  const sendMessageChannel = pluginsChannels['plugins:send-message'];
  registerHandler(sendMessageChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = sendMessageChannel.request.parse(request);
    const { pluginId, sessionId, message } = validated;

    // Permission check: plugin must have conversations:write permission
    const hasWritePermission = await hasPluginPermission(pluginId, 'conversations:write');
    if (!hasWritePermission) {
      log.warn({ pluginId }, 'Plugin attempted to send message without conversations:write permission');
      return { ok: false, error: buildConversationWritePermissionError(pluginId) };
    }

    // Rate limit: 5 messages/min per plugin (shared budget for send + start)
    const rateCheck = checkMessageRateLimit(pluginId);
    if (!rateCheck.allowed) {
      return {
        ok: false,
        error: `Rate limit exceeded for plugin "${pluginId}". Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`,
      };
    }

    // Validate session exists
    try {
      const { getIncrementalSessionStore } = await import('../../services/incrementalSessionStore');
      const store = getIncrementalSessionStore();
      const session = await store.getSession(sessionId);

      if (!session || session.deletedAt || session.privateMode) {
        return { ok: false, error: 'Session not found.' };
      }
    } catch (error) {
      log.error({ err: error, pluginId, sessionId }, 'Plugin send-message session lookup failed');
      return { ok: false, error: 'Failed to validate session.' };
    }

    // Record the call before dispatching
    recordMessageCall(pluginId);

    // Broadcast to renderer — follows the same pattern as bundledInboxBridge
    const { getBroadcastService } = await import('@core/broadcastService');
    getBroadcastService().sendToAllWindows('conversations:send-requested', {
      sessionId,
      text: message.trim(),
      sendMessage: true,
      switchToConversation: false,
      pluginAttribution: pluginId,
    });

    log.info({ pluginId, sessionId }, 'Plugin sent message to existing conversation');
    return { ok: true };
  });

  const startConversationChannel = pluginsChannels['plugins:start-conversation'];
  registerHandler(startConversationChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = startConversationChannel.request.parse(request);
    const { pluginId, message } = validated;

    // Permission check: plugin must have conversations:write permission
    const hasWritePermission = await hasPluginPermission(pluginId, 'conversations:write');
    if (!hasWritePermission) {
      log.warn({ pluginId }, 'Plugin attempted to start conversation without conversations:write permission');
      return { ok: false, error: buildConversationWritePermissionError(pluginId) };
    }

    // Rate limit: shared budget with sendMessage
    const rateCheck = checkMessageRateLimit(pluginId);
    if (!rateCheck.allowed) {
      return {
        ok: false,
        error: `Rate limit exceeded for plugin "${pluginId}". Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`,
      };
    }

    // Record the call before dispatching
    recordMessageCall(pluginId);

    const { randomUUID } = await import('node:crypto');
    const sessionId = randomUUID();

    // Broadcast to renderer — follows the same pattern as bundledInboxBridge
    const { getBroadcastService } = await import('@core/broadcastService');
    getBroadcastService().sendToAllWindows('conversations:start-requested', {
      sessionId,
      text: message.trim(),
      sendMessage: true,
      switchToConversation: false,
      pluginAttribution: pluginId,
    });

    log.info({ pluginId, sessionId }, 'Plugin started new conversation');
    return { ok: true, sessionId };
  });

  // ── Plugin Inbox Actions (add/list inbox items) ──────────────────────

  const inboxAddChannel = pluginsChannels['plugins:inbox-add'];
  registerHandler(inboxAddChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = inboxAddChannel.request.parse(request);
    const { pluginId } = validated;

    const rateCheck = checkInboxAddRateLimit(pluginId);
    if (!rateCheck.allowed) {
      return {
        ok: false as const,
        error: `Rate limit exceeded for plugin "${pluginId}". Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`,
      };
    }

    // Record before dispatching to prevent concurrent bypass.
    recordInboxAddCall(pluginId);

    const description = trimOptional(validated.item.description);
    const actionPrompt = trimOptional(validated.item.actionPrompt);
    const text = buildInboxText(description, actionPrompt);

    const addResult = addInboxItem({
      title: validated.item.title,
      ...(text ? { text } : {}),
      ...(actionPrompt ? { draft: actionPrompt } : {}),
      ...mapPluginPriorityToInbox(validated.item.priority),
      category: 'system',
      source: {
        kind: 'automation',
        automationId: `plugin:${pluginId}`,
        automationName: pluginId,
        label: `Plugin: ${pluginId}`,
      },
    });

    if (!addResult.accepted || !addResult.itemId) {
      const rejectionReason = addResult.rejectedReason
        ?? (addResult.redirected
          ? 'Inbox item was redirected to Coach and not added to Inbox.'
          : 'Inbox item was rejected and not added.');
      return { ok: false as const, error: rejectionReason };
    }

    return { ok: true as const, itemId: addResult.itemId };
  });

  const inboxListChannel = pluginsChannels['plugins:inbox-list'];
  registerHandler(inboxListChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = inboxListChannel.request.parse(request);
    const state = getInboxState();

    const items = state.items
      .filter((item) => !item.archived)
      .sort((a, b) => b.addedAt - a.addedAt)
      .slice(0, validated.limit)
      .map(mapInboxItemForPlugin);

    return { items };
  });

  // ── Plugin Automation Actions (create/list automations) ───────────────

  const createAutomationChannel = pluginsChannels['plugins:create-automation'];
  registerHandler(createAutomationChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = createAutomationChannel.request.parse(request);
    const { pluginId, name, description, skillContent, schedule, enabled } = validated;

    // Permission check
    const hasAutomationsPermission = await hasPluginPermission(pluginId, 'automations:create');
    if (!hasAutomationsPermission) {
      log.warn({ pluginId }, 'Plugin attempted to create automation without automations:create permission');
      return { automationId: '', ok: false, error: `Plugin "${pluginId}" is not authorized for "automations:create".` };
    }

    // Rate limit: 3 automations/hour per plugin
    const rateCheck = checkAutomationCreateRateLimit(pluginId);
    if (!rateCheck.allowed) {
      return {
        automationId: '',
        ok: false,
        error: `Rate limit exceeded for plugin "${pluginId}". Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`,
      };
    }

    // Verify scheduler is available
    const scheduler = deps?.getScheduler?.();
    if (!scheduler) {
      log.error({ pluginId }, 'Automation scheduler not available for plugin create-automation');
      return { automationId: '', ok: false, error: 'Automation scheduler is not available.' };
    }

    // Convert plugin schedule to automation schedule
    const automationSchedule = pluginScheduleToAutomationSchedule(schedule);
    if (!automationSchedule) {
      return { automationId: '', ok: false, error: `Invalid schedule: "${schedule.type}:${schedule.value}". Interval must be like "30m", "1h", "1d".` };
    }

    // Write skill content to a temporary skill file within the workspace
    const workspacePath = getSettings().coreDirectory;
    if (!workspacePath) {
      return { automationId: '', ok: false, error: 'Core directory is not configured.' };
    }

    const { randomUUID } = await import('node:crypto');
    const automationId = randomUUID();
    const sanitizedName = name.replace(/[^a-zA-Z0-9-_\s]/g, '').replace(/\s+/g, '-').toLowerCase().slice(0, 50);
    const skillFileName = `plugin-${pluginId}-${sanitizedName || automationId.slice(0, 8)}.md`;

    // Write the skill file into the first configured space's skills directory
    const configuredSpaces = await resolveConfiguredPluginSpacePaths(workspacePath);
    const targetSpace = configuredSpaces[0] ?? 'Chief-of-Staff';
    const skillRelativePath = path.posix.join(targetSpace, 'skills', 'plugin-automations', skillFileName);
    const skillAbsolutePath = path.join(workspacePath, skillRelativePath);

    try {
      await fs.mkdir(path.dirname(skillAbsolutePath), { recursive: true });
      await fs.writeFile(skillAbsolutePath, skillContent, 'utf-8');
    } catch (error) {
      log.error({ err: error, pluginId, skillRelativePath }, 'Failed to write automation skill file');
      return { automationId: '', ok: false, error: 'Failed to write automation skill file.' };
    }

    // Record the rate limit call BEFORE upsert to prevent concurrent bypass
    recordAutomationCreateCall(pluginId);

    try {
      const definition = scheduler.upsertDefinition({
        id: automationId,
        name: name.trim(),
        description: description?.trim() || `Created by plugin: ${pluginId}`,
        filePath: skillRelativePath,
        schedule: automationSchedule,
        enabled: enabled ?? false, // Default to disabled — user must enable
      });

      log.info({ pluginId, automationId: definition.id, name: definition.name }, 'Plugin created automation');
      return { automationId: definition.id, ok: true };
    } catch (error) {
      log.error({ err: error, pluginId }, 'Plugin create-automation upsert failed');
      return { automationId: '', ok: false, error: error instanceof Error ? error.message : 'Failed to create automation.' };
    }
  });

  const listAutomationsChannel = pluginsChannels['plugins:list-automations'];
  registerHandler(listAutomationsChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = listAutomationsChannel.request.parse(request);

    const scheduler = deps?.getScheduler?.();
    if (!scheduler) {
      return { automations: [] };
    }

    const state = scheduler.getState();
    let definitions = state.definitions;

    // Optionally filter to plugin-created automations
    if (validated.pluginId) {
      definitions = definitions.filter((def) =>
        def.description?.includes(`Created by plugin: ${validated.pluginId}`),
      );
    }

    const automations = definitions.map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      schedule: formatScheduleForPlugin(def.schedule),
      enabled: def.enabled,
      lastRunAt: def.lastRunAt ?? null,
      lastRunStatus: def.lastRunStatus,
      nextRunAt: def.nextRunAt ?? null,
      pluginId: def.description?.match(/Created by plugin: (.+)/)?.[1],
    }));

    return { automations };
  });

  // ── Plugin Conversation Transcript ────────────────────────────────────

  const getTranscriptChannel = pluginsChannels['plugins:get-transcript'];
  registerHandler(getTranscriptChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = getTranscriptChannel.request.parse(request);
    const { pluginId, sessionId, limit } = validated;

    // Permission check: conversations:transcript
    const hasTranscriptPermission = await hasPluginPermission(pluginId, 'conversations:transcript');
    if (!hasTranscriptPermission) {
      log.warn({ pluginId }, 'Plugin attempted to read transcript without conversations:transcript permission');
      return { ok: false as const, error: `Plugin "${pluginId}" is not authorized for "conversations:transcript".` };
    }

    // Rate limit: 10 calls/60s per plugin
    const rateCheck = checkTranscriptReadRateLimit(pluginId);
    if (!rateCheck.allowed) {
      return {
        ok: false as const,
        error: `Rate limit exceeded for plugin "${pluginId}". Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`,
      };
    }

    recordTranscriptReadCall(pluginId);

    try {
      const { getIncrementalSessionStore } = await import('../../services/incrementalSessionStore');
      const store = getIncrementalSessionStore();
      const session = await store.getSession(sessionId);

      // Disambiguate transcript state: not_found vs redacted vs ok
      if (!session) {
        return { ok: true as const, state: 'not_found' as const, messages: [] };
      }
      if (session.deletedAt || session.privateMode) {
        return { ok: true as const, state: 'redacted' as const, messages: [] };
      }

      // Filter to visible user/assistant messages only
      const visibleMessages = session.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => !m.isHidden && !m.isApprovalReceipt && !m.isWarning);

      // Apply limit (take last N messages)
      const limitedMessages = limit < visibleMessages.length
        ? visibleMessages.slice(-limit)
        : visibleMessages;

      const transcriptMessages = limitedMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        text: m.text,
        timestamp: new Date(m.createdAt).toISOString(),
        toolsUsed: m.role === 'assistant'
          ? extractToolNames(session.eventsByTurn, m.turnId)
          : undefined,
      }));

      log.info({ pluginId, sessionId, messageCount: transcriptMessages.length }, 'Plugin read conversation transcript');
      return { ok: true as const, state: 'ok' as const, messages: transcriptMessages };
    } catch (error) {
      log.error({ err: error, pluginId, sessionId }, 'Plugin get-transcript failed');
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'Failed to read transcript.',
      };
    }
  });
}

/**
 * Extract unique tool names from events for a given turn.
 * Only considers tool events at the 'start' stage.
 */
function extractToolNames(
  eventsByTurn: Record<string, import('@shared/types').AgentEvent[]>,
  turnId: string,
): string[] {
  const events = eventsByTurn[turnId];
  if (!events || events.length === 0) return [];

  const toolNames = new Set<string>();
  for (const event of events) {
    if (event.type === 'tool' && event.stage === 'start' && event.toolName) {
      toolNames.add(event.toolName);
    }
  }
  return Array.from(toolNames);
}
