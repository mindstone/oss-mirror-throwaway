/**
 * Plugin API Factory
 *
 * Creates the `@rebel/plugin-api` module that gets injected into plugin scope.
 * Each plugin instance gets its own lifecycle manager for cleanup isolation.
 *
 * Hooks (useConversations, useRebel) are implemented as real React hooks
 * so plugins can use them in their component tree.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { toast as sonnerToast } from 'sonner';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import type { SettingsTabId } from '@shared/navigation/types';
import { isBackgroundConversationSession } from '@shared/sessionKind';
import { getSessionStoreState, subscribeToSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import { createLifecycleManager, type LifecycleCleanup } from './lifecycleManager';
import { usePluginId } from './PluginContext';
import type {
  ActiveSession,
  AutomationCreateDefinition,
  AutomationCreateResult,
  AutomationSummary,
  ConversationSummary,
  InboxAddItemInput,
  InboxItem as PluginInboxItem,
  InboxListParams,
  NavigationHelpers,
  Permission,
  PluginFetchResult,
  PluginWriteResult,
  RebelApi,
  SkillWriteOptions,
  SkillWriteResult,
  ShowToastOptions,
  TranscriptMessage,
  UseConversationsParams,
  UseEntitiesParams,
  UseEntitiesResult,
  UseExternalFetchOptions,
  UseExternalFetchResult,
  UseSkillFileResult,
  UseTopicContentResult,
  UseTopicsParams,
  UseTopicsResult,
} from './types';
import { mapSummaryToConversation } from './conversationMapper';
import { useActiveSession } from './useActiveSession';
import { useConversation } from './useConversation';
import { usePluginStorage } from './usePluginStorage';
import { usePluginStorageWithVersion } from './usePluginStorageWithVersion';
import { useMemorySearch } from './useMemorySearch';
import { useSources } from './useSources';
import { useSourceDocument } from './useSourceDocument';
import { useTopics as useTopicsHook } from './useTopics';
import { useEntities as useEntitiesHook } from './useEntities';
import { useTopicContent as useTopicContentHook } from './useTopicContent';
import { useSkillFile as useSkillFileHook } from './useSkillFile';
import { useAi } from './useAi';
import { useMeetings } from './useMeetings';
import { useGoals } from './useGoals';
import { useClipboard } from './useClipboard';
import { useRebelEvent } from './useRebelEvent';
import { usePreTurnHook } from './usePreTurnHook';
import { usePostTurnHook } from './usePostTurnHook';
import { useExternalFetch as useExternalFetchHook, pluginImperativeFetch } from './useExternalFetch';
import { usePluginRoute } from './usePluginRoute';
import { createId } from '@shared/utils/id';
import {
  checkPermission as checkPluginPermission,
  createPermissionGuard,
} from './pluginPermissions';

function getConversationSnapshots(): ConversationSummary[] {
  const state = getSessionStoreState();
  return state.sessionSummaries
    .filter(s => s.privateMode !== true)
    .map(mapSummaryToConversation);
}

let cachedSummaries: ConversationSummary[] = [];
let cachedSourceRef: unknown = null;

// ── Toast Rate Limiter ──────────────────────────────────────────────────
// Prevents plugin toast spam: max 3 toasts per 10 seconds per plugin.

const TOAST_RATE_LIMIT = 3;
const TOAST_RATE_WINDOW_MS = 10_000;
const toastTimestampsByPlugin = new Map<string, number[]>();
const SKILL_WRITE_RATE_LIMIT = 5;
const SKILL_WRITE_RATE_WINDOW_MS = 60_000;
const skillWriteTimestampsByPlugin = new Map<string, number[]>();

/** Check if a toast is allowed and record it if so. Exported for testing. */
export function _checkToastRateLimit(pluginId: string, now = Date.now()): boolean {
  const activeTimestamps = (toastTimestampsByPlugin.get(pluginId) ?? [])
    .filter(timestamp => now - timestamp < TOAST_RATE_WINDOW_MS);

  if (activeTimestamps.length >= TOAST_RATE_LIMIT) {
    toastTimestampsByPlugin.set(pluginId, activeTimestamps);
    return false;
  }

  activeTimestamps.push(now);
  toastTimestampsByPlugin.set(pluginId, activeTimestamps);
  return true;
}

