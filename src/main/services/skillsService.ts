/**
 * Skills Service
 *
 * Scans workspace for skill files and parses their frontmatter.
 * Skills are markdown files in `skills/` directories with YAML frontmatter.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fm from 'front-matter';
import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import { relativePortablePath } from '@core/utils/portablePath';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import type { ExampleMeta } from '@core/skillQualityScore';
import { scanSpaces, getSpaceDisplayName } from './spaceService';

const log = createScopedLogger({ service: 'skills' });

/**
 * Infer storage provider from symlink source path.
 */
function inferStorageProvider(sourcePath: string): SkillsGroup['storageProvider'] {
  const lowerPath = sourcePath.toLowerCase();
  if (lowerPath.includes('google') && lowerPath.includes('drive')) {
    return 'google_drive';
  } else if (lowerPath.includes('onedrive')) {
    return 'onedrive';
  } else if (lowerPath.includes('dropbox')) {
    return 'dropbox';
  } else if (/[/\\]box[/\\]/i.test(sourcePath) || lowerPath.includes('box.com')) {
    return 'box';
  } else if (lowerPath.includes('icloud') || lowerPath.includes('mobile documents')) {
    return 'icloud';
  }
  return 'other';
}

/**
 * Schema for skill frontmatter validation.
 * Based on actual skill files in rebel-system/skills/.
 */
const OutputShapeContractSchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
  z.object({
    default_surface: z.enum([
      'chat_summary',
      'chat_answer',
      'file_artifact',
      'interactive_view',
      'expandable_report',
    ]).optional().catch(undefined),
    chat_contract: z.enum([
      'concise_summary',
      'direct_answer',
      'decision_brief',
      'blocker_only',
    ]).optional().catch(undefined),
    artifact_expected: z.boolean().optional().catch(undefined),
    max_chat_words: z.number().int().positive().max(2_000).optional().catch(undefined),
    source_policy: z.enum([
      'inline_key_sources',
      'artifact_sources',
      'none',
    ]).optional().catch(undefined),
  }).strip().optional(),
);

