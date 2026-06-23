/**
 * System Prompt Health Checks
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import _axios from 'axios';
import type { AppSettings } from '@shared/types';
import { getEffectiveSkillPath } from '@shared/systemSkills';
import { resolveSystemPrompt } from '../../mcpService';
import { getSystemSettingsPath } from '../../systemSettingsSync';
import { createScopedLogger } from '@core/logger';
import { callBehindTheScenesWithAuth, getEffectiveModelName } from '../../behindTheScenesClient';
import { hasValidAuth } from '../../../utils/authEnvUtils';
import type { CheckResult } from '../types';

const log = createScopedLogger({ service: 'healthCheck:prompt' });

export async function checkSystemPromptRenders(settings: AppSettings): Promise<CheckResult> {
  const id = 'systemPromptRenders';
  const name = 'System Prompt';

  if (!settings.coreDirectory) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Skipped - Library not configured',
    };
  }

  try {
    const prompt = await resolveSystemPrompt(settings);
    
    if (!prompt || (typeof prompt === 'string' && prompt.trim().length === 0)) {
      return {
        id,
        name,
        status: 'fail',
        message: 'System prompt rendered empty',
        remediation: 'Check that rebel-system/AGENTS.md and Chief-of-Staff/README.md exist',
      };
    }

    const promptLength = typeof prompt === 'string' ? prompt.length : 0;
    return {
      id,
      name,
      status: 'pass',
      message: `Renders successfully (${promptLength.toLocaleString()} chars)`,
      details: { length: promptLength },
    };
  } catch (error) {
    const err = error as Error;
    return {
      id,
      name,
      status: 'fail',
      message: `Failed to render: ${err.message}`,
      remediation: 'Check that system files are synced and Chief-of-Staff space is initialized',
    };
  }
}

export async function checkSafetyPromptExists(settings: AppSettings): Promise<CheckResult> {
  const id = 'safetyPromptExists';
  const name = 'Safety Guard Prompt';

  try {
    const rebelSystemDir = getSystemSettingsPath();
    const relativePath = getEffectiveSkillPath('safetyGuard', settings.systemSkills);
    const promptPath = path.join(rebelSystemDir, relativePath);
    
    const content = await fs.readFile(promptPath, 'utf8');
    
    if (!content || content.trim().length === 0) {
      return {
        id,
        name,
        status: 'fail',
        message: 'Safety prompt file is empty',
        remediation: 'Re-sync rebel-system or check skills/safety/safety-guard/SKILL.md',
      };
    }

    // Check for required template variables
    const requiredVars = ['{{user_message}}', '{{tool_name}}', '{{tool_input}}', '{{security_level_guidance}}'];
    const missingVars = requiredVars.filter(v => !content.includes(v));
    
    if (missingVars.length > 0) {
      return {
        id,
        name,
        status: 'warn',
        message: `Missing template variables: ${missingVars.join(', ')}`,
        remediation: 'Check that safety-guard/SKILL.md has all required template variables',
      };
    }

    return {
      id,
      name,
      status: 'pass',
      message: `Loaded (${content.length.toLocaleString()} chars)`,
      details: { path: promptPath, length: content.length },
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      id,
      name,
      status: 'fail',
      message: err.code === 'ENOENT' 
        ? 'Safety prompt file not found'
        : `Failed to read: ${err.message}`,
      remediation: 'Re-sync rebel-system or check skills/safety/safety-guard/SKILL.md exists',
    };
  }
}

export async function checkMemoryPromptExists(settings: AppSettings): Promise<CheckResult> {
  const id = 'memoryPromptExists';
  const name = 'Memory Update Prompt';

  try {
    const rebelSystemDir = getSystemSettingsPath();
    const relativePath = getEffectiveSkillPath('memoryUpdate', settings.systemSkills);
    const promptPath = path.join(rebelSystemDir, relativePath);
    
    const content = await fs.readFile(promptPath, 'utf8');
    
    if (!content || content.trim().length === 0) {
      return {
        id,
        name,
        status: 'fail',
        message: 'Memory prompt file is empty',
        remediation: 'Re-sync rebel-system or check skills/memory/memory-update/SKILL.md',
      };
    }

    return {
      id,
      name,
      status: 'pass',
      message: `Loaded (${content.length.toLocaleString()} chars)`,
      details: { path: promptPath, length: content.length },
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return {
      id,
      name,
      status: 'fail',
      message: err.code === 'ENOENT' 
        ? 'Memory prompt file not found'
        : `Failed to read: ${err.message}`,
      remediation: 'Re-sync rebel-system or check skills/memory/memory-update/SKILL.md exists',
    };
  }
}

// =============================================================================
// System Prompt Coherence Check (LLM-based)
// =============================================================================

export const SYSTEM_PROMPT_COHERENCE_LLM_TIMEOUT_MS = 15_000;
// Outer = inner + 5s headroom for resolveSystemPrompt() filesystem I/O and JSON parsing.
// Headroom is enforced by a regression test (see __tests__/systemHealthService.test.ts).
export const SYSTEM_PROMPT_COHERENCE_HEADROOM_MS = 5_000;
export const SYSTEM_PROMPT_COHERENCE_TIMEOUT_MS =
  SYSTEM_PROMPT_COHERENCE_LLM_TIMEOUT_MS + SYSTEM_PROMPT_COHERENCE_HEADROOM_MS;

interface CoherenceIssue {
  type: 'repetition' | 'contradiction' | 'flow';
  severity: 'low' | 'medium' | 'high';
  description: string;
}

interface CoherenceAnalysis {
  hasIssues: boolean;
  issues: CoherenceIssue[];
}

/**
 * Analyze the system prompt for coherence issues using Haiku.
 * Uses structured output for reliable JSON responses.
 */