/** Reset toast rate limiter state (for testing). */
export function _resetToastRateLimiter(pluginId?: string): void {
  if (pluginId) {
    toastTimestampsByPlugin.delete(pluginId);
    return;
  }

  toastTimestampsByPlugin.clear();
}

/** Show a toast via Sonner, respecting rate limits. */
export function _showPluginToast(pluginId: string, message: string, options?: ShowToastOptions): void {
  if (!_checkToastRateLimit(pluginId)) return;

  const variant = options?.variant ?? 'default';
  const duration = options?.duration ?? 5000;
  const toastOptions = { duration };

  switch (variant) {
    case 'success':
      sonnerToast.success(message, toastOptions);
      break;
    case 'error':
      sonnerToast.error(message, toastOptions);
      break;
    case 'warning':
      sonnerToast.warning(message, toastOptions);
      break;
    case 'info':
      sonnerToast.info(message, toastOptions);
      break;
    default:
      sonnerToast(message, toastOptions);
  }
}

export function _createUiApi(pluginId: string): RebelApi['ui'] {
  return {
    showToast: (message: string, options?: ShowToastOptions) => _showPluginToast(pluginId, message, options),
  };
}

/** Check if a skill write is allowed and record it if so. Exported for testing. */
export function _checkSkillWriteRateLimit(pluginId: string, now = Date.now()): boolean {
  const activeTimestamps = (skillWriteTimestampsByPlugin.get(pluginId) ?? [])
    .filter(timestamp => now - timestamp < SKILL_WRITE_RATE_WINDOW_MS);

  if (activeTimestamps.length >= SKILL_WRITE_RATE_LIMIT) {
    skillWriteTimestampsByPlugin.set(pluginId, activeTimestamps);
    return false;
  }

  activeTimestamps.push(now);
  skillWriteTimestampsByPlugin.set(pluginId, activeTimestamps);
  return true;
}

/** Reset skill write rate limiter state (for testing). */
export function _resetSkillWriteRateLimiter(pluginId?: string): void {
  if (pluginId) {
    skillWriteTimestampsByPlugin.delete(pluginId);
    return;
  }

  skillWriteTimestampsByPlugin.clear();
}

// ── Navigation Helpers ──────────────────────────────────────────────────

/** Exported as _createNavigationHelpers for testing. */
export function _createNavigationHelpers(navigateFn: (target: string) => void): NavigationHelpers {
  const navigate = ((target: string) => navigateFn(target)) as NavigationHelpers;
  navigate.toSettings = (tab?: string) => {
    // Plugins may pass non-canonical tab aliases (e.g. "connectors" -> "tools").
    // The URL parser resolves aliases via resolveSettingsTabId, so we pass the
    // raw string through. Cast is safe because formatNavigationUrl only encodes.
    navigateFn(tab
      ? formatNavigationUrl({ type: 'settings', tab: tab as SettingsTabId })
      : formatNavigationUrl({ type: 'settings' }));
  };
  navigate.toAutomations = () => navigateFn(formatNavigationUrl({ type: 'automations' }));
  navigate.toTasks = () => navigateFn(formatNavigationUrl({ type: 'tasks' }));
  navigate.toLibrary = (filePath?: string) => {
    navigateFn(filePath ? formatNavigationUrl({ type: 'library', filePath }) : formatNavigationUrl({ type: 'library' }));
  };
  navigate.toPlugin = (pluginId: string) => {
    navigateFn(formatNavigationUrl({ type: 'plugin', pluginId }));
  };
  return navigate;
}

interface ConversationMutationStore {
  togglePinSession(sessionId: string): void;
  toggleStarSession(sessionId: string): void;
  renameSession(sessionId: string, title: string): void;
}

export function checkPermission(pluginId: string, requiredPermission: Permission): boolean {
  return checkPluginPermission(pluginId, requiredPermission);
}

