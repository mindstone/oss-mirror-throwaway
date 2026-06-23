/**
 * Shared utilities, types, constants, rate limiters, and caches for plugin IPC handlers.
 *
 * All domain-specific handler modules import from here.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fm from 'front-matter';
import { loadPersistedPluginEntries } from '../../services/pluginFilePersistence';
import { getSettings } from '@core/services/settingsStore';
import { createSlidingWindowRateLimiter } from '@core/services/pluginRateLimiter';
import { createScopedLogger } from '@core/logger';
import { CoalescedCache } from '@core/utils/coalescedCache';
import {
  safeWalkDirectory,
  DEFAULT_SAFE_WALK_LIMITS,
} from '@core/utils/safeWalkDirectory';
import { HotPathCounterTracker, type HotPathCounters } from '../../services/perfCounters';
import type { InboxItem } from '@shared/types';
import type { PersistedPlugin, PluginPermissionIpc } from '@shared/ipc/schemas/plugins';
import { AutomationSchedule } from '@shared/utils/automationSchedule';
import { assertNever } from '@shared/utils/assertNever';
import {
  scanSpacePlugins,
  registerInvalidatePluginIdentityCache,
  registerInvalidatePermissionCache,
} from './pluginIdentityRegistry';

export const log = createScopedLogger({ service: 'pluginHandlers' });

// ── Hot-path counters (Stage 1 observability) ───────────────────────────
// See docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 1.
// Counter updates are O(1) primitive ops — never gated. Built-in (`__`-prefixed)
// IDs shortcut BEFORE counter increment so they don't pollute hit-rate numbers.

const IS_PERF_MODE = process.env.REBEL_PERF_MODE === '1';

const isKnownPluginCounter = new HotPathCounterTracker();

/** Read-only snapshot of the isKnownPlugin counter struct. */
export function getIsKnownPluginCounters(): HotPathCounters {
  return isKnownPluginCounter.snapshot();
}

/** Test-only: zero the isKnownPlugin counter struct. */
export function _resetIsKnownPluginCountersForTesting(): void {
  isKnownPluginCounter._resetForTesting();
}

// ── Constants ───────────────────────────────────────────────────────────

export const TOPICS_SUBPATH = 'memory/topics';
export const TOPICS_SUBPATH_PREFIX = `${TOPICS_SUBPATH}/`;
export const SKILLS_SUBPATH = 'skills';
export const SKILLS_SUBPATH_PREFIX = `${SKILLS_SUBPATH}/`;
export const TOPIC_LIST_CACHE_TTL_MS = 30_000; // 30 seconds
export const INBOX_ADD_WINDOW_MS = 60_000;
export const INBOX_ADD_MAX_CALLS_PER_WINDOW = 10;
export const INBOX_ADD_CONTEXT_PREFIX = '\n\nContext:\n';

// ── Types ───────────────────────────────────────────────────────────────

export type PluginInboxPriority = 'low' | 'medium' | 'high';

export interface PluginTopicEntry {
  relativePath: string;
  title: string;
  spacePath: string;
  updatedAt: string;
}

export interface PluginEntityEntry {
  canonicalName: string;
  entityType: 'person' | 'company';
  emails: string[];
  company?: string;
  role?: string;
  domain?: string;
  aliases: string[];
}

// ── Path Utilities ──────────────────────────────────────────────────────

export function normalizeRelativePath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  const portable = trimmed.replace(/\\/g, '/');
  if (portable.includes('\0')) return null;
  if (portable.includes('%')) return null;
  if (path.posix.isAbsolute(portable) || /^[A-Za-z]:\//.test(portable)) return null;

  const normalized = path.posix.normalize(portable);
  if (!normalized || normalized === '.' || normalized === '..') return null;
  if (normalized.startsWith('../') || normalized.includes('/../')) return null;

  return normalized.replace(/^\.\/+/, '');
}

export function normalizeConfiguredSpacePath(spacePath: string): string | null {
  const normalized = normalizeRelativePath(spacePath);
  if (!normalized) return null;
  return normalized.replace(/\/+$/, '');
}