async function analyzePromptCoherence(
  promptText: string,
  settings: AppSettings,
  signal?: AbortSignal
): Promise<CoherenceAnalysis> {
  const analysisPrompt = `You are analyzing a system prompt for an AI assistant. Check for:

1. REPETITION: Are there significant sections that repeat the same instructions multiple times?
2. CONTRADICTION: Are there instructions that conflict with each other?
3. FLOW: Does the prompt flow logically, or are there jarring transitions?

Be lenient - only flag issues that would genuinely confuse an AI or cause problems.
Minor repetition for emphasis is fine. Focus on substantial issues only.

System prompt to analyze:
---
${promptText}
---

Analyze and respond with JSON.`;

  log.debug({ model: getEffectiveModelName(settings) }, 'Calling LLM for coherence analysis');

  const response = await callBehindTheScenesWithAuth(settings, {
    messages: [{ role: 'user', content: analysisPrompt }],
    maxTokens: 1024,
    outputFormat: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          hasIssues: { type: 'boolean' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['repetition', 'contradiction', 'flow'] },
                severity: { type: 'string', enum: ['low', 'medium', 'high'] },
                description: { type: 'string' },
              },
              required: ['type', 'severity', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['hasIssues', 'issues'],
        additionalProperties: false,
      },
    },
    timeout: SYSTEM_PROMPT_COHERENCE_LLM_TIMEOUT_MS,
    signal,
  }, { category: 'system' });

  const content = response.content?.[0];
  if (content?.type === 'text' && content.text) {
    return JSON.parse(content.text) as CoherenceAnalysis;
  }

  return { hasIssues: false, issues: [] };
}

/**
 * Check the system prompt for coherence issues using LLM analysis.
 * 
 * This is an advisory check - it will warn but never fail.
 * Runs only in 'full' tier since it makes an API call.
 */
export async function checkSystemPromptCoherence(settings: AppSettings, signal?: AbortSignal): Promise<CheckResult> {
  const id = 'systemPromptCoherence';
  const name = 'System Prompt Coherence';

  if (!settings.coreDirectory) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Skipped - Library not configured',
    };
  }

  if (!hasValidAuth(settings)) {
    return {
      id,
      name,
      status: 'skip',
      message: 'Skipped - no valid auth configured',
    };
  }

  try {
    const prompt = await resolveSystemPrompt(settings);
    if (!prompt || typeof prompt !== 'string') {
      return {
        id,
        name,
        status: 'skip',
        message: 'Skipped - prompt not available',
      };
    }

    // Truncate if too long to keep analysis focused and reduce cost
    const maxChars = 50000;
    const truncatedPrompt = prompt.length > maxChars
      ? prompt.slice(0, maxChars) + '\n[...truncated...]'
      : prompt;

    log.info({ promptLength: prompt.length, truncated: prompt.length > maxChars }, 'Analyzing system prompt coherence');

    const analysis = await analyzePromptCoherence(truncatedPrompt, settings, signal);

    if (!analysis.hasIssues || analysis.issues.length === 0) {
      return {
        id,
        name,
        status: 'pass',
        message: 'No significant issues detected',
        details: { promptLength: prompt.length, issueCount: 0 },
      };
    }

    // Has issues - determine severity
    const hasHighSeverity = analysis.issues.some(i => i.severity === 'high');
    const hasMediumSeverity = analysis.issues.some(i => i.severity === 'medium');

    log.info(
      { issueCount: analysis.issues.length, hasHighSeverity, hasMediumSeverity },
      'System prompt coherence analysis complete'
    );

    return {
      id,
      name,
      status: hasHighSeverity || hasMediumSeverity ? 'warn' : 'pass',
      message: `Found ${analysis.issues.length} potential issue(s)`,
      details: {
        promptLength: prompt.length,
        issues: analysis.issues,
      },
      remediation: hasHighSeverity || hasMediumSeverity
        ? 'Review your system prompt components (rebel-system/AGENTS.md, Chief-of-Staff/README.md) for the issues listed above'
        : undefined,
    };
  } catch (error) {
    // API errors shouldn't fail the health check - just skip
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    log.warn({ err: error }, 'System prompt coherence check failed');
    return {
      id,
      name,
      status: 'skip',
      message: `Analysis skipped: ${errorMessage}`,
    };
  }
}
