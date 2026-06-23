import { useCallback, useDeferredValue, useMemo } from 'react';
import type { AgentAttachmentPayload, InboxItem } from '@shared/types';
import type { BreadcrumbEntry, RendererLogPayload } from '@shared/types';
import { normalizePath, getFileName, createId } from '@renderer/utils/stringUtils';
import type { SearchResult, FlatFileEntry } from '@renderer/utils/librarySearch';
import { searchLibrary } from '@renderer/features/library/search/engine';
import { isSkillPath, isHiddenSkillMd, SPACE_SKILLS_PATTERN, PLATFORM_SKILLS_PATTERN } from '@renderer/utils/skillUtils';
import type { MentionedFileCandidate } from '../../composer/types';

const MENTION_TOKEN_REGEX = /@`([^`]+)`/g;
export const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_CHAR_LENGTH = 120000;

/** Maximum file results returned for @-mention autocomplete */
export const MAX_MENTION_FILE_RESULTS = 200;

/**
 * Normalizes a mention target path for consistent lookups.
 */
export const normalizeMentionTarget = (target: string): string => {
  const trimmed = target.trim();
  const withoutPrefix = trimmed.replace(/^\.\//, '').replace(/^\/+/, '');
  return withoutPrefix.replace(/\\/g, '/');
};

/**
 * Extracts @`path` mention targets from text.
 */
export const extractMentionTargets = (value: string): string[] => {
  const matches: string[] = [];
  value.replace(MENTION_TOKEN_REGEX, (_match, path) => {
    if (typeof path === 'string') {
      matches.push(path);
    }
    return '';
  });
  return matches;
};

type EmitLogPayload = Omit<RendererLogPayload, 'source' | 'breadcrumbs'> & {
  breadcrumbs?: BreadcrumbEntry[];
};

export type UseLibraryMentionsOptions = {
  libraryIndex: FlatFileEntry[] | null;
  /** Ref that always contains the latest library index value, updated synchronously on fetch completion.
   *  Used for reading fresh data immediately after awaiting refreshLibraryIndex() in async callbacks. */
  libraryIndexRef: React.RefObject<FlatFileEntry[] | null>;
  coreDirectory: string | null | undefined;
  textPrompt: string;
  libraryIndexLoaded: boolean;
  libraryIndexLoading: boolean;
  refreshLibraryIndex: () => Promise<void>;
  showToast: (message: { title: string }) => void;
  emitLog: (payload: EmitLogPayload) => void;
};

export type UseLibraryMentionsResult = {
  /** Ensures library index is loaded (triggers refresh if not). */
  ensureLibraryIndex: () => void;
  /** Converts an absolute path to a library-relative path. */
  getRelativeLibraryPath: (absolutePath: string) => string;
  /** Returns search results for mention autocomplete. */
  mentionResultsForQuery: (query: string) => SearchResult[];
  /** Checks if a relative path can be resolved in the library. */
  canResolveLibraryReference: (relativePath: string) => boolean;
  /** Builds a prompt string from a task queue item with resolved references. */
  buildPromptFromInboxItem: (task: InboxItem) => string;
  /** Resolves @mentions in text to file candidates. */
  resolveMentionedFiles: (value: string) => MentionedFileCandidate[];
  /** Currently mentioned files in the text prompt. */
  currentMentionedFiles: MentionedFileCandidate[];
  /** Loads file contents for mentioned files as attachments. */
  prepareMentionAttachments: (promptText: string) => Promise<AgentAttachmentPayload[]>;
};

/**
 * Hook for library file mention resolution.
 * Provides utilities for resolving @mentions to files, autocomplete,
 * and preparing file attachments.
 */
export function useLibraryMentions({
  libraryIndex,
  libraryIndexRef,
  coreDirectory,
  textPrompt,
  libraryIndexLoaded,
  libraryIndexLoading,
  refreshLibraryIndex,
  showToast,
  emitLog
}: UseLibraryMentionsOptions): UseLibraryMentionsResult {

  const ensureLibraryIndex = useCallback(() => {
    if (!coreDirectory) {
      return;
    }
    if (!libraryIndexLoaded && !libraryIndexLoading) {
      void refreshLibraryIndex();
    }
  }, [coreDirectory, libraryIndexLoaded, libraryIndexLoading, refreshLibraryIndex]);

  const getRelativeLibraryPath = useCallback(
    (absolutePath: string) => {
      if (!absolutePath) return '';
      if (!coreDirectory) {
        return getFileName(absolutePath);
      }

      const rootNormalized = normalizePath(coreDirectory).replace(/\/+$/, '');
      const targetNormalized = normalizePath(absolutePath);
      const rootLower = rootNormalized.toLowerCase();
      const targetLower = targetNormalized.toLowerCase();

      if (targetLower.startsWith(rootLower)) {
        let relative = targetNormalized.slice(rootNormalized.length);
        if (relative.startsWith('/')) {
          relative = relative.slice(1);
        }
        return relative.length > 0 ? relative : getFileName(absolutePath);
      }

      return getFileName(absolutePath);
    },
    [coreDirectory]
  );

  // Build a set of skill folder paths (directories containing SKILL.md)
  // This is used to boost skill folders above regular files in search results
  const skillFolderPaths = useMemo(() => {
    if (!libraryIndex) return new Set<string>();
    const paths = new Set<string>();
    for (const entry of libraryIndex) {
      if (entry.node.kind === 'directory' && isSkillPath(entry.fullPath)) {
        // Check if this directory has a SKILL.md child
        const hasSkillMd = entry.node.children?.some(
          (child) => child.kind === 'file' && child.name === 'SKILL.md'
        );
        if (hasSkillMd) {
          paths.add(entry.fullPath);
        }
      }
    }
    return paths;
  }, [libraryIndex]);

  const visibleMentionIndex = useMemo(() => {
    if (!libraryIndex || libraryIndex.length === 0) {
      return [];
    }
    // Keep this reference stable across keystrokes so search engine cache hits can reuse Fuse.
    return libraryIndex.filter((entry) => !isHiddenSkillMd(entry));
  }, [libraryIndex]);

  const mentionResultsForQuery = useCallback(
    (query: string): SearchResult[] => {
      if (visibleMentionIndex.length === 0) {
        return [];
      }

      const sanitizedQuery = query.trim();
      let results: SearchResult[];

      if (sanitizedQuery.length >= 2) {
        results = searchLibrary(sanitizedQuery, visibleMentionIndex, {
          limit: MAX_MENTION_FILE_RESULTS,
          surface: 'mentions',
        }).results;
      } else {
        // For short queries (0-1 chars), use early-exit loop instead of full .filter()
        // This avoids O(n) scan of entire library index during rapid typing
        const normalized = sanitizedQuery.toLowerCase();
        const fallbackEntries: typeof visibleMentionIndex = [];
        const MAX_FALLBACK = 16;

        for (const entry of visibleMentionIndex) {
          if (fallbackEntries.length >= MAX_FALLBACK) break;

          if (!normalized) {
            // Empty query - take first N entries
            fallbackEntries.push(entry);
          } else {
            // For skill folders, also match against the skill name from frontmatter
            const entryName = (entry.node.name ?? '').toLowerCase();
            const skillName = (entry.skillMeta?.name ?? '').toLowerCase();
            const fullPath = (entry.fullPath ?? '').toLowerCase();
            const nameMatch = entryName.startsWith(normalized);
            const skillNameMatch = skillName.startsWith(normalized);
            const pathMatch = fullPath.includes(normalized);
            if (nameMatch || skillNameMatch || pathMatch) {
              fallbackEntries.push(entry);
            }
          }
        }

        results = fallbackEntries.map((entry) => ({
          node: entry.node,
          fullPath: entry.fullPath,
          skillMeta: entry.skillMeta,
          score: 0,
          matches:
            normalized && (entry.node.name ?? '').toLowerCase().startsWith(normalized)
              ? [[0, normalized.length]]
              : []
        }));
      }

      // Prioritize skills with tiered ranking:
      // 1. Skill folders (directories with SKILL.md) - modern skill definition
      // 2. Space skills (Chief-of-Staff, Personal, work/*/*)
      // 3. Platform skills (rebel-system/skills)
      // 4. Everything else
      const getSkillPriority = (path: string): number => {
        if (SPACE_SKILLS_PATTERN.test(path)) return 0;
        if (PLATFORM_SKILLS_PATTERN.test(path)) return 1;
        return 2;
      };

      results.sort((a, b) => {
        // First tier: skill folders (with SKILL.md) rank above regular files
        const aIsSkillFolder = skillFolderPaths.has(a.fullPath);
        const bIsSkillFolder = skillFolderPaths.has(b.fullPath);
        if (aIsSkillFolder && !bIsSkillFolder) return -1;
        if (!aIsSkillFolder && bIsSkillFolder) return 1;

        // Second tier: by path priority (space > platform > other)
        const aPriority = getSkillPriority(a.fullPath);
        const bPriority = getSkillPriority(b.fullPath);
        if (aPriority !== bPriority) return aPriority - bPriority;

        // Third tier: directories before files within same priority
        if (a.node.kind === 'directory' && b.node.kind !== 'directory') return -1;
        if (a.node.kind !== 'directory' && b.node.kind === 'directory') return 1;

        // Finally: by search score
        return a.score - b.score;
      });

      return results.slice(0, MAX_MENTION_FILE_RESULTS);
    },
    [skillFolderPaths, visibleMentionIndex]
  );

  const mentionLookup = useMemo(() => {
    if (!libraryIndex || libraryIndex.length === 0) {
      return null;
    }

    // Intentionally uncapped: mention resolution must consult the full index for @`path` lookups,
    // even though autocomplete itself is capped via searchLibrary for responsiveness.
    const map = new Map<string, (typeof libraryIndex)[number]>();
    for (const entry of libraryIndex) {
      const absolutePath = entry.node.path;
      if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
        continue;
      }
      const relative = getRelativeLibraryPath(absolutePath);
      if (!relative) {
        continue;
      }
      const normalized = normalizeMentionTarget(relative).toLowerCase();
      map.set(normalized, entry);
      map.set(`./${normalized}`, entry);
    }
    return map;
  }, [libraryIndex, getRelativeLibraryPath]);

  const canResolveLibraryReference = useCallback(
    (relativePath: string) => {
      if (!mentionLookup) {
        return false;
      }
      const normalized = normalizeMentionTarget(relativePath).toLowerCase();
      return mentionLookup.has(normalized) || mentionLookup.has(`./${normalized}`);
    },
    [mentionLookup]
  );

  const buildPromptFromInboxItem = useCallback(
    (task: InboxItem) => {
      const sections: string[] = [];

      // Title as header
      sections.push(`## Action: ${task.title}`);

      // Source context (where this task came from)
      if (task.source) {
        const sourceLabel =
          task.source.kind === 'text' ? task.source.label : task.source.label || ('path' in task.source ? task.source.path : '');
        sections.push(`**Source:** ${sourceLabel}`);
      }

      // Main task description
      if (task.text.trim()) {
        sections.push(`**Task:** ${task.text.trim()}`);
      }

      // Clarifying question if present (guides user input)
      if (task.clarifyingQuestion?.trim()) {
        sections.push(`**Clarifying question:** ${task.clarifyingQuestion.trim()}`);
      }

      // Draft if present (pre-made deliverable)
      if (task.draft?.trim()) {
        sections.push(`**Draft:**\n${task.draft.trim()}`);
      }

      // References (library files and URLs)
      const libraryRefs = task.references.filter(
        (reference): reference is Extract<InboxItem['references'][number], { kind: 'workspace' }> =>
          reference.kind === 'workspace' && canResolveLibraryReference(reference.path)
      );
      const urlRefs = task.references.filter((reference) => reference.kind === 'url');
      
      if (libraryRefs.length > 0) {
        const mentionLines = libraryRefs.map((reference) => {
          const normalized = normalizeMentionTarget(reference.path);
          const label = reference.label ? ` — ${reference.label}` : '';
          return `- @\`${normalized}\`${label}`;
        });
        sections.push(`**Library references:**\n${mentionLines.join('\n')}`);
      }
      
      if (urlRefs.length > 0) {
        const urlLines = urlRefs.map((reference) => {
          const label = reference.label ? `${reference.label}: ` : '';
          return `- ${label}${reference.url}`;
        });
        sections.push(`**External references:**\n${urlLines.join('\n')}`);
      }

      return sections.join('\n\n');
    },
    [canResolveLibraryReference]
  );

  const resolveMentionedFiles = useCallback(
    (value: string): MentionedFileCandidate[] => {
      if (!mentionLookup) {
        return [];
      }
      const mentions = extractMentionTargets(value);
      if (mentions.length === 0) {
        return [];
      }
      const resolved: MentionedFileCandidate[] = [];
      const seen = new Set<string>();
      for (const target of mentions) {
        const normalized = normalizeMentionTarget(target);
        if (!normalized) {
          continue;
        }
        const key = normalized.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        const candidate = mentionLookup.get(key) ?? mentionLookup.get(`./${key}`);
        if (!candidate) {
          continue;
        }
        const absolutePath = candidate.node.path;
        if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
          continue;
        }
        seen.add(key);
        resolved.push({
          key,
          absolutePath,
          relativePath: getRelativeLibraryPath(absolutePath) || absolutePath,
          name: candidate.node.name,
          kind: candidate.node.kind
        });
      }
      return resolved;
    },
    [mentionLookup, getRelativeLibraryPath]
  );

  // Defer mention resolution to avoid blocking input during typing
  // This allows React to prioritize the text input while computing mentions in background
  const deferredTextPrompt = useDeferredValue(textPrompt);
  const currentMentionedFiles = useMemo(() => {
    if (!deferredTextPrompt) {
      return [];
    }
    return resolveMentionedFiles(deferredTextPrompt);
  }, [resolveMentionedFiles, deferredTextPrompt]);

  const prepareMentionAttachments = useCallback(
    async (promptText: string): Promise<AgentAttachmentPayload[]> => {
      if (!coreDirectory) {
        return [];
      }
      
      // Extract mention targets first - early exit if none
      const rawTargets = extractMentionTargets(promptText);
      if (rawTargets.length === 0) {
        return [];
      }
      
      // Ensure library index is loaded BEFORE attempting to resolve mentions.
      // This fixes a race condition where mentions could fail to resolve if the
      // index hadn't finished loading when the user clicked Send.
      if (!libraryIndexLoaded) {
        await refreshLibraryIndex();
      }
      
      // Build a fresh mention lookup from the ref (not the stale closure).
      // After the await above, libraryIndexRef.current will have the latest data,
      // whereas the `resolveMentionedFiles` callback might still have a stale mentionLookup.
      const currentIndex = libraryIndexRef.current;
      if (!currentIndex || currentIndex.length === 0) {
        throw new Error('Unable to resolve mentioned files in the library.');
      }
      
      // Build lookup map from the fresh index
      const freshLookup = new Map<string, FlatFileEntry>();
      for (const entry of currentIndex) {
        const absolutePath = entry.node.path;
        if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
          continue;
        }
        const relative = getRelativeLibraryPath(absolutePath);
        if (!relative) continue;
        const normalized = normalizeMentionTarget(relative).toLowerCase();
        freshLookup.set(normalized, entry);
        freshLookup.set(`./${normalized}`, entry);
      }
      
      // Resolve mentions using the fresh lookup
      const mentions: MentionedFileCandidate[] = [];
      const seen = new Set<string>();
      for (const target of rawTargets) {
        const normalized = normalizeMentionTarget(target);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        const candidate = freshLookup.get(key) ?? freshLookup.get(`./${key}`);
        if (!candidate) continue;
        const absolutePath = candidate.node.path;
        if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
          continue;
        }
        seen.add(key);
        mentions.push({
          key,
          absolutePath,
          relativePath: getRelativeLibraryPath(absolutePath) || absolutePath,
          name: candidate.node.name,
          kind: candidate.node.kind
        });
      }
      
      if (mentions.length === 0) {
        throw new Error('Unable to resolve mentioned files in the library.');
      }
      
      const limitedMentions = mentions.slice(0, MAX_ATTACHMENT_COUNT);
      if (mentions.length > MAX_ATTACHMENT_COUNT) {
        showToast({ title: `Only the first ${MAX_ATTACHMENT_COUNT} attachments will be sent.` });
      }

      const attachments: AgentAttachmentPayload[] = [];
      for (const mention of limitedMentions) {
        try {
          if (mention.kind === 'directory') {
            // Check if this is a skill folder (has SKILL.md inside)
            const skillMdPath = `${mention.absolutePath}/SKILL.md`;
            const isSkillFolder = isSkillPath(mention.relativePath);

            if (isSkillFolder) {
              // For skill folders: read SKILL.md content
              try {
                const skillData = await window.libraryApi.readFile(skillMdPath);
                if (skillData?.content) {
                  const content = skillData.content;
                  if (content.length > MAX_ATTACHMENT_CHAR_LENGTH) {
                    throw new Error(
                      `Skill "${mention.relativePath}" is larger than ${Math.floor(MAX_ATTACHMENT_CHAR_LENGTH / 1000)}k characters`
                    );
                  }
                  attachments.push({
                    id: createId(),
                    name: mention.name,
                    path: skillMdPath,
                    relativePath: `${mention.relativePath}/SKILL.md`,
                    size: content.length,
                    content
                  });
                  continue;
                }
              } catch {
                // Fall through to directory listing if SKILL.md can't be read
              }
            }

            // For regular directories: generate file listing from library index (use ref for fresh data)
            const folderPathLower = mention.relativePath.toLowerCase();
            const filesInFolder = currentIndex
              .filter((entry) => {
                if (entry.node.kind !== 'file') return false;
                const entryRelPath = getRelativeLibraryPath(entry.node.path).toLowerCase();
                return entryRelPath.startsWith(folderPathLower + '/');
              })
              .map((entry) => getRelativeLibraryPath(entry.node.path))
              .sort();

            const content =
              filesInFolder.length > 0
                ? `Files in ${mention.relativePath}/:\n${filesInFolder.map((f) => `- ${f}`).join('\n')}`
                : `${mention.relativePath}/ (empty or no files)`;

            attachments.push({
              id: createId(),
              name: mention.name + '/',
              path: mention.absolutePath,
              relativePath: mention.relativePath,
              size: content.length,
              content
            });
          } else {
            // For files: read file contents
            const fileData = await window.libraryApi.readFile(mention.absolutePath);
            if (!fileData || typeof fileData.content !== 'string') {
              throw new Error('Unable to read file contents');
            }
            const content = fileData.content;
            if (content.length > MAX_ATTACHMENT_CHAR_LENGTH) {
              throw new Error(
                `"${mention.relativePath}" is larger than ${Math.floor(MAX_ATTACHMENT_CHAR_LENGTH / 1000)}k characters`
              );
            }
            attachments.push({
              id: createId(),
              name: mention.name,
              path: mention.absolutePath,
              relativePath: mention.relativePath,
              size: content.length,
              content
            });
          }
        } catch (attachmentError) {
          emitLog({
            level: 'error',
            message: 'Failed to prepare mention attachment',
            context: {
              path: mention.absolutePath,
              relativePath: mention.relativePath
            },
            error:
              attachmentError instanceof Error
                ? {
                    name: attachmentError.name,
                    message: attachmentError.message,
                    stack: attachmentError.stack
                  }
                : undefined
          });
          const reason =
            attachmentError instanceof Error ? attachmentError.message : 'Unknown attachment error';
          throw new Error(`Unable to attach ${mention.relativePath}: ${reason}`);
        }
      }
      return attachments;
    },
    [
      coreDirectory,
      emitLog,
      getRelativeLibraryPath,
      libraryIndexLoaded,
      libraryIndexRef,
      refreshLibraryIndex,
      showToast
    ]
  );

  return {
    ensureLibraryIndex,
    getRelativeLibraryPath,
    mentionResultsForQuery,
    canResolveLibraryReference,
    buildPromptFromInboxItem,
    resolveMentionedFiles,
    currentMentionedFiles,
    prepareMentionAttachments
  };
}
