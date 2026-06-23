/**
 * Plugin IPC handlers — thin barrel that delegates to domain modules.
 *
 * Domain modules:
 * - plugins/pluginMemoryHandlers.ts — list-topics, read-topic, search-sources, get-source-document, memory-search, get-entities, get-meetings, read-skill
 * - plugins/pluginWriteHandlers.ts — write-skill, send-message, start-conversation, create-automation, list-automations, inbox-add, inbox-list
 * - plugins/pluginFetchHandlers.ts — external-fetch, get-contexts, ai-summarize, ai-extract, ai-generate
 * - plugins/pluginLifecycleHandlers.ts — compile-and-register, persist-all, load-persisted, clear-persisted, storage-*, export, import, scan-spaces, space management
 * - plugins/shared.ts — shared utilities, constants, rate limiters, caches
 */

import { registerPluginMemoryHandlers } from './plugins/pluginMemoryHandlers';
import { registerPluginWriteHandlers } from './plugins/pluginWriteHandlers';
import { registerPluginFetchHandlers } from './plugins/pluginFetchHandlers';
import { registerPluginLifecycleHandlers } from './plugins/pluginLifecycleHandlers';

import type { AutomationScheduler } from '../services/automationScheduler';

export interface PluginHandlerDeps {
  getScheduler?: () => AutomationScheduler;
}

export function registerPluginHandlers(deps?: PluginHandlerDeps): void {
  registerPluginLifecycleHandlers();
  registerPluginMemoryHandlers();
  registerPluginWriteHandlers(deps);
  registerPluginFetchHandlers();
}

// Re-export test helpers for backward compatibility with existing tests
export {
  _resetPluginInboxAddRateLimiterForTesting,
  _resetPluginAutomationCreateRateLimiterForTesting,
  _resetPluginTranscriptReadRateLimiterForTesting,
  _clearTopicListCacheForTesting,
  invalidatePermissionCache as _invalidatePermissionCacheForTesting,
} from './plugins/shared';
