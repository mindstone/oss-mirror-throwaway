/**
 * Validates that an automation filePath points to an existing file at create/update time.
 *
 * Mirrors the resolution logic in AutomationScheduler.resolveAutomationFile() so users
 * get immediate feedback instead of discovering broken paths hours/days later at execution.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveLibraryPath, isPathInsideLexical } from '../utils/systemUtils';
import { getSystemSettingsPath } from '../services/systemSettingsSync';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'automationFileValidation' });

/** Optional dependency overrides for testing. */
export interface ValidationDeps {
  resolveLibraryPath: typeof resolveLibraryPath;
  isPathInsideLexical: typeof isPathInsideLexical;
  getSystemSettingsPath: typeof getSystemSettingsPath;
  stat: typeof fs.stat;
}

const defaultDeps: ValidationDeps = {
  resolveLibraryPath,
  isPathInsideLexical,
  getSystemSettingsPath,
  stat: fs.stat,
};

/**
 * Validate that an automation filePath resolves to an existing file.
 *
 * Follows the same resolution strategy as `resolveAutomationFile`:
 *   1. `resolveLibraryPath()` to get the absolute path
 *   2. `fs.stat()` to check existence
 *   3. Directory paths → check for SKILL.md inside
 *   4. `rebel-system/` fallback via systemSettingsPath
 *
 * @throws Error with a user-friendly message when the file cannot be found
 */
export async function validateAutomationFilePath(
  filePath: string,
  coreDirectory: string,
  deps: Partial<ValidationDeps> = {}
): Promise<void> {
  const { resolveLibraryPath: resolve, isPathInsideLexical: isInside, getSystemSettingsPath: getSettingsPath, stat } = {
    ...defaultDeps,
    ...deps,
  };

  const libraryResult = resolve(filePath, coreDirectory);
  const resolved = libraryResult.resolved;

  log.debug({ filePath, resolved }, 'Validating automation file path');

  // Check primary resolved path
  const fileStat = await stat(resolved).catch(() => null);

  if (fileStat?.isDirectory()) {
    const skillPath = path.join(resolved, 'SKILL.md');
    const skillStat = await stat(skillPath).catch(() => null);
    if (skillStat?.isFile()) {
      return; // Valid: directory with SKILL.md
    }
    throw new Error(
      `The path "${filePath}" is a directory without a SKILL.md file. Please select a markdown file.`
    );
  }

  if (fileStat?.isFile()) {
    return; // Valid: file exists
  }

  // Fallback for rebel-system paths when workspace symlink not yet created
  if (filePath.startsWith('rebel-system/')) {
    const systemSettingsPath = getSettingsPath();
    const relativeSuffix = filePath.slice('rebel-system/'.length);
    const fallbackPath = path.resolve(systemSettingsPath, relativeSuffix);

    // Security: prevent path traversal
    if (!isInside(fallbackPath, systemSettingsPath)) {
      throw new Error(`Automation file path escapes system settings: ${filePath}`);
    }

    const fallbackStat = await stat(fallbackPath).catch(() => null);
    if (fallbackStat?.isFile()) {
      return; // Valid via rebel-system fallback
    }
    if (fallbackStat?.isDirectory()) {
      const fallbackSkillPath = path.join(fallbackPath, 'SKILL.md');
      const fallbackSkillStat = await stat(fallbackSkillPath).catch(() => null);
      if (fallbackSkillStat?.isFile()) {
        return; // Valid: rebel-system directory with SKILL.md
      }
    }
  }

  // File not found at any location
  const fileName = path.basename(filePath);
  throw new Error(
    `File "${fileName}" could not be found at the specified path. ` +
    `Check that the file exists in your workspace before creating the automation.\n\n` +
    `Path: ${filePath}`
  );
}