export function _createConversationApi(
  pluginId: string,
  openSessionFn: (sessionId: string) => void,
  getStoreState: () => ConversationMutationStore = getSessionStoreState,
  navigateFn: (target: string) => void = () => { /* no-op default */ },
): RebelApi['conversations'] {
  return {
    open: (sessionId: string) => openSessionFn(sessionId),
    list: () => {
      createPermissionGuard(pluginId, 'conversations:read');
      return getStableConversationSnapshots();
    },
    // Renamed from `pin` (v0.2, 2026-06): toggles the Active/Done lifecycle
    // (doneAt), not pin-to-top. See breaking-change note in rebel-plugin-api.d.ts.
    toggleDone: (sessionId: string) => {
      createPermissionGuard(pluginId, 'conversations:read');
      if (isBackgroundConversationSession(sessionId)) {
        console.warn(
          '[pluginApiFactory] conversations.toggleDone is not supported for background/automation conversations (kind-determined lifecycle); ignoring',
          { pluginId, sessionId },
        );
        return;
      }
      getStoreState().togglePinSession(sessionId);
    },
    star: (sessionId: string) => {
      createPermissionGuard(pluginId, 'conversations:read');
      getStoreState().toggleStarSession(sessionId);
    },
    rename: (sessionId: string, title: string) => {
      createPermissionGuard(pluginId, 'conversations:read');
      getStoreState().renameSession(sessionId, title);
    },
    sendMessage: async (sessionId: string, message: string): Promise<PluginWriteResult> => {
      createPermissionGuard(pluginId, 'conversations:write');
      if (!sessionId || typeof sessionId !== 'string') {
        return { ok: false, error: 'sessionId is required and must be a non-empty string.' };
      }
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return { ok: false, error: 'message is required and must be a non-empty string.' };
      }
      const result = await window.pluginsApi.sendMessage({ pluginId, sessionId, message: message.trim() });
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'Failed to send message.' };
      }
      return { ok: true } as PluginWriteResult;
    },
    startConversation: async (message: string): Promise<PluginWriteResult<{ sessionId: string }>> => {
      createPermissionGuard(pluginId, 'conversations:write');
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return { ok: false, error: 'message is required and must be a non-empty string.' };
      }
      const result = await window.pluginsApi.startConversation({ pluginId, message: message.trim() });
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'Failed to start conversation.' };
      }
      if (!result.sessionId) {
        return { ok: false, error: 'Failed to start conversation.' };
      }
      return { ok: true, sessionId: result.sessionId };
    },
    create: (options?: { draftText?: string; navigate?: boolean }): string => {
      const sessionId = createId();
      const state = getSessionStoreState();
      state.createBackgroundSession(sessionId, 'plugin');
      if (options?.draftText?.trim()) {
        state.setDraftForSession(sessionId, options.draftText.trim());
      }
      if (options?.navigate !== false) {
        navigateFn(formatNavigationUrl({ type: 'sessions', sessionId }));
      }
      return sessionId;
    },
    getTranscript: async (
      sessionId: string,
      options?: { limit?: number },
    ): Promise<PluginWriteResult<{ messages: TranscriptMessage[]; state?: 'ok' | 'not_found' | 'redacted' }>> => {
      createPermissionGuard(pluginId, 'conversations:transcript');
      if (!sessionId || typeof sessionId !== 'string') {
        return { ok: false, error: 'sessionId is required and must be a non-empty string.' };
      }
      if (typeof window === 'undefined' || !window.pluginsApi?.getTranscript) {
        return { ok: false, error: 'Transcript API not available.' };
      }
      try {
        const result = await window.pluginsApi.getTranscript({
          pluginId,
          sessionId,
          ...(options?.limit ? { limit: options.limit } : {}),
        });
        if (!result.ok) {
          return { ok: false, error: result.error ?? 'Failed to read transcript.' };
        }
        return { ok: true, messages: result.messages, state: result.state };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to read transcript.',
        };
      }
    },
  };
}

