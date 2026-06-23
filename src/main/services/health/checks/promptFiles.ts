/**
 * Prompt Files Health Checks
 *
 * Validates that externalized prompt files exist, are non-empty,
 * and render without errors using dummy variables.
 *
 * @see docs/plans/260406_prompt_externalization.md
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import {
  getPromptsRootPath,
  getRegisteredPromptIds,
  PROMPT_REGISTRY,
  parsePromptFile,
  renderPromptTemplate,
} from '@core/services/promptFileService';
import type { CheckResult } from '../types';

const log = createScopedLogger({ service: 'healthCheck:promptFiles' });

/**
 * Verify that each registered prompt file exists on disk and is non-empty.
 */
export async function checkPromptFilesExist(): Promise<CheckResult> {
  const id = 'promptFilesExist';
  const name = 'Prompt Files';

  const rootPath = getPromptsRootPath();
  if (!rootPath) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Prompt file service not configured',
    };
  }

  const promptIds = getRegisteredPromptIds();
  if (promptIds.length === 0) {
    return {
      id,
      name,
      status: 'pass',
      message: 'No prompt files registered yet (infrastructure ready)',
    };
  }

  const missing: string[] = [];
  const empty: string[] = [];
  let validCount = 0;

  for (const promptId of promptIds) {
    const filePath = path.join(rootPath, `${promptId}.md`);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size === 0) {
        empty.push(promptId);
      } else {
        validCount++;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        missing.push(promptId);
      } else {
        log.warn({ promptId, filePath, code }, 'Unexpected error checking prompt file');
        missing.push(promptId);
      }
    }
  }

  if (missing.length > 0 || empty.length > 0) {
    const hasCritical = [...missing, ...empty].some((pid) => {
      const meta = PROMPT_REGISTRY.get(pid);
      return meta?.critical === true;
    });

    return {
      id,
      name,
      status: hasCritical ? 'fail' : 'warn',
      message: [
        missing.length > 0 ? `${missing.length} missing` : null,
        empty.length > 0 ? `${empty.length} empty` : null,
        `${validCount} valid`,
      ].filter(Boolean).join(', '),
      details: { missing, empty, validCount, totalRegistered: promptIds.length },
      remediation: 'Re-sync rebel-system or check that prompt files exist in rebel-system/prompts/',
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: `All ${validCount} prompt file(s) present`,
    details: { validCount, totalRegistered: promptIds.length },
  };
}

/**
 * Verify that each registered prompt file parses correctly and renders
 * without Nunjucks errors using dummy variables.
 *
 * Also verifies that expected variables from frontmatter are actually
 * referenced in the template body.
 */
export async function checkPromptFilesRender(): Promise<CheckResult> {
  const id = 'promptFilesRender';
  const name = 'Prompt File Rendering';

  const rootPath = getPromptsRootPath();
  if (!rootPath) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Prompt file service not configured',
    };
  }

  const promptIds = getRegisteredPromptIds();
  if (promptIds.length === 0) {
    return {
      id,
      name,
      status: 'pass',
      message: 'No prompt files registered yet (infrastructure ready)',
    };
  }

  const parseErrors: Array<{ id: string; error: string }> = [];
  const renderErrors: Array<{ id: string; error: string }> = [];
  const variableWarnings: Array<{ id: string; unreferenced: string[] }> = [];
  let validCount = 0;

  for (const promptId of promptIds) {
    const filePath = path.join(rootPath, `${promptId}.md`);

    // Read file
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      // File doesn't exist — handled by checkPromptFilesExist
      continue;
    }

    // Parse frontmatter + body
    let frontmatter: { variables: string[] };
    let body: string;
    try {
      const parsed = parsePromptFile(raw);
      frontmatter = parsed.frontmatter;
      body = parsed.body;
    } catch (err) {
      parseErrors.push({ id: promptId, error: (err as Error).message });
      continue;
    }

    // Check that declared variables appear in the template body
    const unreferenced = frontmatter.variables.filter(
      (v) => !body.includes(`{{ ${v} }}`) && !body.includes(`{{${v}}}`) && !body.includes(v),
    );
    if (unreferenced.length > 0) {
      variableWarnings.push({ id: promptId, unreferenced });
    }

    // Render with dummy variables
    const dummyVars: Record<string, string> = {};
    for (const v of frontmatter.variables) {
      dummyVars[v] = `__DUMMY_${v}__`;
    }

    try {
      renderPromptTemplate(body, dummyVars);
      validCount++;
    } catch (err) {
      renderErrors.push({ id: promptId, error: (err as Error).message });
    }
  }

  const hasErrors = parseErrors.length > 0 || renderErrors.length > 0;

  if (hasErrors) {
    const hasCritical = [...parseErrors, ...renderErrors].some((e) => {
      const meta = PROMPT_REGISTRY.get(e.id);
      return meta?.critical === true;
    });

    return {
      id,
      name,
      status: hasCritical ? 'fail' : 'warn',
      message: [
        parseErrors.length > 0 ? `${parseErrors.length} parse error(s)` : null,
        renderErrors.length > 0 ? `${renderErrors.length} render error(s)` : null,
        `${validCount} OK`,
      ].filter(Boolean).join(', '),
      details: { parseErrors, renderErrors, variableWarnings, validCount },
      remediation: 'Check prompt file format: YAML frontmatter + markdown body with valid Nunjucks syntax',
    };
  }

  if (variableWarnings.length > 0) {
    return {
      id,
      name,
      status: 'warn',
      message: `All ${validCount} prompt(s) render OK, but ${variableWarnings.length} have unreferenced variables`,
      details: { variableWarnings, validCount },
      remediation: 'Update frontmatter `variables` list to match actual template variable usage',
    };
  }

  return {
    id,
    name,
    status: 'pass',
    message: `All ${validCount} prompt(s) parse and render successfully`,
    details: { validCount },
  };
}
