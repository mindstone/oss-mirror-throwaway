/**
 * Cloud Automation Prompt Reader
 *
 * Reads and prepares the automation prompt from the skill file.
 * Pure prompt-building utilities (stripYamlFrontmatter, substitutePromptVariables)
 * are shared with desktop via @core/services/automationUtils.
 * This file handles only cloud-specific file resolution.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { AutomationDefinition } from '@shared/types';
import { getSettings } from '@core/services/settingsStore';
import { stripYamlFrontmatter, substitutePromptVariables } from '@core/services/automationUtils';
import { resolveLibraryPath } from '@core/utils/systemUtils';

/**
 * Read and prepare the automation prompt from the skill file.
 * Resolves the file path relative to the cloud workspace directory.
 */
export async function readAutomationPrompt(
  definition: AutomationDefinition,
): Promise<string> {
  const settings = getSettings();
  const coreDirectory = settings.coreDirectory;
  if (!coreDirectory) {
    throw new Error('Workspace directory is not configured');
  }

  let filePath = definition.filePath;
  if (!filePath) {
    throw new Error(`Automation "${definition.name}" has no skill file path`);
  }

  // Resolve relative to workspace, with path traversal guard
  let resolved: string;
  try {
    ({ resolved } = resolveLibraryPath(filePath, coreDirectory));
  } catch {
    throw new Error(`Path traversal not allowed: ${definition.filePath}`);
  }

  // Handle directory paths — check for SKILL.md inside
  let stat = await fs.stat(resolved).catch(() => null);
  if (stat?.isDirectory()) {
    const skillPath = path.join(resolved, 'SKILL.md');
    stat = await fs.stat(skillPath).catch(() => null);
    if (stat?.isFile()) {
      filePath = skillPath;
    } else {
      throw new Error(
        `Automation path "${definition.filePath}" is a directory without a SKILL.md file`,
      );
    }
  } else if (!stat) {
    throw new Error(
      `Skill file not found: ${definition.filePath}`,
    );
  } else {
    filePath = resolved;
  }

  const content = await fs.readFile(filePath, 'utf-8');
  const rawPrompt = stripYamlFrontmatter(content).trimStart();
  return substitutePromptVariables(rawPrompt, definition);
}
