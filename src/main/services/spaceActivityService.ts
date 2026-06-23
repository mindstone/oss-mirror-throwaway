/**
 * Space Activity Service
 *
 * Aggregates activity (memory updates, skill changes) across all spaces
 * for The Spark's "Spaces" tab.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { relativePortablePath, toPortablePath } from '@core/utils/portablePath';
import { scanSpaces, getSpaceDisplayName, type SpaceInfo } from './spaceService';
import { getMemoryHistory } from './memoryHistoryStore';
import type { SpaceType, MemoryHistoryEntry } from '@shared/types';

const log = createScopedLogger({ service: 'spaceActivity' });

const MAX_PREVIEW_ITEMS = 3;

export interface MemoryPreview {
  summary: string;
  timestamp: number;
  action: 'created' | 'updated';
  filePath?: string;
}

export interface SkillPreview {
  name: string;
  timestamp: number;
  filePath: string;
}

export interface SpaceActivity {
  spacePath: string;
  displayName: string;
  spaceType: SpaceType;
  memoryCount: number;
  skillCount: number;
  lastActivityAt: number | null;
  isSymlink?: boolean;
  recentMemories: MemoryPreview[];
  recentSkills: SkillPreview[];
}

export interface SpaceActivityResult {
  spaces: SpaceActivity[];
  totalMemoryCount: number;
  totalSkillCount: number;
}

// Use centralized getSpaceDisplayName from spaceService

interface SkillFileInfo {
  name: string;
  mtime: number;
  relativePath: string;
}

/**
 * Recursively find all skill files in a directory and their modification times.
 */
// bounded-walker-pending: see docs/plans/260503_s9_bounded_walker_resource_budget.md
async function findSkillFiles(
  dir: string,
  workspaceRoot: string,
  cutoffTime: number,
  maxDepth = 10,
  currentDepth = 0
): Promise<{ skills: SkillFileInfo[]; latestMtime: number | null }> {
  if (currentDepth > maxDepth) {
    return { skills: [], latestMtime: null };
  }

  const skills: SkillFileInfo[] = [];
  let latestMtime: number | null = null;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      if (entry.name.toLowerCase() === 'archive') continue;

      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Check for SKILL.md (folder-based skill)
        const skillMdPath = path.join(entryPath, 'SKILL.md');
        try {
          const stat = await fs.stat(skillMdPath);
          const mtime = stat.mtimeMs;
          if (mtime >= cutoffTime) {
            const relativePath = relativePortablePath(workspaceRoot, skillMdPath);
            skills.push({ name: entry.name, mtime, relativePath });
            if (latestMtime === null || mtime > latestMtime) {
              latestMtime = mtime;
            }
          }
          // Don't recurse into skill folders
          continue;
        } catch {
          // No SKILL.md, recurse
        }

        const nested = await findSkillFiles(entryPath, workspaceRoot, cutoffTime, maxDepth, currentDepth + 1);
        skills.push(...nested.skills);
        if (nested.latestMtime !== null) {
          if (latestMtime === null || nested.latestMtime > latestMtime) {
            latestMtime = nested.latestMtime;
          }
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Skip common non-skill files
        const skipFiles = new Set(['README.md', 'index.md', 'SKILLS-MENU.md']);
        if (skipFiles.has(entry.name)) continue;

        const stat = await fs.stat(entryPath);
        const mtime = stat.mtimeMs;
        if (mtime >= cutoffTime) {
          // Use filename without extension as skill name
          const skillName = entry.name.replace(/\.md$/, '');
          const relativePath = relativePortablePath(workspaceRoot, entryPath);
          skills.push({ name: skillName, mtime, relativePath });
          if (latestMtime === null || mtime > latestMtime) {
            latestMtime = mtime;
          }
        }
      }
    }
  } catch {
    // Directory not readable
  }

  return { skills, latestMtime };
}

/**
 * Get activity summary for all spaces in the workspace.
 */
