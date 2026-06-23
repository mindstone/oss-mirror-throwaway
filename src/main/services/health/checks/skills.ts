/**
 * Skills Convention Health Check
 *
 * Validates that bundled skills (rebel-system) follow the Anthropic folder convention:
 * - Skills are folders containing SKILL.md or AUTOMATION.md (not flat .md files)
 * - Entry file has required frontmatter (name, description)
 * - name field matches folder name (lowercase-hyphen)
 *
 * Since this check only scans bundled/read-only skills, all issues are capped
 * at 'warning' severity — users cannot fix them.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import fm from 'front-matter';
import { getSystemSettingsPath } from '../../systemSettingsSync';
import { createScopedLogger } from '@core/logger';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import type { CheckResult } from '../types';

const log = createScopedLogger({ service: 'healthCheck:skills' });

interface SkillIssue {
  path: string;
  issue: string;
  severity: 'warning';
}

interface SkillValidationResult {
  totalSkills: number;
  validSkills: number;
  issues: SkillIssue[];
}

/** Recognized entry file names for skill/automation folders */
const ENTRY_FILE_NAMES = ['SKILL.md', 'AUTOMATION.md'] as const;

/**
 * Find the entry file (SKILL.md or AUTOMATION.md) in a skill folder.
 * Returns the filename if found, null otherwise.
 */
