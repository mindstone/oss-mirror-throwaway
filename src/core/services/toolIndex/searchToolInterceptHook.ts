// See docs/project/TOOL_AWARENESS.md — Intent & Design Rationale
import { createScopedLogger } from '@core/logger';
import { searchTools, isToolIndexUsable, getToolIndexStatus } from './toolIndexService';
import type { HookCallback } from '@core/agentRuntimeTypes';

const log = createScopedLogger({ service: 'searchToolIntercept' });

const SEARCH_TOOLS_NAME = 'mcp__super-mcp-router__search_tools';

// Super-MCP defaults (must match super-mcp/src/handlers/searchTools.ts)
const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 0.0;

export function createSearchToolInterceptHook(): HookCallback {
  return async (hookInput, _toolUseId, _options) => {
    if (hookInput.hook_event_name !== 'PreToolUse') {
      return {};
    }

    if (hookInput.tool_name !== SEARCH_TOOLS_NAME) {
      return {};
    }

    if (!isToolIndexUsable()) {
      log.debug('Tool index not ready, falling through to BM25');
      return {};
    }

    try {
      const input = hookInput.tool_input as Record<string, unknown> | undefined;
      const query = typeof input?.query === 'string' ? input.query : '';
      const limit = typeof input?.limit === 'number' ? input.limit : DEFAULT_LIMIT;
      const threshold = typeof input?.threshold === 'number' ? input.threshold : DEFAULT_THRESHOLD;
      const packages = Array.isArray(input?.packages) ? input.packages as string[] : undefined;

      if (!query) {
        return {};
      }

      const searchGeneration = getToolIndexStatus()?.freshnessGeneration ?? 0;
      const fetchLimit = packages ? limit * 3 : limit;
      const results = await searchTools(query, fetchLimit, threshold);
      const postSearchStatus = getToolIndexStatus();
      const postSearchGeneration = postSearchStatus?.freshnessGeneration ?? 0;
      if (!isToolIndexUsable() || postSearchGeneration !== searchGeneration) {
        log.debug(
          { searchGeneration, postSearchGeneration },
          'Tool index freshness changed during search_tools intercept, falling through to BM25',
        );
        return {};
      }

      let filtered = results;
      if (packages && packages.length > 0) {
        filtered = results.filter(r => packages.includes(r.serverId));
      }
      const trimmed = filtered.slice(0, limit);

      const output = {
        results: trimmed.map(r => ({
          tool_id: r.toolId,
          package_id: r.serverId,
          name: r.name,
          summary: r.summary || r.description,
          description: r.description,
          relevance_score: Math.round(r.score * 100) / 100,
        })),
        query,
        total_tools_searched: postSearchStatus?.toolCount ?? results.length,
      };

      log.info({ query, resultCount: trimmed.length, source: 'hybrid' }, 'Intercepted search_tools');

      const replaceResponse = {
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          replaceResult: {
            output: JSON.stringify(output),
            isError: false,
          },
        },
      };
      return replaceResponse;
    } catch (err) {
      log.warn({ err }, 'Hybrid search intercept failed, falling through to BM25');
      return {};
    }
  };
}