export function isPathWithin(parentDir: string, childPath: string): boolean {
  const relative = path.relative(parentDir, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isTopicRelativePath(normalizedPath: string): boolean {
  return normalizedPath.startsWith(TOPICS_SUBPATH_PREFIX) || normalizedPath.includes(`/${TOPICS_SUBPATH_PREFIX}`);
}

export function isSkillRelativePath(normalizedPath: string): boolean {
  return normalizedPath.startsWith(SKILLS_SUBPATH_PREFIX) || normalizedPath.includes(`/${SKILLS_SUBPATH_PREFIX}`);
}

// ── Permission & Identity ───────────────────────────────────────────────

/**
 * Standard read permissions granted to legacy plugins (no permissions declared).
 * Typed against the shared permission schema to prevent drift.
 */
export const STANDARD_READ_PERMISSIONS: ReadonlySet<string> = new Set<PluginPermissionIpc>([
  'conversations:read',
  'memory:read',
  'skills:read',
  'entities:read',
]);

/**
 * True when a permission set requests anything beyond the standard read tier
 * (e.g. external-fetch, conversations:write/transcript, skills:write,
 * automations:create, inbox:write). Used by the Stage 3A security-review gate:
 * a brand-new tool-created plugin requesting elevated permissions is held for
 * explicit user approval rather than auto-activated. Empty/undefined → false
 * (legacy plugins inherit only the standard read defaults).
 * See docs/plans/260527_plugin_agent_experience_overhaul.md — Stage 3A.
 */
export function requestsElevatedPermission(
  permissions: readonly string[] | undefined,
): boolean {
  return (permissions ?? []).some((permission) => !STANDARD_READ_PERMISSIONS.has(permission));
}

const permissionCache = new Map<string, string[]>();

export function populatePermissionCache(plugins: PersistedPlugin[]): void {
  permissionCache.clear();
  for (const plugin of plugins) {
    permissionCache.set(plugin.manifest.id, [...(plugin.manifest.permissions ?? [])]);
  }
}

export function invalidatePermissionCache(): void {
  permissionCache.clear();
}

export async function hasPluginPermission(pluginId: string, permission: string): Promise<boolean> {
  try {
    if (!permissionCache.has(pluginId)) {
      const persistedPlugins = await loadPersistedPluginEntries();
      populatePermissionCache(persistedPlugins);
    }

    if (!permissionCache.has(pluginId)) {
      return false;
    }

    const permissions = permissionCache.get(pluginId);
    if (!permissions || permissions.length === 0) {
      // Legacy plugins without declared permissions get standard read-only defaults
      return STANDARD_READ_PERMISSIONS.has(permission);
    }

    return permissions.includes(permission);
  } catch (error) {
    log.warn({ err: error, pluginId }, 'Failed to load persisted plugins while checking plugin permission');
    return false;
  }
}

/**
 * Validate that a pluginId corresponds to a known persisted plugin.
 * Built-in plugins (prefixed with '__') are always considered known.
 * Checks both local persisted plugins and Space-scanned plugins.
 * Used by storage handlers to prevent cross-plugin access attempts.
 */

// ── Plugin identity cache (Stage 4 — CoalescedCache on isKnownPlugin) ───
// See docs/plans/260420_perf_observability_and_low_risk_wins.md § Stage 4.
//
// Replaces the legacy post-complete `spaceScanCache` with a coalesced cache
// keyed on `coreDirectory`. The cache stores the IN-FLIGHT Promise so N
// concurrent callers pay the cost of exactly 1 underlying `scanSpacePlugins()`.
// Mutations to the plugin set (write/delete/migrate/archive/restore/keep-theirs)
// invalidate the entry for the current workspace; workspace switches clear all
// entries via `clearPluginIdentityCache()`.
//
// Kill switch: `REBEL_DISABLE_PLUGIN_COALESCE=1` falls back to the legacy
// post-complete cache semantics (checked per-call so dev can toggle without
// restart — the env-var gate is cheap).

const SPACE_SCAN_CACHE_TTL_MS = 5_000; // 5 seconds
const NO_WORKSPACE_KEY = '<no-workspace>';

// scanSpacePlugins is provided through `pluginIdentityRegistry` (the bottom-of-
// graph registry that breaks the historical shared.ts ↔ pluginSpaceService
// cycle). `pluginSpaceService` self-registers its `scanSpacePlugins` at module
// load; until that registration happens, the registry returns an empty result
// and logs a warning — preserving the prior "best-effort during boot" semantics
// without the static-or-dynamic edge that madge flagged as cyclic.

/**
 * Test-only shim retained so existing tests that called
 * `_resetScanSpacePluginsResolverForTesting()` keep compiling. With the
 * registry-based wiring there is no per-call resolver cache to reset; use
 * `_resetPluginIdentityRegistryForTesting()` from the registry instead for
 * full reset semantics.
 */
export function _resetScanSpacePluginsResolverForTesting(): void {
  // No-op: registry-based path has no per-call cache to clear.
}

const pluginIdentityCache = new CoalescedCache<Set<string>>({
  ttlMs: SPACE_SCAN_CACHE_TTL_MS,
  maxEntries: 8, // Few distinct `coreDirectory` values in practice.
  now: () => Date.now(),
  onHit: () => {
    isKnownPluginCounter.recordHit();
  },
  onMiss: () => {
    isKnownPluginCounter.recordMiss();
  },
  onInflight: () => {
    isKnownPluginCounter.recordInflightJoin();
  },
  onError: (_key, err) => {
    isKnownPluginCounter.recordFetchError();
    log.warn({ err, reason: 'plugin-identity-cache-fetch-error' }, 'Plugin identity cache fetcher rejected');
  },
});

// Legacy post-complete cache — only consulted when the kill switch is engaged.
let legacySpaceScanCache: { pluginIds: Set<string>; expiresAt: number; coreDirectory: string } | null = null;

function getPluginIdentityCacheKey(): string {
  // `getSettings()` is expected to return a valid settings object in production
  // (wired at bootstrap), but guard against undefined/null for tests that don't
  // mock it — callers are in mutator hot paths (writePluginToSpace, etc.) and
  // shouldn't throw TypeErrors just because this key can't be computed. Fall
  // back to the no-workspace sentinel so invalidate/clear remain safe no-ops.
  const coreDirectory = getSettings()?.coreDirectory;
  return coreDirectory && coreDirectory.length > 0 ? coreDirectory : NO_WORKSPACE_KEY;
}

function isCoalesceDisabled(): boolean {
  return process.env.REBEL_DISABLE_PLUGIN_COALESCE === '1';
}

/**
 * Invalidate the cached Space-scan plugin-identity set for the CURRENT workspace.
 * Call this from every low-level mutation site (writePluginToSpace,
 * deletePluginFromSpace, archive/restore, keep-theirs resolution, etc.).
 * Invalidates BOTH the coalesced cache AND the legacy kill-switch cache so
 * mutations are observed regardless of `REBEL_DISABLE_PLUGIN_COALESCE`.
 */
export function invalidatePluginIdentityCache(reason?: string): void {
  const key = getPluginIdentityCacheKey();
  pluginIdentityCache.invalidate(key);
  if (IS_PERF_MODE) {
    log.debug({ key, reason, profilerChannel: 'perf-summary' }, 'Invalidated plugin identity cache');
  }
  // Also clear the legacy cache so the kill-switch path picks up the mutation.
  if (legacySpaceScanCache && legacySpaceScanCache.coreDirectory === key) {
    legacySpaceScanCache = null;
  }
}

/**
 * Fully clear the plugin-identity cache (all workspace keys).
 * Call on workspace / coreDirectory switch so the new workspace does NOT serve
 * stale plugin-ID sets from the previous workspace.
 */
export function clearPluginIdentityCache(reason?: string): void {
  pluginIdentityCache.clear();
  legacySpaceScanCache = null;
  if (IS_PERF_MODE) {
    log.debug({ reason, profilerChannel: 'perf-summary' }, 'Cleared plugin identity cache');
  }
}

// Register cache invalidators on the registry so callers (notably
// pluginSpaceService) can invoke them statically through the registry instead
// of via dynamic `import('../ipc/plugins/shared')` (which madge flags as a
// cycle even though it is dynamic).
registerInvalidatePluginIdentityCache(invalidatePluginIdentityCache);
registerInvalidatePermissionCache(invalidatePermissionCache);

/** Test-only: clear the coalesced cache AND the legacy kill-switch cache. */
export function _resetPluginIdentityCacheForTesting(): void {
  pluginIdentityCache.clear();
  legacySpaceScanCache = null;
}

/**
 * Back-compat shim so existing Stage 1 tests that referenced the old
 * post-complete cache name keep working after Stage 4.
 */
export function _clearSpaceScanCacheForTesting(): void {
  _resetPluginIdentityCacheForTesting();
}

export async function isKnownPlugin(pluginId: string): Promise<boolean> {
  // Built-in IDs shortcut BEFORE the counter so they don't pollute hit-rate numbers.
  if (pluginId.startsWith('__')) {
    return true;
  }

  isKnownPluginCounter.recordRequest();
  // Caller-provenance debug log (perf-mode only) — surfaces chatty callers so a
  // dominant caller-side bug isn't masked by the coalescing fix in Stage 4.
  if (IS_PERF_MODE) {
    log.debug({ pluginId, reason: 'isKnownPlugin-call' }, 'plugin identity check');
  }

  try {
    const persistedPlugins = await loadPersistedPluginEntries();
    if (persistedPlugins.some((entry) => entry.manifest.id === pluginId)) {
      isKnownPluginCounter.recordHit();
      return true;
    }
  } catch (error) {
    log.warn({ err: error, pluginId }, 'Failed to validate plugin identity for storage access');
    // Counted as a fetch error on the persisted-plugins path; treat as miss
    // for hit-rate accounting since we returned without serving from cache.
    isKnownPluginCounter.recordFetchError();
    return false;
  }

  const key = getPluginIdentityCacheKey();

  // Kill-switch path: preserve the pre-Stage-4 post-complete cache semantics,
  // but with resolve-time TTL (Stage-4 review fix F5) so both paths agree on
  // "cache for 5s after the scan returned" — not "5s from miss start".
  if (isCoalesceDisabled()) {
    try {
      if (
        legacySpaceScanCache
        && legacySpaceScanCache.coreDirectory === key
        && Date.now() < legacySpaceScanCache.expiresAt
      ) {
        isKnownPluginCounter.recordHit();
        return legacySpaceScanCache.pluginIds.has(pluginId);
      }

      isKnownPluginCounter.recordMiss();
      isKnownPluginCounter.recordUnderlyingFetchStart();
      try {
        const { plugins } = await scanSpacePlugins();
        const pluginIds = new Set(plugins.map((p) => p.pluginId));
        legacySpaceScanCache = {
          pluginIds,
          expiresAt: Date.now() + SPACE_SCAN_CACHE_TTL_MS,
          coreDirectory: key,
        };
        return pluginIds.has(pluginId);
      } finally {
        isKnownPluginCounter.recordUnderlyingFetchEnd();
      }
    } catch (error) {
      log.warn({ err: error, pluginId }, 'Failed to scan Space plugins for identity check');
      isKnownPluginCounter.recordFetchError();
      return false;
    }
  }

  // Default path: coalesced cache. Concurrent callers join the in-flight Promise
  // so only 1 `scanSpacePlugins()` fires per (coreDirectory, ttl-window).
  try {
    const pluginIds = await pluginIdentityCache.get(key, async () => {
      isKnownPluginCounter.recordUnderlyingFetchStart();
      try {
        const { plugins } = await scanSpacePlugins();
        return new Set(plugins.map((p) => p.pluginId));
      } finally {
        isKnownPluginCounter.recordUnderlyingFetchEnd();
      }
    });
    return pluginIds.has(pluginId);
  } catch (error) {
    // Error is already counted via the `onError` hook on the cache options.
    // The cache does not populate `results` on rejection — the next call will retry.
    log.warn({ err: error, pluginId }, 'Failed to scan Space plugins for identity check');
    return false;
  }
}

export async function getPluginExternalDomains(pluginId: string): Promise<string[]> {
  try {
    const persistedPlugins = await loadPersistedPluginEntries();
    const plugin = persistedPlugins.find((entry) => entry.manifest.id === pluginId);
    return plugin?.manifest.externalDomains ?? [];
  } catch (error) {
    log.warn({ err: error, pluginId }, 'Failed to load persisted plugins for external domains lookup');
    return [];
  }
}

// ── Workspace / Space Resolution ────────────────────────────────────────

export async function resolveConfiguredPluginSpacePaths(workspacePath: string): Promise<string[]> {
  const settings = getSettings();
  const configured = new Set<string>();

  const addSpacePath = (candidate: string | undefined): void => {
    if (!candidate) return;
    const normalized = normalizeConfiguredSpacePath(candidate);
    if (normalized) configured.add(normalized);
  };

  if (settings.spaces !== undefined) {
    for (const space of settings.spaces) {
      addSpacePath(space.path);
    }
  } else {
    for (const link of settings.googleDriveLinks ?? []) {
      addSpacePath(link.symlinkPath);
    }
  }

  if (configured.size === 0) {
    try {
      const rootEntries = await fs.readdir(workspacePath, { withFileTypes: true });
      const cosEntry = rootEntries.find((entry) =>
        (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.toLowerCase() === 'chief-of-staff',
      );
      if (cosEntry) configured.add(cosEntry.name);
    } catch {
      // Ignore fallback scan errors
    }
  }

  if (configured.size === 0) {
    configured.add('Chief-of-Staff');
  }

  return Array.from(configured);
}

export async function resolveSkillWriteTarget(
  workspacePath: string,
  relativePath: string,
): Promise<{ normalizedRelativePath: string; absolutePath: string } | null> {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath || !isSkillRelativePath(normalizedPath)) {
    return null;
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

    return { normalizedRelativePath: normalizedCandidate, absolutePath };
  }

  return null;
}

// ── Filesystem Helpers ──────────────────────────────────────────────────

/**
 * Strip YAML frontmatter from markdown content.
 * Looks for `---\n...\n---\n` at the start of the file.
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) {
    return content.slice(match[0].length);
  }
  return content;
}

/**
 * List every `.md` file under `rootDir` with depth, path-length, and cycle
 * protection. Backed by the shared `safeWalkDirectory` utility so the same
 * proven guards apply across every recursive walker in the codebase.
 *
 * REBEL-506 / REBEL-4WS..510 history: a user's self-nested workspace was
 * generating ENAMETOOLONG storms in every walker that descended from the
 * workspace root. Commit `4d8981cd2` patched this one walker; this fix
 * generalises the defence so all walkers route through `safeWalkDirectory`.
 *
 * Behaviour preserved from the prior implementation:
 *  - Returns absolute paths in walk order (BFS-via-stack semantics).
 *  - Follows symlinks-to-directories (with cycle detection).
 *  - Picks up symlinks pointing at `.md` files.
 *  - Silently skips broken symlinks, unreadable subtrees, and missing roots.
 */
export async function listMarkdownFilesRecursively(rootDir: string): Promise<string[]> {
  const markdownFiles: string[] = [];

  await safeWalkDirectory(rootDir, {
    onFile: ({ absolutePath, name }) => {
      if (name.toLowerCase().endsWith('.md')) {
        markdownFiles.push(absolutePath);
      }
    },
    onTruncated: ({ reasons, entriesVisited }) => {
      log.warn(
        { rootDir, entriesVisited, results: markdownFiles.length, reasons },
        'listMarkdownFilesRecursively hit a traversal cap (depth/path-length/entries) — results may be incomplete',
      );
    },
  });

  return markdownFiles;
}

// Test-only exports for the traversal limits, so unit tests don't need to
// reach into module internals or hard-code matching numbers.
// Sourced from the shared safeWalkDirectory defaults.
// eslint-disable-next-line @typescript-eslint/naming-convention -- intentional `__` prefix marks this as test-only
export const __listMarkdownTraversalLimits = {
  MAX_DEPTH: DEFAULT_SAFE_WALK_LIMITS.MAX_DEPTH,
  MAX_PATH_LENGTH: DEFAULT_SAFE_WALK_LIMITS.MAX_PATH_LENGTH,
  MAX_ENTRIES: DEFAULT_SAFE_WALK_LIMITS.MAX_ENTRIES,
} as const;

export function extractTopicTitle(rawContent: string, absolutePath: string): string {
  try {
    const parsed = fm<Record<string, unknown>>(rawContent);
    const title = parsed.attributes?.title;
    if (typeof title === 'string' && title.trim().length > 0) {
      return title.trim();
    }
  } catch {
    // Fall back to filename when frontmatter parsing fails
  }

  const basename = path.basename(absolutePath, path.extname(absolutePath));
  return basename.replace(/[-_]+/g, ' ').trim() || basename;
}

// ── Topic List Cache (30s TTL) ──────────────────────────────────────────

interface TopicListCacheEntry {
  topics: PluginTopicEntry[];
  expiresAt: number;
}

const topicListCache = new Map<string, TopicListCacheEntry>();

export function buildTopicListCacheKey(
  workspacePath: string,
  spacePath: string | undefined,
  query: string | undefined,
  limit: number,
): string {
  return `${workspacePath}:${spacePath ?? 'all'}:${query ?? ''}:${limit}`;
}

export function getTopicListFromCache(cacheKey: string): PluginTopicEntry[] | null {
  const entry = topicListCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    topicListCache.delete(cacheKey);
    return null;
  }
  return entry.topics;
}

export function setTopicListCache(cacheKey: string, topics: PluginTopicEntry[]): void {
  topicListCache.set(cacheKey, { topics, expiresAt: Date.now() + TOPIC_LIST_CACHE_TTL_MS });
}

export function _clearTopicListCacheForTesting(): void {
  topicListCache.clear();
}

// ── Inbox Add Rate Limiter ──────────────────────────────────────────────

const inboxAddRateLimiter = createSlidingWindowRateLimiter(
  INBOX_ADD_WINDOW_MS,
  INBOX_ADD_MAX_CALLS_PER_WINDOW,
);

export function checkInboxAddRateLimit(pluginId: string): { allowed: boolean; retryAfterMs?: number } {
  return inboxAddRateLimiter.check(pluginId);
}

export function recordInboxAddCall(pluginId: string): void {
  inboxAddRateLimiter.record(pluginId);
}

export function _resetPluginInboxAddRateLimiterForTesting(): void {
  inboxAddRateLimiter._resetForTesting();
}

// ── Automation Creation Rate Limiter ────────────────────────────────────

const AUTOMATION_CREATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const AUTOMATION_CREATE_MAX_PER_WINDOW = 3;
const automationCreateRateLimiter = createSlidingWindowRateLimiter(
  AUTOMATION_CREATE_WINDOW_MS,
  AUTOMATION_CREATE_MAX_PER_WINDOW,
);

export function checkAutomationCreateRateLimit(pluginId: string): { allowed: boolean; retryAfterMs?: number } {
  return automationCreateRateLimiter.check(pluginId);
}

export function recordAutomationCreateCall(pluginId: string): void {
  automationCreateRateLimiter.record(pluginId);
}

export function _resetPluginAutomationCreateRateLimiterForTesting(): void {
  automationCreateRateLimiter._resetForTesting();
}

// ── Transcript Read Rate Limiter ────────────────────────────────────────

const transcriptReadRateLimiter = createSlidingWindowRateLimiter(60_000, 10);

export function checkTranscriptReadRateLimit(pluginId: string): { allowed: boolean; retryAfterMs?: number } {
  return transcriptReadRateLimiter.check(pluginId);
}

export function recordTranscriptReadCall(pluginId: string): void {
  transcriptReadRateLimiter.record(pluginId);
}

export function _resetPluginTranscriptReadRateLimiterForTesting(): void {
  transcriptReadRateLimiter._resetForTesting();
}

// ── Inbox Mapping Utilities ─────────────────────────────────────────────

export function mapPluginPriorityToInbox(priority: PluginInboxPriority | undefined): {
  priority?: 'p1' | 'p2' | 'p3';
  urgent?: boolean;
  important?: boolean;
} {
  switch (priority) {
    case 'high':
      return { priority: 'p1', urgent: true, important: true };
    case 'low':
      return { priority: 'p3', urgent: false, important: false };
    case 'medium':
    case undefined:
      return { priority: 'p2', urgent: false, important: true };
    default:
      return assertNever(priority, 'PluginInboxPriority');
  }
}

export function mapInboxPriorityToPlugin(item: InboxItem): PluginInboxPriority {
  if (item.urgent === true && item.important !== false) return 'high';
  if (item.urgent === false && item.important === false) return 'low';

  if (item.priority === 'p1') return 'high';
  if (item.priority === 'p3') return 'low';

  return 'medium';
}

export function trimOptional(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildInboxText(description: string | undefined, actionPrompt: string | undefined): string | undefined {
  if (actionPrompt && description) {
    return `${actionPrompt}${INBOX_ADD_CONTEXT_PREFIX}${description}`;
  }
  return actionPrompt ?? description;
}

export function getPluginAttribution(item: InboxItem): string | undefined {
  if (item.source?.kind !== 'automation') {
    return undefined;
  }

  if (!item.source.automationId.startsWith('plugin:')) {
    return undefined;
  }

  const attributedPluginId = item.source.automationId.slice('plugin:'.length).trim();
  return attributedPluginId.length > 0 ? attributedPluginId : undefined;
}

export function extractDescriptionFromText(
  text: string | undefined,
  actionPrompt: string | undefined,
): string | undefined {
  const trimmedText = trimOptional(text);
  if (!trimmedText) return undefined;
  if (!actionPrompt) return trimmedText;

  const expectedPrefix = `${actionPrompt}${INBOX_ADD_CONTEXT_PREFIX}`;
  if (!trimmedText.startsWith(expectedPrefix)) {
    return trimmedText;
  }

  return trimOptional(trimmedText.slice(expectedPrefix.length));
}

export function mapInboxItemForPlugin(item: InboxItem) {
  const pluginId = getPluginAttribution(item);
  const actionPrompt = pluginId ? trimOptional(item.draft ?? undefined) : undefined;
  const description = extractDescriptionFromText(item.text, actionPrompt);

  return {
    itemId: item.id,
    title: item.title,
    ...(description ? { description } : {}),
    priority: mapInboxPriorityToPlugin(item),
    ...(actionPrompt ? { actionPrompt } : {}),
    ...(pluginId ? { pluginId } : {}),
    createdAt: item.addedAt,
    archived: Boolean(item.archived),
  };
}

// ── Automation Schedule Utilities ───────────────────────────────────────

/**
 * Convert a plugin schedule (interval/cron) to the system AutomationSchedule.
 * Interval strings like "30m", "1h", "1d" are mapped to the closest schedule type.
 */
export function pluginScheduleToAutomationSchedule(
  schedule: { type: 'interval' | 'cron'; value: string },
): import('@shared/types').AutomationSchedule | null {
  if (schedule.type === 'cron') {
    // Cron expressions are not directly supported by the automation scheduler;
    // approximate by parsing common patterns or reject.
    // For now, reject cron and only support interval.
    return null;
  }

  const match = schedule.value.match(/^(\d+)([mhd])$/);
  if (!match) return null;

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];

  if (!Number.isFinite(amount) || amount <= 0) return null;

  let candidate: unknown;
  switch (unit) {
    case 'm': {
      // Convert minutes to hourly at given minute mark (if <= 59m)
      if (amount <= 59) {
        candidate = { type: 'hourly', minute: amount };
        break;
      }
      // For larger minute values, convert to hours
      const hours = Math.round(amount / 60);
      if (hours >= 24) {
        candidate = { type: 'daily', time: '09:00' };
        break;
      }
      candidate = { type: 'hourly', minute: 0 };
      break;
    }
    case 'h': {
      if (amount >= 24) {
        candidate = { type: 'daily', time: '09:00' };
        break;
      }
      candidate = { type: 'hourly', minute: 0 };
      break;
    }
    case 'd': {
      if (amount === 1) {
        candidate = { type: 'daily', time: '09:00' };
        break;
      }
      candidate = {
        type: 'every_n_days',
        intervalDays: amount,
        time: '09:00',
      };
      break;
    }
    default:
      return null;
  }

  const parsed = AutomationSchedule.fromUntrusted(candidate, { source: 'plugin', now: Date.now() });
  if (!parsed.ok) {
    log.warn(
      { schedule, reason: parsed.error.kind },
      'Plugin schedule conversion failed during schedule normalisation',
    );
    return null;
  }

  return parsed.value;
}

/**
 * Format an AutomationSchedule into the simplified plugin-facing shape.
 */
export function formatScheduleForPlugin(
  schedule: import('@shared/types').AutomationSchedule,
): { type: string; value?: string } {
  switch (schedule.type) {
    case 'hourly':
      return { type: 'interval', value: '1h' };
    case 'daily':
      return { type: 'interval', value: '1d' };
    case 'every_n_days':
      return { type: 'interval', value: `${schedule.intervalDays}d` };
    case 'weekly':
      return { type: 'interval', value: '7d' };
    case 'monthly':
      return { type: 'interval', value: '30d' };
    case 'event':
      return { type: 'event', value: schedule.eventType };
    case 'once':
      return { type: 'once', value: schedule.dateTime };
    default:
      return { type: 'unknown' };
  }
}