export async function getSpaceActivity(
  workspacePath: string,
  dayWindow = 7
): Promise<SpaceActivityResult> {
  if (!workspacePath) {
    log.warn('getSpaceActivity called with empty workspacePath');
    return { spaces: [], totalMemoryCount: 0, totalSkillCount: 0 };
  }

  const cutoffTime = Date.now() - dayWindow * 24 * 60 * 60 * 1000;

  // Get all spaces.
  // Read-only: activity scoring must not mutate frontmatter.
  // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
  const spaces = await scanSpaces(workspacePath, { skipAutoFix: true });

  // Get memory history for the time window
  const { entries: memoryEntries } = getMemoryHistory({
    limit: 1000, // Get all recent entries
  });

  // Filter to entries within the time window
  const recentMemories = memoryEntries.filter((e) => e.timestamp >= cutoffTime);

  // Group memories by space path, keeping the actual entries
  const memoryBySpace = new Map<string, { entries: MemoryHistoryEntry[]; lastTimestamp: number }>();
  for (const entry of recentMemories) {
    // Match memory entry to space based on file path
    const spacePath = matchMemoryToSpace(entry.filePath, spaces);
    if (!spacePath) continue;

    const existing = memoryBySpace.get(spacePath);
    if (existing) {
      existing.entries.push(entry);
      if (entry.timestamp > existing.lastTimestamp) {
        existing.lastTimestamp = entry.timestamp;
      }
    } else {
      memoryBySpace.set(spacePath, { entries: [entry], lastTimestamp: entry.timestamp });
    }
  }

  // Build activity summary for each space
  const spaceActivities: SpaceActivity[] = [];
  let totalMemoryCount = 0;
  let totalSkillCount = 0;

  for (const space of spaces) {
    // Get memory activity for this space
    const memoryData = memoryBySpace.get(space.path);
    const memoryEntries = memoryData?.entries ?? [];
    const memoryCount = memoryEntries.length;
    const memoryLastActivity = memoryData?.lastTimestamp ?? null;

    // Build memory previews (most recent first, up to MAX_PREVIEW_ITEMS)
    const recentMemoryPreviews: MemoryPreview[] = memoryEntries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_PREVIEW_ITEMS)
      .map((e) => ({
        summary: e.summary,
        timestamp: e.timestamp,
        action: e.action,
        filePath: e.filePath,
      }));

    // Get skill activity for this space
    const skillsDir = path.join(space.absolutePath, 'skills');
    let skillFiles: SkillFileInfo[] = [];
    let skillLastActivity: number | null = null;

    try {
      await fs.access(skillsDir);
      const skillResult = await findSkillFiles(skillsDir, workspacePath, cutoffTime);
      skillFiles = skillResult.skills;
      skillLastActivity = skillResult.latestMtime;
    } catch {
      // No skills directory
    }

    const skillCount = skillFiles.length;

    // Build skill previews (most recent first, up to MAX_PREVIEW_ITEMS)
    const recentSkillPreviews: SkillPreview[] = skillFiles
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_PREVIEW_ITEMS)
      .map((s) => ({
        name: s.name,
        timestamp: s.mtime,
        filePath: s.relativePath,
      }));

    // Determine last activity timestamp
    let lastActivityAt: number | null = null;
    if (memoryLastActivity !== null && skillLastActivity !== null) {
      lastActivityAt = Math.max(memoryLastActivity, skillLastActivity);
    } else if (memoryLastActivity !== null) {
      lastActivityAt = memoryLastActivity;
    } else if (skillLastActivity !== null) {
      lastActivityAt = skillLastActivity;
    }

    // Only include spaces with activity
    if (memoryCount > 0 || skillCount > 0) {
      spaceActivities.push({
        spacePath: space.path,
        displayName: getSpaceDisplayName(space),
        spaceType: space.type,
        memoryCount,
        skillCount,
        lastActivityAt,
        isSymlink: space.isSymlink,
        recentMemories: recentMemoryPreviews,
        recentSkills: recentSkillPreviews,
      });

      totalMemoryCount += memoryCount;
      totalSkillCount += skillCount;
    }
  }

  // Sort by last activity (most recent first)
  spaceActivities.sort((a, b) => {
    if (a.lastActivityAt === null && b.lastActivityAt === null) return 0;
    if (a.lastActivityAt === null) return 1;
    if (b.lastActivityAt === null) return -1;
    return b.lastActivityAt - a.lastActivityAt;
  });

  log.info(
    { spaceCount: spaceActivities.length, totalMemoryCount, totalSkillCount, dayWindow },
    'Computed space activity'
  );

  return { spaces: spaceActivities, totalMemoryCount, totalSkillCount };
}

/**
 * Match a memory file path to a space.
 */
function matchMemoryToSpace(filePath: string | undefined, spaces: SpaceInfo[]): string | null {
  if (!filePath) return null;

  const normalized = toPortablePath(filePath).toLowerCase();

  // Find the best matching space (longest path prefix match)
  let bestMatch: SpaceInfo | null = null;

  for (const space of spaces) {
    const spacePath = space.path.toLowerCase();
    if (normalized.startsWith(spacePath + '/')) {
      if (!bestMatch || spacePath.length > bestMatch.path.length) {
        bestMatch = space;
      }
    }
  }

  return bestMatch?.path ?? null;
}
