import { type ReactElement } from 'react';
import Fuse, { type IFuseOptions } from 'fuse.js';
import type { FileNode } from '@shared/types';

/**
 * Skill metadata extracted from SKILL.md frontmatter.
 * Used to display skill folders with their proper name.
 */
export interface SkillMeta {
  /** Skill name from frontmatter (hyphen-case) */
  name: string;
  /** Skill description from frontmatter */
  description?: string;
}

export interface FlatFileEntry {
  node: FileNode;
  fullPath: string;
  /** If this is a skill folder, contains parsed SKILL.md frontmatter metadata */
  skillMeta?: SkillMeta;
}

export interface SearchResult extends FlatFileEntry {
  score: number;
  matches: Array<[number, number]>;
}

/**
 * Flatten file tree structure for searching.
 * Uses iterative stack-based traversal to avoid call-stack overflow on
 * large/cyclic trees. Includes both files and directories.
 * Note: traversal order is not guaranteed — consumers must not depend on it.
 */
export const flattenFileTree = (
  nodes: FileNode[],
  parentPath = ''
): FlatFileEntry[] => {
  const result: FlatFileEntry[] = [];
  const visited = new Set<string>();
  const stack: Array<{ nodes: FileNode[]; parentPath: string }> = [{ nodes, parentPath }];

  let frame = stack.pop();
  while (frame) {
    const { nodes: currentNodes, parentPath: currentParent } = frame;
    for (const node of currentNodes) {
      if (visited.has(node.path)) {
        console.warn(`[flattenFileTree] Cycle detected at ${node.path}, skipping`);
        continue;
      }
      visited.add(node.path);
      const fullPath = currentParent ? `${currentParent}/${node.name}` : node.name;
      result.push({ node, fullPath });
      if (node.kind === 'directory' && node.children) {
        stack.push({ nodes: node.children, parentPath: fullPath });
      }
    }
    frame = stack.pop();
  }

  return result;
};

/**
 * Create a path-to-node lookup map from flattened files
 */
export const createPathMap = (files: FlatFileEntry[]): Map<string, FileNode> => {
  const map = new Map<string, FileNode>();
  for (const file of files) {
    map.set(file.node.path, file.node);
  }
  return map;
};

type SearchFilesOptions = { limit?: number };

/**
 * Normalize string for matching: remove special chars, lowercase
 */
const normalizeForSearch = (str: string): string => {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
};

/**
 * Transform a search query for Fuse.js extended search mode.
 * Splits on hyphens and spaces, prefixes each term with ' (include-match syntax).
 *
 * Examples:
 * - "chr-mov" → "'chr 'mov"
 * - "quiz guess" → "'quiz 'guess"
 * - "christmas" → "'christmas"
 *
 * @param query - Raw user query
 * @returns Transformed query for Fuse.js extended search
 */
const transformQueryForExtendedSearch = (query: string): string => {
  const parts = query
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((p) => `'${p}`).join(' ');
};

/**
 * Check if a single term's characters appear in order in target (subsequence match)
 */
const isSubsequenceMatch = (term: string, target: string): boolean => {
  const normalizedTerm = normalizeForSearch(term);
  const normalizedTarget = normalizeForSearch(target);
  
  let targetIndex = 0;
  for (const char of normalizedTerm) {
    const foundIndex = normalizedTarget.indexOf(char, targetIndex);
    if (foundIndex === -1) {
      return false;
    }
    targetIndex = foundIndex + 1;
  }
  return true;
};

/**
 * Check if query matches target more exactly.
 * For multi-term queries (containing spaces or hyphens), each term is checked independently.
 * This allows "skill write" to match "write-skill.md" (both terms present, any order).
 */
const isStrictMatch = (query: string, target: string): boolean => {
  // Split query into terms (by spaces and hyphens)
  const terms = query.toLowerCase().split(/[-\s]+/).filter(Boolean);
  
  if (terms.length === 0) {
    return false;
  }
  
  // For multi-term queries, check that EACH term is a subsequence match
  // This allows terms to appear in any order in the target
  if (terms.length > 1) {
    return terms.every(term => isSubsequenceMatch(term, target));
  }
  
  // For single-term queries, use original subsequence matching
  return isSubsequenceMatch(query, target);
};

const librarySearchFuseOptions: IFuseOptions<FlatFileEntry> = {
  keys: [
    { name: 'node.name', weight: 0.5 },
    { name: 'fullPath', weight: 0.1 },
    { name: 'skillMeta.description', weight: 0.3 },
    { name: 'skillMeta.name', weight: 0.1 }
  ],
  threshold: 0.3, // Stricter threshold (was 0.4)
  includeScore: true,
  includeMatches: true,
  ignoreLocation: false, // Respect location for more accurate matching
  minMatchCharLength: 2, // Require at least 2 chars to match
  distance: 50, // Reduced distance for tighter matching
  findAllMatches: false, // Stop at first match for speed
  useExtendedSearch: true // Enable tokenized multi-term matching
};

/**
 * Build a Fuse instance using the canonical library search configuration.
 */
export const createLibrarySearchFuse = (
  files: ReadonlyArray<FlatFileEntry>
): Fuse<FlatFileEntry> => {
  return new Fuse(files as FlatFileEntry[], librarySearchFuseOptions);
};

/**
 * Perform fuzzy search with a provided Fuse instance.
 */
