/**
 * File Index Service — document parsing / chunking / indexability policy.
 *
 * Pure-ish helpers extracted from `fileIndexService/index.ts` (Stage B1).
 * Behavior-preserving move only: no logic changes. These functions have no
 * shared module-level state; the parent module re-exports the public symbols
 * (`extractDocumentFrontmatter`, `extractDocumentTitle`, `buildEmbeddingText`,
 * `shouldIndexFile`, `cosineDistance`) and imports the internal ones
 * (`chunkText`, `generateChunkId`, `calculateRecencyBoost`, `isSkillFile`)
 * back for use on the index/search paths.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { WORKSPACE_CONFLICT_MARKER } from '@shared/conflictPatterns';
import { toPortablePath } from '@core/utils/portablePath';
import { cosineDistance as sharedCosineDistance } from '@core/utils/vectorMath';
import fm from 'front-matter';

const MAX_CHUNK_SIZE = 2000; // Characters per chunk
const CHUNK_OVERLAP = 200; // Overlap between chunks
const MAX_TITLE_LENGTH = 200; // Max chars for extracted document title
const SPACE_PLUGIN_FILE_PATH_PATTERN = /(?:^|\/)plugins\/[^/]+\/.+/;

// Recency weighting configuration for search results
// Boosts recently modified files in ranking (acts as "working memory")
const RECENCY_BOOST = 0.15; // Max +15% boost for just-modified files
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days half-life

/**
 * Compute cosine distance between two vectors.
 * Re-exported from @core/utils/vectorMath for backward compatibility.
 */
export const cosineDistance = sharedCosineDistance;

/**
 * Calculate recency boost factor for a file based on its modification time.
 * Uses exponential decay with configurable half-life.
 *
 * @param mtime - File modification timestamp (ms since epoch)
 * @param nowMs - Current timestamp (ms since epoch), defaults to Date.now()
 * @returns Multiplier between 1.0 (no boost) and 1+RECENCY_BOOST (max boost)
 */
export function calculateRecencyBoost(mtime: number, nowMs: number = Date.now()): number {
  const ageMs = Math.max(0, nowMs - mtime); // Clamp to 0 for future mtimes (clock skew)
  const decayFactor = Math.pow(2, -ageMs / RECENCY_HALF_LIFE_MS);
  return 1 + RECENCY_BOOST * decayFactor;
}

/**
 * Check if a file path is a skill file (SKILL.md in a /skills/ directory).
 * Used to apply skill boost in search results.
 */
export function isSkillFile(relativePath: string): boolean {
  return relativePath.includes('/skills/') &&
         relativePath.toLowerCase().endsWith('skill.md');
}

export interface DocumentFrontmatter {
  title: string;
  description: string;
  tags: string[];
}

/** @internal Exported for testing */
export function extractDocumentFrontmatter(content: string): DocumentFrontmatter {
  const result: DocumentFrontmatter = { title: '', description: '', tags: [] };
  try {
    if (!fm.test(content)) return result;
    const { attributes } = fm<Record<string, unknown>>(content);

    const title = (attributes.title ?? attributes.name ?? '') as string;
    if (typeof title === 'string') {
      result.title = title.slice(0, MAX_TITLE_LENGTH).trim();
    }

    const desc = attributes.description;
    if (typeof desc === 'string' && desc.trim()) {
      result.description = desc.trim();
    }

    const tags = attributes.tags;
    if (Array.isArray(tags)) {
      result.tags = tags.filter((t): t is string => typeof t === 'string').slice(0, 10);
    }

    return result;
  } catch {
    return result;
  }
}

/** @internal Exported for testing — thin wrapper for backward compatibility */
export function extractDocumentTitle(content: string): string {
  return extractDocumentFrontmatter(content).title;
}

/** @internal Exported for testing */
export function buildEmbeddingText(
  title: string,
  relativePath: string,
  chunkContent: string,
  description?: string,
  tags?: string[],
): string {
  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (description) parts.push(`Description: ${description}`);
  if (relativePath) parts.push(`Path: ${relativePath}`);
  if (tags && tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);
  if (parts.length === 0) return chunkContent;
  return parts.join('\n') + '\n\n' + chunkContent;
}