export function _createSkillsApi(pluginId: string): RebelApi['skills'] {
  return {
    write: async (options: SkillWriteOptions): Promise<SkillWriteResult> => {
      createPermissionGuard(pluginId, 'skills:write');

      if (!_checkSkillWriteRateLimit(pluginId)) {
        return {
          ok: false,
          error: `Rate limit exceeded for plugin "${pluginId}". Try again in 60s.`,
        };
      }

      if (!options || typeof options !== 'object') {
        return { ok: false, error: 'Skill write options are required.' };
      }

      if (typeof options.relativePath !== 'string' || options.relativePath.trim().length === 0) {
        return { ok: false, error: 'relativePath is required and must be a non-empty string.' };
      }

      if (typeof options.content !== 'string') {
        return { ok: false, error: 'content must be a string.' };
      }

      if (typeof window === 'undefined' || !window.pluginsApi?.writeSkill) {
        return { ok: false, error: 'Skill write API not available.' };
      }

      try {
        return await window.pluginsApi.writeSkill({
          pluginId,
          relativePath: options.relativePath.trim(),
          content: options.content,
          ...(options.baseContentHash ? { baseContentHash: options.baseContentHash } : {}),
        });
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to write skill file.',
        };
      }
    },
  };
}

export function _createInboxApi(pluginId: string): RebelApi['inbox'] {
  return {
    addItem: async (item: InboxAddItemInput): Promise<PluginWriteResult<{ itemId: string }>> => {
      if (!item || typeof item !== 'object') {
        return { ok: false, error: 'item is required and must be an object.' };
      }

      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (!title) {
        return { ok: false, error: 'item.title is required and must be a non-empty string.' };
      }

      if (item.priority && !['low', 'medium', 'high'].includes(item.priority)) {
        return { ok: false, error: 'item.priority must be one of: low, medium, high.' };
      }

      if (typeof window === 'undefined' || !window.pluginsApi?.inboxAdd) {
        return { ok: false, error: 'Inbox add API not available.' };
      }

      const description = typeof item.description === 'string' ? item.description.trim() : undefined;
      const actionPrompt = typeof item.actionPrompt === 'string' ? item.actionPrompt.trim() : undefined;

      try {
        const response = await window.pluginsApi.inboxAdd({
          pluginId,
          item: {
            title,
            ...(description ? { description } : {}),
            ...(item.priority ? { priority: item.priority } : {}),
            ...(actionPrompt ? { actionPrompt } : {}),
          },
        });

        if (!response.ok) {
          return { ok: false, error: response.error ?? 'Failed to add inbox item.' };
        }

        return { ok: true, itemId: response.itemId };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to add inbox item.',
        };
      }
    },

    getItems: async (params?: InboxListParams): Promise<PluginInboxItem[]> => {
      const limit = params?.limit;
      if (limit !== undefined) {
        if (!Number.isInteger(limit)) {
          throw new Error('limit must be an integer when provided.');
        }
        if (limit < 1) {
          throw new Error('limit must be greater than or equal to 1.');
        }
        if (limit > 50) {
          throw new Error('limit cannot be greater than 50.');
        }
      }

      if (typeof window === 'undefined' || !window.pluginsApi?.inboxList) {
        throw new Error('Inbox list API not available.');
      }

      const response = await window.pluginsApi.inboxList(limit !== undefined ? { limit } : {});
      return response.items;
    },
  };
}

