import type { FlatFileEntry } from './librarySearch';

/** Pattern for space-level skill directories (Chief-of-Staff, Personal, work spaces) */
export const SPACE_SKILLS_PATTERN = /^(Chief-of-Staff|Personal|work[\\/][^\\/]+[\\/][^\\/]+)[\\/]skills([\\/]|$)/i;

/** Pattern for platform-level skill directories (rebel-system) */
export const PLATFORM_SKILLS_PATTERN = /^rebel-system[\\/]skills([\\/]|$)/i;

/** Pattern for workspace-level skill directories (skills/ at root) */
export const WORKSPACE_SKILLS_PATTERN = /^skills([\\/]|$)/i;

/**
 * Check if a path is within a recognized skill directory.
 */
export const isSkillPath = (path: string): boolean =>
  SPACE_SKILLS_PATTERN.test(path) || PLATFORM_SKILLS_PATTERN.test(path) || WORKSPACE_SKILLS_PATTERN.test(path);

/**
 * Check if a library/search entry represents a skill.
 * `skillMeta` comes from the canonical skill scanner and catches valid skills
 * outside the older path-based conventions.
 */
export const isSkillEntry = (entry: Pick<FlatFileEntry, 'fullPath' | 'skillMeta'>): boolean =>
  Boolean(entry.skillMeta) || isSkillPath(entry.fullPath);

/**
 * Check if this entry is a SKILL.md file inside a skill folder.
 * These should be hidden from search/selection results (user selects the folder instead).
 */
export const isHiddenSkillMd = (entry: FlatFileEntry): boolean => {
  if (entry.node.kind !== 'file') return false;
  if (entry.node.name !== 'SKILL.md') return false;
  return isSkillPath(entry.fullPath);
};

/** Pattern matching "memory" as a complete path segment (case-insensitive) */
const MEMORY_PATH_REGEX = /(^|[\\/])memory([\\/]|$)/i;

/**
 * Check if a path is within a memory directory.
 * Memory folders can exist in any space and are used for agent-managed content.
 */
export const isMemoryPath = (path: string): boolean => MEMORY_PATH_REGEX.test(path);