/**
 * Generate a unique ID for a file chunk
 */
export function generateChunkId(filePath: string, chunkIndex: number): string {
  const hash = crypto.createHash('sha256').update(`${filePath}:${chunkIndex}`).digest('hex');
  return hash.slice(0, 32);
}

/**
 * Split text into overlapping chunks
 */
export function chunkText(text: string, maxSize: number = MAX_CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
  if (text.length <= maxSize) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxSize;

    if (end < text.length) {
      const lastNewline = text.lastIndexOf('\n', end);
      const lastSpace = text.lastIndexOf(' ', end);

      if (lastNewline > start + maxSize / 2) {
        end = lastNewline + 1;
      } else if (lastSpace > start + maxSize / 2) {
        end = lastSpace + 1;
      }
    }

    chunks.push(text.slice(start, end));
    start = end - overlap;

    if (start >= text.length) break;
  }

  return chunks;
}

/**
 * Check if a file should be indexed based on extension
 */
function isSpacePluginFile(filePath: string): boolean {
  const normalizedPath = toPortablePath(filePath);
  return SPACE_PLUGIN_FILE_PATH_PATTERN.test(normalizedPath);
}

/**
 * Check if a file should be indexed based on path/extension.
 *
 * Exported so callers that need to pre-classify files (e.g. the eval bootstrap
 * cache-hit overlay loop) can distinguish "skipped by indexing policy" from
 * "indexer returned 0 chunks for content-bearing input" — the latter is a real
 * failure mode, the former is expected behaviour for non-indexable extensions.
 */
export function shouldIndexFile(filePath: string): boolean {
  // Space plugins are indexed explicitly on activation/deactivation.
  // Exclude all files under /plugins/{slug}/ from general auto-indexing.
  if (isSpacePluginFile(filePath)) {
    return false;
  }

  // Exclude Rebel cloud-sync conflict copies. These are duplicate files created
  // when local and cloud edits diverge; indexing them inflates the search index
  // with duplicate content and degrades semantic retrieval quality.
  // Only targets Rebel's own `.conflict-cloud` marker — broader patterns
  // (numbered copies, "Copy of ...") can match legitimate user files.
  if (path.basename(filePath).includes(WORKSPACE_CONFLICT_MARKER)) {
    return false;
  }

  const indexableExtensions = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.json',
    '.md',
    '.mdx',
    '.txt',
    '.freex', // Freex notes (plain text)
    '.yaml',
    '.yml',
    '.css',
    '.scss',
    '.less',
    '.html',
    '.htm',
    '.xml',
    '.svg',
    '.py',
    '.rb',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.swift',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.php',
    '.sql',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.ps1',
    '.dockerfile',
    '.toml',
    '.gitignore',
    '.eslintrc',
    '.prettierrc'
    // NOTE: .env, .ini, .cfg, .conf excluded - may contain secrets
  ]);

  // Files that should NEVER be indexed (secrets/credentials)
  const secretPatterns = [
    /^\.env/, // .env, .env.local, .env.development, etc.
    /\.pem$/,
    /\.key$/,
    /\.crt$/,
    /\.p12$/,
    /\.pfx$/,
    /id_rsa/,
    /id_ed25519/,
    /\.secret/,
    /credentials/i,
    /secrets?\./i,
  ];

  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();

  // Check if file matches secret patterns - reject if so
  for (const pattern of secretPatterns) {
    if (pattern.test(basename)) {
      return false;
    }
  }

  if (indexableExtensions.has(ext)) {
    return true;
  }

  const indexableNames = new Set([
    'dockerfile',
    'makefile',
    'rakefile',
    'gemfile',
    'procfile',
    'readme',
    'license',
    'changelog',
    'contributing',
    'authors'
  ]);

  return indexableNames.has(basename);
}