export const searchFilesWithFuse = (
  query: string,
  files: ReadonlyArray<FlatFileEntry>,
  fuse: Fuse<FlatFileEntry>,
  options?: SearchFilesOptions
): SearchResult[] => {
  const limit = options?.limit ?? 30;
  const trimmedQuery = query.trim();

  if (!trimmedQuery || files.length === 0) {
    return [];
  }

  const extendedQuery = transformQueryForExtendedSearch(trimmedQuery);

  // Guard against delimiter-only queries (e.g. "-") that become empty after transformation
  if (!extendedQuery) {
    return [];
  }

  // Get more results initially to filter and sort
  const fuseResults = fuse.search(extendedQuery, { limit: limit * 2 });

  // Filter to only strict matches
  const strictResults = fuseResults.filter((result) => {
    const matchesName = isStrictMatch(trimmedQuery, result.item.node.name);
    const matchesSkillName = result.item.skillMeta?.name
      ? isStrictMatch(trimmedQuery, result.item.skillMeta.name)
      : false;
    const matchesSkillDescription = result.item.skillMeta?.description
      ? isStrictMatch(trimmedQuery, result.item.skillMeta.description)
      : false;
    // Only check path if query contains path separator (indicating user wants path matching)
    // Normalize backslashes so Windows-style queries match forward-slash fullPaths
    const normalizedQuery = trimmedQuery.replace(/\\/g, '/');
    const matchesPath = normalizedQuery.includes('/') &&
                        isStrictMatch(normalizedQuery, result.item.fullPath);
    return matchesName || matchesSkillName || matchesSkillDescription || matchesPath;
  });

  // Convert to SearchResult format
  const searchResults: SearchResult[] = strictResults.map((result) => {
    const matches: Array<[number, number]> = [];

    if (result.matches) {
      for (const match of result.matches) {
        if (match.key === 'node.name' && match.indices) {
          for (const [start, end] of match.indices) {
            matches.push([start, end + 1]);
          }
        }
      }
    }

    return {
      node: result.item.node,
      fullPath: result.item.fullPath,
      skillMeta: result.item.skillMeta,
      score: result.score ?? 1,
      matches
    };
  });

  // Boost prefix matches (results where query is prefix of filename)
  const queryLower = trimmedQuery.toLowerCase();
  const queryNormalized = queryLower.replace(/-/g, '');
  for (const result of searchResults) {
    const nameLower = (result.node.name ?? '').toLowerCase();
    const nameNormalized = nameLower.replace(/-/g, '');
    
    // Check for word-component matches (e.g., "skill" in "write-skill.md")
    const nameComponents = nameLower.replace(/\.[^.]+$/, '').split(/[-_]/);
    const hasExactComponent = nameComponents.some(comp => comp === queryLower);
    const hasComponentPrefix = nameComponents.some(comp => comp.startsWith(queryLower));
    
    // Strong boost for prefix matches
    if (nameLower.startsWith(queryLower) || nameNormalized.startsWith(queryNormalized)) {
      result.score *= 0.5;
    }
    // Strong boost for exact word-component match (e.g., "skill" === "skill" in "write-skill")
    else if (hasExactComponent) {
      result.score *= 0.5;
    }
    // Moderate boost for component prefix match
    else if (hasComponentPrefix) {
      result.score *= 0.7;
    }
  }

  // Boost rebel-system paths (platform skills/docs are high-value)
  for (const result of searchResults) {
    if ((result.fullPath ?? '').startsWith('rebel-system/')) {
      result.score *= 0.85; // Small boost for platform content
    }
  }

  // Sort by score only - let boosts determine ranking, no file/directory bias
  searchResults.sort((a, b) => a.score - b.score);

  // Return limited results
  return searchResults.slice(0, limit);
};

/**
 * Perform fuzzy search on files and directories using fuse.js
 */
export const searchFiles = (
  query: string,
  files: FlatFileEntry[],
  options?: SearchFilesOptions
): SearchResult[] => {
  // Unsupported: query must be a string and files must be a concrete array. Passing undefined/null will throw.
  const fuse = createLibrarySearchFuse(files);
  return searchFilesWithFuse(query, files, fuse, options);
};

/**
 * Get recent files from localStorage
 */
export const getRecentFiles = (): string[] => {
  try {
    const stored = localStorage.getItem('library-recent-files');
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * Add file to recent files list
 */
export const addRecentFile = (filePath: string, maxItems = 10): void => {
  try {
    const current = getRecentFiles();
    const filtered = current.filter((path) => path !== filePath);
    const updated = [filePath, ...filtered].slice(0, maxItems);
    localStorage.setItem('library-recent-files', JSON.stringify(updated));
  } catch (error) {
    console.warn('Failed to save recent file:', error);
  }
};

/**
 * Clear all recent files
 */
export const clearRecentFiles = (): void => {
  try {
    localStorage.removeItem('library-recent-files');
  } catch (error) {
    console.warn('Failed to clear recent files:', error);
  }
};

/**
 * Highlight matching characters in text
 */
export const highlightMatches = (
  text: string,
  matches: Array<[number, number]>
): ReactElement => {
  if (matches.length === 0) {
    return <>{text}</>;
  }

  const parts: ReactElement[] = [];
  let lastIndex = 0;

  const sortedMatches = [...matches].sort((a, b) => a[0] - b[0]);

  for (let i = 0; i < sortedMatches.length; i++) {
    const [start, end] = sortedMatches[i];

    if (start > lastIndex) {
      parts.push(<span key={`text-${lastIndex}`}>{text.slice(lastIndex, start)}</span>);
    }

    parts.push(<mark key={`mark-${start}`}>{text.slice(start, end)}</mark>);
    lastIndex = end;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={`text-${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }

  return <>{parts}</>;
};