export function _createAutomationsApi(pluginId: string): RebelApi['automations'] {
  return {
    create: async (definition: AutomationCreateDefinition): Promise<AutomationCreateResult> => {
      try {
        createPermissionGuard(pluginId, 'automations:create');

        if (!definition || typeof definition !== 'object') {
          return { automationId: '', ok: false, error: 'Automation definition is required.' };
        }

        const name = typeof definition.name === 'string' ? definition.name.trim() : '';
        if (!name) {
          return { automationId: '', ok: false, error: 'name is required and must be a non-empty string.' };
        }

        if (typeof definition.skillContent !== 'string' || definition.skillContent.trim().length === 0) {
          return { automationId: '', ok: false, error: 'skillContent is required and must be a non-empty string.' };
        }

        if (!definition.schedule || typeof definition.schedule !== 'object') {
          return { automationId: '', ok: false, error: 'schedule is required.' };
        }

        if (!['interval', 'cron'].includes(definition.schedule.type)) {
          return { automationId: '', ok: false, error: 'schedule.type must be "interval" or "cron".' };
        }

        if (typeof definition.schedule.value !== 'string' || definition.schedule.value.trim().length === 0) {
          return { automationId: '', ok: false, error: 'schedule.value is required and must be a non-empty string.' };
        }

        if (typeof window === 'undefined' || !window.pluginsApi?.createAutomation) {
          return { automationId: '', ok: false, error: 'Automation creation API not available.' };
        }

        const result = await window.pluginsApi.createAutomation({
          pluginId,
          name,
          description: typeof definition.description === 'string' ? definition.description.trim() : undefined,
          skillContent: definition.skillContent,
          schedule: definition.schedule,
          enabled: definition.enabled ?? false,
        });

        return {
          automationId: result.automationId,
          ok: result.ok,
          error: result.error,
        };
      } catch (error) {
        return {
          automationId: '',
          ok: false,
          error: error instanceof Error ? error.message : 'Failed to create automation.',
        };
      }
    },

    list: async (): Promise<AutomationSummary[]> => {
      if (typeof window === 'undefined' || !window.pluginsApi?.listAutomations) {
        return [];
      }

      try {
        const result = await window.pluginsApi.listAutomations({});
        return result.automations as AutomationSummary[];
      } catch (error) {
        console.error('[plugin-api] Failed to list automations:', error);
        return [];
      }
    },
  };
}

function getStableConversationSnapshots(): ConversationSummary[] {
  const state = getSessionStoreState();
  if (state.sessionSummaries !== cachedSourceRef) {
    cachedSourceRef = state.sessionSummaries;
    cachedSummaries = getConversationSnapshots();
  }
  return cachedSummaries;
}