export const SkillFrontmatterSchema = z.object({
  description: z.string(),
  name: z.string().optional(),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  use_cases: z.array(z.string()).optional(),
  last_updated: z.string().optional(),
  tools_required: z.array(z.string()).optional(),
  agent_type: z.enum(['main_agent', 'subagent']).optional(),
  dependencies: z.array(z.string()).optional(),
  /** Path to the skill this one extends (e.g., "rebel-system/skills/meetings/meeting-prep/SKILL.md") */
  extends: z.string().optional(),
  /** How this skill relates to the base: overlay (merge) or replace (shadow) */
  extension_type: z.enum(['overlay', 'replace']).optional(),
  /** Original creator of the skill (name or email) */
  author: z.string().optional(),
  /** Stable auth ID for the original creator */
  author_id: z.string().optional(),
  /** Notification/routing email for the original creator */
  author_email: z.string().optional(),
  /** How the author attribution was established */
  author_source: z.enum(['created', 'migrated', 'confirmed']).optional(),
  /** People who have improved this skill - shown on thank you board */
  contributed: z.array(z.string()).optional(),
  /** Stable auth IDs for everyone who has contributed via Rebel */
  contributors: z.array(z.string()).optional(),
  /** Most recent person to edit this skill */
  last_modified_by: z.string().optional(),
  /** Stable auth ID for the most recent modifier */
  last_modified_by_id: z.string().optional(),
  /** Email for the most recent human modifier, when applicable */
  last_modified_by_email: z.string().optional(),
  /** ISO date of last modification (YYYY-MM-DD) */
  last_modified_at: z.string().optional(),
  /** Extra actor context such as "from Anna Maria's input" */
  last_modified_context: z.string().optional(),
  /** Type of coach skill for filtering in coach picker (e.g., 'meeting') */
  coach_type: z.string().optional(),
  /** Proactive analysis interval in minutes for coach skills (default: 2) */
  proactive_interval_minutes: z.number().optional(),
  /** Optional output-routing contract for artifact-shaped skills. */
  output_shape: OutputShapeContractSchema,
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/**
 * Information about a single skill file.
 */
export interface SkillInfo {
  /** Skill file name without extension */
  name: string;
  /** Relative path from workspace root */
  relativePath: string;
  /** Absolute path on disk */
  absolutePath: string;
  /** Category (folder name within skills/) */
  category: string;
  /** Parsed frontmatter (if valid) */
  frontmatter?: SkillFrontmatter;
  /** Convenience accessor for model recommendation */
  model?: string;
  /** Convenience accessor for effort recommendation */
  effort?: SkillFrontmatter['effort'];
  /** Whether frontmatter was successfully parsed */
  hasFrontmatter: boolean;
  /** List of example file paths relative to workspace root (if examples/ folder exists) */
  examples?: string[];
  /** Quality score from skill scoring engine (0-100) */
  qualityScore?: number;
  /** Quality band label derived from score */
  qualityBand?: 'seedling' | 'growing' | 'solid' | 'exemplary';
  /** Highest-impact improvement suggestion for this skill */
  qualityTopImprovement?: {
    dimension: string;
    suggestion: string;
  };
  /** Raw markdown body content for main-process quality scoring (not sent over IPC) */
  bodyText?: string;
}

/**
 * Grouped skills by source location.
 */
export interface SkillsGroup {
  /** Source identifier (e.g., 'platform', 'personal', 'work/CompanyName') */
  source: string;
  /** Display label for UI */
  label: string;
  /** Type of source */
  type: 'platform' | 'space' | 'workspace';
  /** Skills in this group, organized by category */
  categories: Record<string, SkillInfo[]>;
  /** Total skill count in this group */
  count: number;
  /** Whether this is a built-in/read-only source (platform skills) */
  isBuiltIn?: boolean;
  /** Relative path within workspace for display */
  relativePath?: string;
  /** Absolute path on disk */
  absolutePath?: string;
  /** Whether this source is a symlink */
  isSymlink?: boolean;
  /** Storage provider for symlinked sources (google_drive, onedrive, dropbox, etc.) */
  storageProvider?: 'google_drive' | 'onedrive' | 'dropbox' | 'box' | 'icloud' | 'local' | 'other';
  /** Sharing level (private, restricted/team, company-wide, public) */
  sharing?: 'private' | 'restricted' | 'team' | 'company-wide' | 'public';
}

/**
 * Result of scanning for skills.
 */
export interface SkillsScanResult {
  groups: SkillsGroup[];
  totalCount: number;
}

/**
 * Parse and normalize frontmatter attributes from a skill file.
 */
function parseSkillFrontmatter(attributes: unknown): SkillFrontmatter | undefined {
  if (!attributes || typeof attributes !== 'object') {
    return undefined;
  }

  const result = SkillFrontmatterSchema.safeParse(attributes);
  if (result.success) {
    return result.data;
  }

  // Try partial extraction if full validation fails
  const attrs = attributes as Record<string, unknown>;
  if (attrs.description && typeof attrs.description === 'string') {
    // Extract contributed array - handle both string[] and object[] formats
    let contributed: string[] | undefined;
    if (Array.isArray(attrs.contributed)) {
      contributed = attrs.contributed
        .map((c) => {
          if (typeof c === 'string') return c;
          // Handle object format: { role: ..., entity: ... } or { name: ... }
          if (typeof c === 'object' && c !== null) {
            const obj = c as Record<string, unknown>;
            if (typeof obj.entity === 'string') return obj.entity;
            if (typeof obj.name === 'string') return obj.name;
          }
          return null;
        })
        .filter((s): s is string => s !== null);
    }

    return {
      description: attrs.description,
      name: typeof attrs.name === 'string' ? attrs.name : undefined,
      model: typeof attrs.model === 'string' ? attrs.model : undefined,
      effort:
        attrs.effort === 'low' ||
        attrs.effort === 'medium' ||
        attrs.effort === 'high' ||
        attrs.effort === 'max'
          ? attrs.effort
          : undefined,
      use_cases: Array.isArray(attrs.use_cases)
        ? attrs.use_cases.filter((s): s is string => typeof s === 'string')
        : undefined,
      last_updated: typeof attrs.last_updated === 'string' ? attrs.last_updated : undefined,
      tools_required: Array.isArray(attrs.tools_required)
        ? attrs.tools_required.filter((s): s is string => typeof s === 'string')
        : undefined,
      agent_type:
        attrs.agent_type === 'main_agent' || attrs.agent_type === 'subagent'
          ? attrs.agent_type
          : undefined,
      dependencies: Array.isArray(attrs.dependencies)
        ? attrs.dependencies.filter((s): s is string => typeof s === 'string')
        : undefined,
      // Attribution fields
      extends: typeof attrs.extends === 'string' ? attrs.extends : undefined,
      extension_type:
        attrs.extension_type === 'overlay' || attrs.extension_type === 'replace'
          ? attrs.extension_type
          : undefined,
      author: typeof attrs.author === 'string' ? attrs.author : undefined,
      author_id: typeof attrs.author_id === 'string' ? attrs.author_id : undefined,
      author_email: typeof attrs.author_email === 'string' ? attrs.author_email : undefined,
      author_source:
        attrs.author_source === 'created' || attrs.author_source === 'migrated' || attrs.author_source === 'confirmed'
          ? attrs.author_source
          : undefined,
      contributed: contributed?.length ? contributed : undefined,
      contributors: Array.isArray(attrs.contributors)
        ? attrs.contributors.filter((s): s is string => typeof s === 'string')
        : undefined,
      last_modified_by: typeof attrs.last_modified_by === 'string' ? attrs.last_modified_by : undefined,
      last_modified_by_id: typeof attrs.last_modified_by_id === 'string' ? attrs.last_modified_by_id : undefined,
      last_modified_by_email: typeof attrs.last_modified_by_email === 'string' ? attrs.last_modified_by_email : undefined,
      last_modified_at: typeof attrs.last_modified_at === 'string' ? attrs.last_modified_at : undefined,
      last_modified_context: typeof attrs.last_modified_context === 'string' ? attrs.last_modified_context : undefined,
      output_shape: OutputShapeContractSchema.parse(attrs.output_shape),
    };
  }

  return undefined;
}

export function parseSkillFrontmatterFromContent(content: string): SkillFrontmatter | null {
  try {
    const parsed = fm(content);
    return parseSkillFrontmatter(parsed.attributes) ?? null;
  } catch {
    return null;
  }
}

interface SkillFileData {
  frontmatter?: SkillFrontmatter;
  bodyText: string;
}

/**
 * Read and parse frontmatter + body text from a skill file.
 */
async function readSkillFile(filePath: string): Promise<SkillFileData | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = fm(content);
    return {
      frontmatter: parseSkillFrontmatterFromContent(content) ?? undefined,
      bodyText: typeof parsed.body === 'string' ? parsed.body : '',
    };
  } catch {
    return undefined;
  }
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export async function parseExampleMeta(
  exampleAbsPath: string,
  workspaceRoot: string
): Promise<ExampleMeta> {
  const relativePath = relativePortablePath(workspaceRoot, exampleAbsPath);

  try {
    const [content, stat] = await Promise.all([
      fs.readFile(exampleAbsPath, 'utf-8'),
      fs.stat(exampleAbsPath),
    ]);

    const parsed = fm(content);
    const attrs = parsed.attributes as Record<string, unknown> | null;

    return {
      path: relativePath,
      description: typeof attrs?.description === 'string' ? attrs.description : undefined,
      type: attrs?.type === 'counter-example' ? 'counter-example' : 'positive',
      hasFrontmatter: attrs !== null && typeof attrs === 'object' && Object.keys(attrs).length > 0,
      lastModifiedMs: stat.mtimeMs,
    };
  } catch {
    return {
      path: relativePath,
      type: 'positive',
      hasFrontmatter: false,
    };
  }
}

export async function getExampleMetas(
  skillRelativePath: string,
  workspacePath: string
): Promise<ExampleMeta[]> {
  if (!skillRelativePath || !workspacePath) {
    return [];
  }

  const workspaceRoot = path.resolve(workspacePath);
  const skillAbsolutePath = path.resolve(workspaceRoot, skillRelativePath);

  if (!isPathInsideRoot(skillAbsolutePath, workspaceRoot)) {
    return [];
  }

  const isFolderBasedSkill = path.basename(skillAbsolutePath).toLowerCase() === 'skill.md';
  if (!isFolderBasedSkill) {
    return [];
  }

  const examplesDir = path.join(path.dirname(skillAbsolutePath), 'examples');

  try {
    const exampleEntries = await fs.readdir(examplesDir, { withFileTypes: true });
    const exampleFiles = exampleEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(examplesDir, entry.name))
      .sort((leftPath, rightPath) => leftPath.localeCompare(rightPath));

    return Promise.all(
      exampleFiles.map((exampleFilePath) => parseExampleMeta(exampleFilePath, workspaceRoot))
    );
  } catch (err) {
    // No examples/ directory (ENOENT) is the normal case — recover silently.
    // Any other failure (a parse/read collapse inside parseExampleMeta) masking
    // itself as "no examples" is the dangerous case — surface it before falling
    // back to an empty list (behavior preserved).
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, examplesDir }, 'Failed to read skill examples — treating as none (examples will appear missing)');
    }
    return [];
  }
}

