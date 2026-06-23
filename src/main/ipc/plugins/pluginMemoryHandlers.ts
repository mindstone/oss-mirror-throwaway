/**
 * Plugin memory/data-read IPC handlers.
 *
 * Covers: list-topics, read-topic, search-sources, get-source-document,
 * memory-search, get-entities, get-meetings, read-skill
 */

import type { IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import fm from 'front-matter';
import { registerHandler } from '../utils/registerHandler';
import { pluginsChannels } from '@shared/ipc/channels/plugins';
import { getSettings } from '@core/services/settingsStore';
import { semanticSearchWithStatus, isFileIndexReady, getScanCompletedAt } from '../../services/fileIndexService';
import { isEmbeddingServiceReady } from '../../services/embeddingService';
import { createScopedLogger } from '@core/logger';
import {
  hasPluginPermission,
  normalizeRelativePath,
  isTopicRelativePath,
  isSkillRelativePath,
  isPathWithin,
  resolveConfiguredPluginSpacePaths,
  listMarkdownFilesRecursively,
  extractTopicTitle,
  stripFrontmatter,
  buildTopicListCacheKey,
  getTopicListFromCache,
  setTopicListCache,
  normalizeConfiguredSpacePath,
  TOPICS_SUBPATH_PREFIX,
  SKILLS_SUBPATH,
  SKILLS_SUBPATH_PREFIX,
  type PluginTopicEntry,
  type PluginEntityEntry,
} from './shared';

const log = createScopedLogger({ service: 'pluginMemoryHandlers' });

export function registerPluginMemoryHandlers(): void {
  // ── Plugin Memory Search ──────────────────────────────────────────────

  const memorySearchChannel = pluginsChannels['plugins:memory-search'];
  registerHandler(memorySearchChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = memorySearchChannel.request.parse(request);
    const { pluginId, query, limit, pathPrefix } = validated;

    const hasPermission = await hasPluginPermission(pluginId, 'memory:read');
    if (!hasPermission) {
      log.warn({ pluginId }, 'Plugin attempted memory search without memory:read permission');
      return { status: 'ok' as const, results: [] };
    }

    if (!query || query.trim().length === 0) {
      return { status: 'ok' as const, results: [] };
    }

    // Pre-flight: check file index readiness
    if (!isFileIndexReady()) {
      // Distinguish "still scanning" from "empty workspace"
      if (getScanCompletedAt() !== null) {
        // Scan completed but no table — workspace has no indexable files
        return { status: 'ok' as const, results: [] };
      }
      return { status: 'index_not_ready' as const, results: [] };
    }

    // Pre-flight: check embedding service readiness
    if (!isEmbeddingServiceReady()) {
      return { status: 'embedding_not_ready' as const, results: [] };
    }

    try {
      const searchResult = await semanticSearchWithStatus(query, {
        limit: limit || 10,
        ...(pathPrefix ? { pathPrefix } : {}),
        // Explicit plugin-initiated memory search — enable the lexical exemption (F9).
        lexicalExemption: true,
      });
      if (searchResult.status !== 'ok') {
        const pluginStatus =
          searchResult.status === 'embedding_unavailable'
            ? 'embedding_not_ready'
            : searchResult.status;
        return {
          status: pluginStatus,
          results: [],
          ...(searchResult.message ? { message: searchResult.message } : {}),
        };
      }
      const searchResults = searchResult.results;
      log.debug({ query, resultCount: searchResults.length }, 'Plugin memory search completed');
      return {
        status: 'ok' as const,
        results: searchResults.map((r) => ({
          filePath: r.path,
          title: r.relativePath,
          snippet: r.snippet,
          score: r.score,
        })),
      };
    } catch (error) {
      log.error({ err: error, query }, 'Plugin memory search failed');
      return { status: 'error' as const, results: [], message: error instanceof Error ? error.message : 'Search failed' };
    }
  });

  // ── Plugin Source Search ──────────────────────────────────────────────

  const searchSourcesChannel = pluginsChannels['plugins:search-sources'];
  registerHandler(searchSourcesChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = searchSourcesChannel.request.parse(request);

    const hasPermission = await hasPluginPermission(validated.pluginId, 'memory:read');
    if (!hasPermission) {
      log.warn({ pluginId: validated.pluginId }, 'Plugin attempted source search without memory:read permission');
      return { sources: [], totalCount: 0 };
    }

    try {
      const { searchSources } = await import('@core/services/sourceMetadataStore');
      const result = await searchSources(
        {
          query: validated.query,
          sourceTypes: validated.sourceTypes,
          participants: validated.participants,
          dateRange: validated.dateRange,
          limit: validated.limit,
        },
        // Inject a status-aware semantic search adapter (avoids a circular
        // dependency). Routing through semanticSearchWithStatus gives plugin-
        // originated source searches the same once-per-workspace Sentry capture
        // as the MCP path. The new `status` field is intentionally NOT surfaced
        // here — this IPC response stays exactly `{ sources, totalCount }` for
        // back-compat; plugin-path honesty is a tracked follow-up.
        async (q, opts) => {
          // Explicit plugin-initiated source search — enable the lexical exemption (F9).
          const r = await semanticSearchWithStatus(q, { ...opts, lexicalExemption: true });
          return { status: r.status, results: r.results };
        },
      );

      log.debug(
        { query: validated.query, resultCount: result.sources.length, totalCount: result.totalCount },
        'Plugin source search completed',
      );

      return {
        sources: result.sources.map((s) => ({
          relativePath: s.relativePath,
          title: s.title,
          sourceType: s.sourceType,
          sourceSystem: s.sourceSystem,
          occurredAt: s.occurredAt,
          participants: s.participants,
          summary: s.summary,
          keyTakeaways: s.keyTakeaways,
          durationMinutes: s.durationMinutes,
          description: s.description,
          sourceUrl: s.sourceUrl || undefined,
          relevanceScore: s.relevanceScore,
        })),
        totalCount: result.totalCount,
      };
    } catch (error) {
      log.error({ err: error, query: validated.query }, 'Plugin source search failed');
      throw new Error(`Source search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });

  // ── Plugin Source Document ────────────────────────────────────────────

  const getSourceDocChannel = pluginsChannels['plugins:get-source-document'];
  registerHandler(getSourceDocChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = getSourceDocChannel.request.parse(request);
    const { pluginId, relativePath } = validated;

    const hasPermission = await hasPluginPermission(pluginId, 'memory:read');
    if (!hasPermission) {
      log.warn({ pluginId }, 'Plugin attempted to read source document without memory:read permission');
      return { document: null };
    }

    // Security: restrict reads to memory/sources/ paths only
    const normalizedPath = relativePath.replace(/\\/g, '/');
    if (!normalizedPath.startsWith('memory/sources/')) {
      log.warn({ relativePath }, 'Plugin attempted to read source outside memory/sources/');
      return { document: null };
    }

    // Prevent path traversal attacks
    if (normalizedPath.includes('..')) {
      log.warn({ relativePath }, 'Plugin attempted path traversal in source document read');
      return { document: null };
    }

    const workspacePath = getSettings().coreDirectory;
    if (!workspacePath) {
      return { document: null };
    }

    try {
      const { getSource } = await import('@core/services/sourceMetadataStore');
      const absolutePath = path.join(workspacePath, relativePath);
      const entry = getSource(absolutePath);

      if (!entry) {
        log.debug({ relativePath }, 'Source not found in metadata store');
        return { document: null };
      }

      // Read raw file content and strip frontmatter
      const rawContent = await fs.readFile(absolutePath, 'utf-8');
      const content = stripFrontmatter(rawContent);

      return {
        document: {
          relativePath: entry.relativePath,
          title: entry.title,
          sourceType: entry.sourceType,
          sourceSystem: entry.sourceSystem,
          occurredAt: entry.occurredAt,
          storedAt: entry.storedAt,
          participants: entry.participants,
          summary: entry.summary,
          keyTakeaways: entry.keyTakeaways,
          durationMinutes: entry.durationMinutes,
          truncated: entry.truncated,
          description: entry.description,
          sourceUrl: entry.sourceUrl || undefined,
          content,
        },
      };
    } catch (error) {
      log.error({ err: error, relativePath }, 'Plugin source document read failed');
      throw new Error(`Source document read failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });

  // ── Plugin Topics ─────────────────────────────────────────────────────

  const listTopicsChannel = pluginsChannels['plugins:list-topics'];
  registerHandler(listTopicsChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = listTopicsChannel.request.parse(request);

    const hasPermission = await hasPluginPermission(validated.pluginId, 'memory:read');
    if (!hasPermission) {
      log.warn({ pluginId: validated.pluginId }, 'Plugin attempted to list topics without memory:read permission');
      return { topics: [] };
    }

    const workspacePath = getSettings().coreDirectory;

    if (!workspacePath) {
      return { topics: [] };
    }

    // Check TTL cache before hitting the filesystem
    const cacheKey = buildTopicListCacheKey(workspacePath, validated.spacePath, validated.query, validated.limit);
    const cached = getTopicListFromCache(cacheKey);
    if (cached) {
      return { topics: cached };
    }

    const configuredSpacePaths = await resolveConfiguredPluginSpacePaths(workspacePath);
    const normalizedSpaceFilter = validated.spacePath
      ? normalizeConfiguredSpacePath(validated.spacePath)
      : null;

    if (validated.spacePath && !normalizedSpaceFilter) {
      return { topics: [] };
    }

    const targetSpacePaths = normalizedSpaceFilter
      ? configuredSpacePaths.filter((spacePath) => spacePath === normalizedSpaceFilter)
      : configuredSpacePaths;

    if (targetSpacePaths.length === 0) {
      return { topics: [] };
    }

    const query = validated.query?.trim().toLowerCase();
    const topics: PluginTopicEntry[] = [];

    for (const spacePath of targetSpacePaths) {
      const topicsRoot = path.join(workspacePath, spacePath, 'memory', 'topics');
      const topicFiles = await listMarkdownFilesRecursively(topicsRoot);

      for (const absolutePath of topicFiles) {
        try {
          const rawContent = await fs.readFile(absolutePath, 'utf-8');
          const title = extractTopicTitle(rawContent, absolutePath);

          if (query) {
            const titleMatches = title.toLowerCase().includes(query);
            const contentMatches = stripFrontmatter(rawContent).toLowerCase().includes(query);
            if (!titleMatches && !contentMatches) {
              continue;
            }
          }

          const stats = await fs.stat(absolutePath);
          const relPath = normalizeRelativePath(path.relative(workspacePath, absolutePath));

          if (!relPath || !isTopicRelativePath(relPath)) {
            continue;
          }

          topics.push({
            relativePath: relPath,
            title,
            spacePath,
            updatedAt: stats.mtime.toISOString(),
          });
        } catch (error) {
          log.debug({ err: error, filePath: absolutePath }, 'Failed to process topic file for plugin list-topics');
        }
      }
    }

    topics.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const result = topics.slice(0, validated.limit);
    setTopicListCache(cacheKey, result);

    return { topics: result };
  });

  const readTopicChannel = pluginsChannels['plugins:read-topic'];
  registerHandler(readTopicChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = readTopicChannel.request.parse(request);

    const hasPermission = await hasPluginPermission(validated.pluginId, 'memory:read');
    if (!hasPermission) {
      log.warn({ pluginId: validated.pluginId }, 'Plugin attempted to read topic without memory:read permission');
      return { content: null };
    }

    const workspacePath = getSettings().coreDirectory;

    if (!workspacePath) {
      return { content: null };
    }

    const normalizedPath = normalizeRelativePath(validated.relativePath);
    if (!normalizedPath || !isTopicRelativePath(normalizedPath)) {
      log.warn({ relativePath: validated.relativePath }, 'Plugin attempted to read topic outside memory/topics/');
      return { content: null };
    }

    const configuredSpacePaths = await resolveConfiguredPluginSpacePaths(workspacePath);
    const topicRoots = configuredSpacePaths.map((spacePath) =>
      path.resolve(workspacePath, spacePath, 'memory', 'topics'),
    );

    const candidateRelativePaths = normalizedPath.startsWith(TOPICS_SUBPATH_PREFIX)
      ? configuredSpacePaths.map((spacePath) => path.posix.join(spacePath, normalizedPath))
      : [normalizedPath];

    for (const candidate of candidateRelativePaths) {
      const normalizedCandidate = normalizeRelativePath(candidate);
      if (!normalizedCandidate || !isTopicRelativePath(normalizedCandidate)) {
        continue;
      }

      const absolutePath = path.resolve(workspacePath, normalizedCandidate);
      const allowed = topicRoots.some((root) => isPathWithin(root, absolutePath));
      if (!allowed) {
        continue;
      }

      try {
        const rawContent = await fs.readFile(absolutePath, 'utf-8');
        return { content: stripFrontmatter(rawContent) };
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : undefined;

        if (code === 'ENOENT' || code === 'ENOTDIR') {
          continue;
        }

        log.error({ err: error, relativePath: normalizedCandidate }, 'Plugin topic read failed');
        throw new Error(`Topic read failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return { content: null };
  });

  // ── Plugin Entities ───────────────────────────────────────────────────

  const getEntitiesChannel = pluginsChannels['plugins:get-entities'];
  registerHandler(getEntitiesChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = getEntitiesChannel.request.parse(request);

    const hasPermission = await hasPluginPermission(validated.pluginId, 'entities:read');
    if (!hasPermission) {
      log.warn({ pluginId: validated.pluginId }, 'Plugin attempted to get entities without entities:read permission');
      return { entities: [] };
    }

    const query = validated.query?.trim();
    const company = validated.company?.trim();
    const limit = Math.min(Math.max(1, validated.limit ?? 20), 50);

    try {
      const { searchEntities } = await import('../../services/entityMetadataStore');
      const result = searchEntities({
        entityType: validated.entityType,
        name: query && query.length > 0 ? query : undefined,
        company: company && company.length > 0 ? company : undefined,
        limit,
      });

      const entities: PluginEntityEntry[] = result.entities.map((entry) => ({
        canonicalName: entry.canonicalName,
        entityType: entry.entityType,
        emails: entry.emails,
        company: entry.company,
        role: entry.role,
        domain: entry.domain,
        aliases: entry.aliases,
      }));

      return { entities };
    } catch (error) {
      log.error({ err: error }, 'Plugin entity search failed');
      throw new Error(`Entity search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });

  // ── Plugin Skill Read ─────────────────────────────────────────────────

  const readSkillChannel = pluginsChannels['plugins:read-skill'];
  registerHandler(readSkillChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = readSkillChannel.request.parse(request);

    const hasPermission = await hasPluginPermission(validated.pluginId, 'skills:read');
    if (!hasPermission) {
      log.warn({ pluginId: validated.pluginId }, 'Plugin attempted to read skill without skills:read permission');
      return { content: null, frontmatter: null };
    }

    const workspacePath = getSettings().coreDirectory;

    if (!workspacePath) {
      return { content: null, frontmatter: null };
    }

    const normalizedPath = normalizeRelativePath(validated.relativePath);
    if (!normalizedPath || !isSkillRelativePath(normalizedPath)) {
      log.warn({ relativePath: validated.relativePath }, 'Plugin attempted to read skill outside skills/');
      return { content: null, frontmatter: null };
    }

    const configuredSpacePaths = await resolveConfiguredPluginSpacePaths(workspacePath);
    const skillRoots = configuredSpacePaths.map((spacePath) =>
      path.resolve(workspacePath, spacePath, SKILLS_SUBPATH),
    );

    const candidateRelativePaths = normalizedPath.startsWith(SKILLS_SUBPATH_PREFIX)
      ? configuredSpacePaths.map((spacePath) => path.posix.join(spacePath, normalizedPath))
      : [normalizedPath];

    for (const candidate of candidateRelativePaths) {
      const normalizedCandidate = normalizeRelativePath(candidate);
      if (!normalizedCandidate || !isSkillRelativePath(normalizedCandidate)) {
        continue;
      }

      const absolutePath = path.resolve(workspacePath, normalizedCandidate);
      const allowed = skillRoots.some((root) => isPathWithin(root, absolutePath));
      if (!allowed) {
        continue;
      }

      try {
        const rawContent = await fs.readFile(absolutePath, 'utf-8');

        try {
          const parsed = fm<Record<string, unknown>>(rawContent);
          return {
            content: parsed.body,
            frontmatter: parsed.attributes ?? null,
          };
        } catch (parseError) {
          log.warn(
            { err: parseError, relativePath: normalizedCandidate },
            'Plugin skill frontmatter parse failed, returning content without frontmatter',
          );
          return {
            content: stripFrontmatter(rawContent),
            frontmatter: null,
          };
        }
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code?: unknown }).code)
            : undefined;

        if (code === 'ENOENT' || code === 'ENOTDIR') {
          continue;
        }

        log.error({ err: error, relativePath: normalizedCandidate }, 'Plugin skill read failed');
        throw new Error(`Skill read failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return { content: null, frontmatter: null };
  });

  // ── Plugin Calendar/Meetings ────────────────────────────────────────────

  const getMeetingsChannel = pluginsChannels['plugins:get-meetings'];
  registerHandler(getMeetingsChannel.channel, async (_event: IpcMainInvokeEvent, request: unknown) => {
    const validated = getMeetingsChannel.request.parse(request);

    const hasPermission = await hasPluginPermission(validated.pluginId, 'memory:read');
    if (!hasPermission) {
      log.warn({ pluginId: validated.pluginId }, 'Plugin attempted to get meetings without memory:read permission');
      return { meetings: [], isStale: true };
    }

    try {
      const { getCachedMeetings, getTodaysMeetings, isCacheStale } = await import('@core/services/meetingCacheStore');
      const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const meetings = validated.todayOnly ? getTodaysMeetings(userTimeZone) : (getCachedMeetings()?.meetings ?? []);

      // Map to plugin-safe shape: omit calendarEventId, calendarSource (email), participantEmails, prepPath (filesystem)
      const pluginMeetings = meetings.map((m) => ({
        id: m.id,
        title: m.title,
        startTime: m.startTime,
        endTime: m.endTime,
        participants: m.participants,
        meetingUrl: m.meetingUrl,
      }));

      return {
        meetings: pluginMeetings,
        isStale: isCacheStale(),
      };
    } catch (error) {
      log.error({ err: error }, 'Plugin get-meetings failed');
      return { meetings: [], isStale: true };
    }
  });
}