export function createPluginApiModule(
  navigateFn: (target: string) => void,
  openSessionFn: (sessionId: string) => void,
) {
  return {
    usePluginRoute,
    usePluginStorage,
    usePluginStorageWithVersion,
    useMemorySearch,
    useSources,
    useSourceDocument,
    useTopics(params?: UseTopicsParams): UseTopicsResult {
      const pluginId = usePluginId();
      createPermissionGuard(pluginId, 'memory:read');
      return useTopicsHook(params);
    },
    useEntities(params?: UseEntitiesParams): UseEntitiesResult {
      const pluginId = usePluginId();
      createPermissionGuard(pluginId, 'entities:read');
      return useEntitiesHook(params);
    },
    useTopicContent(relativePath: string): UseTopicContentResult {
      const pluginId = usePluginId();
      createPermissionGuard(pluginId, 'memory:read');
      return useTopicContentHook(relativePath);
    },
    useSkillFile(relativePath: string): UseSkillFileResult {
      const pluginId = usePluginId();
      createPermissionGuard(pluginId, 'skills:read');
      return useSkillFileHook(relativePath);
    },
    useAi,
    useMeetings,
    useGoals,
    useClipboard,
    useRebelEvent,
    usePreTurnHook,
    usePostTurnHook,
    useExternalFetch<T = unknown>(url: string, options?: UseExternalFetchOptions): UseExternalFetchResult<T> {
      const pluginId = usePluginId();
      createPermissionGuard(pluginId, 'external-fetch');
      return useExternalFetchHook<T>(url, options);
    },

    useActiveSession(): ActiveSession | null {
      const pluginId = usePluginId();
      createPermissionGuard(pluginId, 'conversations:read');
      return useActiveSession();
    },

    useConversation(id: string): ConversationSummary | null {
      const pluginId = usePluginId();
      createPermissionGuard(pluginId, 'conversations:read');
      return useConversation(id);
    },

    useConversations(params?: UseConversationsParams): { data: ConversationSummary[]; totalCount: number; isLoading: boolean } {
      const pluginId = usePluginId();
      createPermissionGuard(pluginId, 'conversations:read');

      const allData = useSyncExternalStore(
        subscribeToSessionStore,
        getStableConversationSnapshots,
        () => [],
      );

      const query = params?.query;
      const sortBy = params?.sortBy;
      const limit = params?.limit;
      const offset = params?.offset;
      const includeDeleted = params?.includeDeleted;
      const origin = params?.origin;
      const isBusy = params?.isBusy;
      const dateRange = params?.dateRange;
      const dateField = params?.dateField;

      const filtered = useMemo(() => {
        let result = allData;

        // 1. Exclude deleted sessions unless explicitly requested
        if (!includeDeleted) {
          result = result.filter(c => c.deletedAt == null);
        }

        // 2. Filter by title substring (case-insensitive)
        if (query) {
          const lowerQuery = query.toLowerCase();
          result = result.filter(c => c.title?.toLowerCase().includes(lowerQuery));
        }

        // 3. Filter by origin
        if (origin != null) {
          const origins = Array.isArray(origin) ? origin : [origin];
          result = result.filter(c => origins.includes(c.origin));
        }

        // 4. Filter by busy state
        if (isBusy != null) {
          result = result.filter(c => c.isBusy === isBusy);
        }

        // 5. Filter by date range (against createdAt by default, or updatedAt)
        if (dateRange) {
          const field = dateField === 'updatedAt' ? 'updatedAt' : 'createdAt';
          const afterTs = dateRange.after;
          const beforeTs = dateRange.before;
          if (afterTs != null) {
            result = result.filter(c => c[field] >= afterTs);
          }
          if (beforeTs != null) {
            result = result.filter(c => c[field] <= beforeTs);
          }
        }

        // 6. Sort
        if (sortBy === 'createdAt') {
          result = [...result].sort((a, b) => b.createdAt - a.createdAt);
        } else if (sortBy === 'title') {
          result = [...result].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
        } else {
          // Default: updatedAt descending (most recent first)
          result = [...result].sort((a, b) => b.updatedAt - a.updatedAt);
        }

        return result;
      }, [allData, query, sortBy, includeDeleted, origin, isBusy, dateRange, dateField]);

      const totalCount = filtered.length;

      const paginated = useMemo(() => {
        const start = offset ?? 0;
        const end = limit != null ? start + limit : undefined;
        return filtered.slice(start, end);
      }, [filtered, limit, offset]);

      return { data: paginated, totalCount, isLoading: false };
    },

    useRebel(): RebelApi {
      const pluginId = usePluginId();
      const lifecycleRef = useRef<(ReturnType<typeof createLifecycleManager>) | null>(null);

      if (!lifecycleRef.current) {
        lifecycleRef.current = createLifecycleManager();
      }
      const lm = lifecycleRef.current;

      useEffect(() => {
        return () => (lm as LifecycleCleanup).cleanup();
      }, [lm]);

       
      const conversations = useMemo(() => _createConversationApi(pluginId, openSessionFn, getSessionStoreState, navigateFn), [pluginId]);
      const skills = useMemo(() => _createSkillsApi(pluginId), [pluginId]);
      const automations = useMemo(() => _createAutomationsApi(pluginId), [pluginId]);
      const inbox = useMemo(() => _createInboxApi(pluginId), [pluginId]);

      // eslint-disable-next-line react-hooks/exhaustive-deps -- navigateFn is an outer scope value (module-level); not a valid React dependency
      const navigate = useMemo(() => _createNavigationHelpers(navigateFn), [navigateFn]);

      const ui = useMemo(() => _createUiApi(pluginId), [pluginId]);

      const fetchFn = useCallback(
        async (url: string, options?: UseExternalFetchOptions): Promise<PluginFetchResult> => {
          createPermissionGuard(pluginId, 'external-fetch');
          return pluginImperativeFetch(pluginId, url, options);
        },
        [pluginId],
      );

      return useMemo<RebelApi>(() => ({
        conversations,
        skills,
        automations,
        inbox,
        navigate,
        ui,
        fetch: fetchFn,
        lifecycle: lm,
      }), [conversations, skills, automations, inbox, navigate, ui, fetchFn, lm]);
    },
  };
}