/**
 * Recursively find all skills within a directory.
 * Supports two formats:
 * 1. Folder-based (Anthropic convention): skill-name/SKILL.md
 * 2. File-based (simpler convention): category/skill-name.md
 */
/**
 * Files to skip when detecting file-based skills.
 */
const FLAT_SKILL_SKIP_FILES = new Set(['README.md', 'index.md', 'SKILLS-MENU.md']);

async function findSkills(
  dir: string,
  workspaceRoot: string,
  skillsRootDir: string,
  maxDepth: number = 10,
): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];

  // Backed by safeWalkDirectory so cycle/depth/path-length protection
  // applies. Pre-fix this walker only had a depth cap, leaving it open
  // to symlink/realdir loops (REBEL-506).
  await safeWalkDirectory(dir, {
    maxDepth,
    onDirectory: async ({ absolutePath, name }) => {
      // Skip hidden files/folders and common non-skill directories.
      if (name.startsWith('.')) return false;
      if (name === 'node_modules') return false;
      if (name.toLowerCase() === 'archive') return false;
      if (name.toLowerCase() === 'obsolete') return false;

      const skillMdPath = path.join(absolutePath, 'SKILL.md');
      let hasSkillMd = false;
      try {
        await fs.access(skillMdPath);
        hasSkillMd = true;
      } catch {
        // No SKILL.md here, descend into subdirectories.
      }

      if (!hasSkillMd) return true;

      // This is a skill folder!
      const skillFile = await readSkillFile(skillMdPath);
      const frontmatter = skillFile?.frontmatter;

      // Derive category from the path between skillsRootDir and the skill folder.
      const relativeToSkillsRoot = relativePortablePath(skillsRootDir, absolutePath);
      const pathParts = relativeToSkillsRoot.split('/');
      const category = pathParts.length > 1
        ? pathParts.slice(0, -1).join('/')
        : 'uncategorized';

      // Check for examples folder.
      let examples: string[] | undefined;
      const examplesDir = path.join(absolutePath, 'examples');
      try {
        const exampleEntries = await fs.readdir(examplesDir, { withFileTypes: true });
        examples = exampleEntries
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => relativePortablePath(workspaceRoot, path.join(examplesDir, e.name)));
        if (examples.length === 0) examples = undefined;
      } catch {
        // No examples folder, that's fine.
      }

      skills.push({
        name,
        relativePath: relativePortablePath(workspaceRoot, skillMdPath),
        absolutePath: skillMdPath,
        category,
        frontmatter,
        model: frontmatter?.model,
        effort: frontmatter?.effort,
        hasFrontmatter: frontmatter !== undefined,
        examples,
        bodyText: skillFile?.bodyText,
      });

      // Skill folder is a leaf — don't recurse into it.
      return false;
    },
    onFile: async ({ absolutePath, name, parentDir }) => {
      // Handle file-based skills (*.md files that aren't in a SKILL.md folder).
      if (!name.endsWith('.md')) return;
      if (FLAT_SKILL_SKIP_FILES.has(name)) return;

      const skillFile = await readSkillFile(absolutePath);
      const frontmatter = skillFile?.frontmatter;

      // Derive category from the path between skillsRootDir and the file's directory.
      const relativeToSkillsRoot = relativePortablePath(skillsRootDir, parentDir);
      const category = relativeToSkillsRoot || 'uncategorized';

      const skillName = name.replace(/\.md$/, '');

      skills.push({
        name: skillName,
        relativePath: relativePortablePath(workspaceRoot, absolutePath),
        absolutePath,
        category,
        frontmatter,
        model: frontmatter?.model,
        effort: frontmatter?.effort,
        hasFrontmatter: frontmatter !== undefined,
        bodyText: skillFile?.bodyText,
      });
    },
    onTruncated: ({ reasons, entriesVisited }) => {
      log.debug(
        { skillsRoot: dir, reasons, entriesVisited },
        'findSkills hit a traversal cap — skill discovery may be incomplete',
      );
    },
  });

  return skills;
}