async function findEntryFile(dirPath: string): Promise<string | null> {
  for (const fileName of ENTRY_FILE_NAMES) {
    try {
      await fs.access(path.join(dirPath, fileName));
      return fileName;
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * Validate a single skill/automation folder.
 *
 * All issues are capped at 'warning' because this check only scans
 * bundled (rebel-system) skills which users cannot modify.
 */
async function validateSkillFolder(
  skillPath: string,
  folderName: string,
  relativePath: string,
  entryFileName: string = 'SKILL.md'
): Promise<SkillIssue[]> {
  const issues: SkillIssue[] = [];
  const entryFilePath = path.join(skillPath, entryFileName);
  const entryRelPath = `${relativePath}/${entryFileName}`;

  try {
    await fs.access(entryFilePath);
  } catch {
    issues.push({
      path: relativePath,
      issue: `Missing ${entryFileName} file`,
      severity: 'warning',
    });
    return issues;
  }

  try {
    const content = await fs.readFile(entryFilePath, 'utf-8');
    const parsed = fm(content);
    const attrs = parsed.attributes as Record<string, unknown> | null;

    if (!attrs || typeof attrs !== 'object') {
      issues.push({
        path: entryRelPath,
        issue: 'Missing frontmatter',
        severity: 'warning',
      });
      return issues;
    }

    if (!attrs.name || typeof attrs.name !== 'string') {
      issues.push({
        path: entryRelPath,
        issue: 'Missing required "name" field in frontmatter',
        severity: 'warning',
      });
    } else {
      const expectedName = folderName.toLowerCase();
      if (attrs.name !== expectedName) {
        issues.push({
          path: entryRelPath,
          issue: `name "${attrs.name}" does not match folder "${expectedName}"`,
          severity: 'warning',
        });
      }
    }

    if (!attrs.description || typeof attrs.description !== 'string') {
      issues.push({
        path: entryRelPath,
        issue: 'Missing required "description" field in frontmatter',
        severity: 'warning',
      });
    }

    // Validate extends field if present
    if (attrs.extends) {
      if (typeof attrs.extends !== 'string') {
        issues.push({
          path: entryRelPath,
          issue: '"extends" field must be a string path',
          severity: 'warning',
        });
      } else {
        // Check if the extended skill path exists
        const rebelSystemPath = getSystemSettingsPath();
        const workspaceRoot = path.dirname(rebelSystemPath);
        const extendedPath = path.join(workspaceRoot, attrs.extends);
        try {
          await fs.access(extendedPath);
        } catch {
          issues.push({
            path: entryRelPath,
            issue: `extends "${attrs.extends}" - base skill not found`,
            severity: 'warning',
          });
        }
      }
    }

    // Validate extension_type field if present
    if (attrs.extension_type) {
      if (attrs.extension_type !== 'overlay' && attrs.extension_type !== 'replace') {
        issues.push({
          path: entryRelPath,
          issue: '"extension_type" must be "overlay" or "replace"',
          severity: 'warning',
        });
      }
      if (!attrs.extends) {
        issues.push({
          path: entryRelPath,
          issue: '"extension_type" set without "extends" - add extends or remove extension_type',
          severity: 'warning',
        });
      }
    }
  } catch (err) {
    log.debug({ err, skillPath }, 'Failed to parse skill frontmatter');
    issues.push({
      path: entryRelPath,
      issue: 'Failed to parse frontmatter',
      severity: 'warning',
    });
  }

  return issues;
}

/**
 * Scan a skills directory and validate all skills.
 *
 * Backed by `safeWalkDirectory` so the walker is bounded by depth, path
 * length, and visited-realpath cycle detection. Pre-fix, an unguarded
 * recursive walk could blow up on a self-nested workspace (REBEL-506).
 *
 * The walker handles per-directory classification in `onDirectory`:
 *  - hidden / `Anthropic-official-skills` dirs: skip (return false)
 *  - dir contains SKILL.md / AUTOMATION.md: it's a skill (validate, don't descend)
 *  - otherwise: it's a category — descend
 *
 * Flat `.md` files (old convention) are picked up in `onFile`.
 */
async function scanSkillsDirectory(
  skillsDir: string,
  baseRelativePath: string
): Promise<SkillValidationResult> {
  const result: SkillValidationResult = {
    totalSkills: 0,
    validSkills: 0,
    issues: [],
  };

  // Compute a relative path for diagnostics from a directory's absolutePath.
  const toRelative = (absolutePath: string): string => {
    const rel = path.relative(skillsDir, absolutePath);
    return rel.length > 0 ? `${baseRelativePath}/${rel.split(path.sep).join('/')}` : baseRelativePath;
  };

  await safeWalkDirectory(skillsDir, {
    onDirectory: async ({ absolutePath, name, depth }) => {
      if (name.startsWith('.')) return false;
      // Skip Anthropic-official-skills (third-party, different structure)
      if (name === 'Anthropic-official-skills') return false;

      const entryFileName = await findEntryFile(absolutePath);
      const entryRelPath = toRelative(absolutePath);

      if (entryFileName) {
        // This directory has a recognized entry file. depth=0 means a skill
        // sits directly under skills/ without a category folder, which is
        // discouraged.
        const isTopLevel = depth === 0;
        if (isTopLevel) {
          result.totalSkills++;
          result.issues.push({
            path: entryRelPath,
            issue: 'Skill should be in a category folder (e.g., skills/demo/skill-name/)',
            severity: 'warning',
          });
        } else {
          result.totalSkills++;
          const issues = await validateSkillFolder(absolutePath, name, entryRelPath, entryFileName);
          if (issues.length === 0) {
            result.validSkills++;
          } else {
            result.issues.push(...issues);
          }
        }
        // Skill folder is a leaf — don't recurse into it.
        return false;
      }

      // No entry file: it's a category folder; descend.
      return true;
    },
    onFile: ({ absolutePath, name, depth, parentDir }) => {
      if (name.startsWith('.')) return;
      if (name.toLowerCase() === 'readme.md') return;
      if (!name.endsWith('.md')) return;
      if (ENTRY_FILE_NAMES.includes(name as typeof ENTRY_FILE_NAMES[number])) return;

      // Top-level loose .md files (e.g. skills/SKILLS-MENU.md) are legitimate
      // docs; only flag flat skill-style files inside categories.
      // depth corresponds to the parent directory's depth; a file directly
      // under skillsDir reports depth=0 with parentDir === skillsDir.
      const isTopLevel = depth === 0 && parentDir === skillsDir;
      if (isTopLevel) return;

      const entryRelPath = toRelative(absolutePath);
      result.totalSkills++;
      result.issues.push({
        path: entryRelPath,
        issue: 'Flat .md file should be converted to folder with SKILL.md or AUTOMATION.md',
        severity: 'warning',
      });
    },
    onTruncated: ({ reasons, entriesVisited }) => {
      log.debug(
        { skillsDir, reasons, entriesVisited },
        'scanSkillsDirectory hit a traversal cap — validation may be incomplete',
      );
    },
  });

  return result;
}

export async function checkSkillsConvention(): Promise<CheckResult> {
  const id = 'skillsConvention';
  const name = 'Skills Convention';

  try {
    const rebelSystemPath = getSystemSettingsPath();
    const skillsDir = path.join(rebelSystemPath, 'skills');

    try {
      await fs.access(skillsDir);
    } catch {
      return {
        id,
        name,
        status: 'skip',
        message: 'Skills directory not found',
        details: { path: skillsDir },
      };
    }

    const result = await scanSkillsDirectory(skillsDir, 'skills');

    if (result.totalSkills === 0) {
      return {
        id,
        name,
        status: 'skip',
        message: 'No skills found to validate',
        details: { path: skillsDir },
      };
    }

    const issueCount = result.issues.length;

    if (issueCount > 0) {
      // Build a readable message with top issues
      const topIssues = result.issues.slice(0, 5);
      const issueLines = topIssues.map((i) => `${i.path}: ${i.issue}`).join('; ');
      const moreCount = result.issues.length - topIssues.length;
      const moreText = moreCount > 0 ? ` (+${moreCount} more)` : '';

      // Capped at 'warn' — this check only scans bundled/read-only skills
      // that users cannot fix. Issues are still captured for developer visibility.
      return {
        id,
        name,
        status: 'warn',
        message: `${result.validSkills}/${result.totalSkills} valid (bundled). Issues: ${issueLines}${moreText}`,
        details: {
          totalSkills: result.totalSkills,
          validSkills: result.validSkills,
          issueCount,
        },
        remediation: 'Bundled skill convention issues — no user action needed',
      };
    }

    return {
      id,
      name,
      status: 'pass',
      message: `All ${result.totalSkills} skills follow convention`,
      details: {
        totalSkills: result.totalSkills,
        validSkills: result.validSkills,
      },
    };
  } catch (error) {
    log.warn({ err: error }, 'Skills convention check failed unexpectedly');
    return {
      id,
      name,
      status: 'warn',
      message: 'Check failed unexpectedly',
      details: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}