/**
 * Scan a skills directory and return all skills grouped by category.
 * Supports two skill formats:
 * 1. Folder-based (Anthropic convention): skill-name/SKILL.md
 * 2. File-based: category/skill-name.md
 */
async function scanSkillsDirectory(
  skillsDir: string,
  workspaceRoot: string
): Promise<{ category: string; skills: SkillInfo[] }[]> {
  const allSkills = await findSkills(skillsDir, workspaceRoot, skillsDir);
  
  // Group skills by category
  const categoryMap = new Map<string, SkillInfo[]>();
  
  for (const skill of allSkills) {
    const existing = categoryMap.get(skill.category);
    if (existing) {
      existing.push(skill);
    } else {
      categoryMap.set(skill.category, [skill]);
    }
  }

  // Convert to array format
  const results: { category: string; skills: SkillInfo[] }[] = [];
  for (const [category, skills] of categoryMap) {
    results.push({ category, skills });
  }

  return results;
}

/**
 * Scan the workspace for all skills across platform, spaces, and workspace root.
 */
export async function scanSkills(workspacePath: string): Promise<SkillsScanResult> {
  const groups: SkillsGroup[] = [];
  let totalCount = 0;

  if (!workspacePath) {
    log.warn('scanSkills called with empty workspacePath');
    return { groups, totalCount };
  }

  const root = path.resolve(workspacePath);

  // Check if workspace exists
  try {
    await fs.access(root);
  } catch {
    log.warn({ root }, 'Workspace path does not exist');
    return { groups, totalCount };
  }

  // 1. Scan platform skills (rebel-system/skills/)
  const platformSkillsDir = path.join(root, 'rebel-system', 'skills');
  try {
    await fs.access(platformSkillsDir);
    const platformCategories = await scanSkillsDirectory(platformSkillsDir, root);
    if (platformCategories.length > 0) {
      const categories: Record<string, SkillInfo[]> = {};
      let count = 0;
      for (const { category, skills } of platformCategories) {
        categories[category] = skills;
        count += skills.length;
      }
      groups.push({
        source: 'platform',
        label: 'Rebel system',
        type: 'platform',
        categories,
        count,
        isBuiltIn: true,
        relativePath: 'rebel-system/skills',
        absolutePath: platformSkillsDir,
      });
      totalCount += count;
    }
  } catch {
    // Platform skills directory doesn't exist
  }

  // 2. Scan workspace root skills/ (if exists)
  const workspaceSkillsDir = path.join(root, 'skills');
  try {
    const stat = await fs.stat(workspaceSkillsDir);
    if (stat.isDirectory()) {
      const workspaceCategories = await scanSkillsDirectory(workspaceSkillsDir, root);
      if (workspaceCategories.length > 0) {
        const categories: Record<string, SkillInfo[]> = {};
        let count = 0;
        for (const { category, skills } of workspaceCategories) {
          categories[category] = skills;
          count += skills.length;
        }
        groups.push({
          source: 'workspace',
          label: 'Workspace',
          type: 'workspace',
          categories,
          count,
          relativePath: 'skills',
          absolutePath: workspaceSkillsDir,
        });
        totalCount += count;
      }
    }
  } catch {
    // Workspace skills directory doesn't exist
  }

  // 3. Scan space skills using canonical space discovery from spaceService.
  // Read-only: skill enumeration must not mutate frontmatter.
  // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
  const spaces = await scanSpaces(workspacePath, { skipAutoFix: true });
  
  for (const space of spaces) {
    const spaceSkillsDir = path.join(space.absolutePath, 'skills');
    try {
      const stat = await fs.stat(spaceSkillsDir);
      if (!stat.isDirectory()) continue;

      const spaceCategories = await scanSkillsDirectory(spaceSkillsDir, root);
      // Include spaces even if they have 0 skills (as long as they have a skills/ directory)
      const categories: Record<string, SkillInfo[]> = {};
      let count = 0;
      for (const { category, skills } of spaceCategories) {
        categories[category] = skills;
        count += skills.length;
      }

      // Get space metadata from SpaceInfo (already computed by scanSpaces)
      let storageProvider: SkillsGroup['storageProvider'];
      if (space.isSymlink && space.sourcePath) {
        storageProvider = inferStorageProvider(space.sourcePath);
      }

      // Use sharing level from frontmatter only - don't guess
      const validSharingLevels = ['private', 'restricted', 'team', 'company-wide', 'public'] as const;
      const sharing: SkillsGroup['sharing'] = 
        space.sharing && validSharingLevels.includes(space.sharing as typeof validSharingLevels[number])
          ? (space.sharing as SkillsGroup['sharing'])
          : undefined;

      // Use display name from frontmatter, falling back to type-based defaults or folder name
      const label = getSpaceDisplayName(space);

      groups.push({
        source: space.path,
        label,
        type: 'space',
        categories,
        count,
        relativePath: `${space.path}/skills`,
        absolutePath: spaceSkillsDir,
        isSymlink: space.isSymlink,
        storageProvider,
        sharing,
      });
      totalCount += count;
    } catch {
      // Space skills directory doesn't exist - skip this space
    }
  }

  log.info({ totalCount, groupCount: groups.length }, 'Scanned workspace for skills');
  return { groups, totalCount };
}
