import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import type { OperatorRegistry } from '@core/services/operatorRegistry';
import { parseOperatorFrontmatterFromContent } from '@shared/schemas/operatorFrontmatter';
import type { OperatorDefinition } from '@shared/types/operators';
import { createOperatorId } from '@shared/types/operators';

const log = createScopedLogger({ service: 'meeting-coach-prompt-resolver' });

export interface ResolvedMeetingCoachPrompt {
  prompt: string;
  contentHash: string;
  source: 'operator-frontmatter' | 'file-body';
  proactiveIntervalMinutes?: number;
}

function computeContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return normalized.trim();
  }

  const closingDelimiterIndex = normalized.indexOf('\n---\n', 4);
  if (closingDelimiterIndex < 0) {
    return normalized.trim();
  }

  return normalized.slice(closingDelimiterIndex + '\n---\n'.length).trim();
}

function buildOperatorCandidateIds(coachSkillPath: string): string[] {
  const normalizedCoachPath = path.resolve(coachSkillPath);
  const candidateDirectories = new Set<string>();
  candidateDirectories.add(path.dirname(normalizedCoachPath));

  if (path.basename(normalizedCoachPath) === 'OPERATOR.md') {
    candidateDirectories.add(path.dirname(normalizedCoachPath));
  } else {
    candidateDirectories.add(normalizedCoachPath);
  }

  const candidateIds: string[] = [];
  for (const operatorDir of candidateDirectories) {
    const operatorsDir = path.dirname(operatorDir);
    if (path.basename(operatorsDir) !== 'operators') {
      continue;
    }
    const spacePath = path.dirname(operatorsDir);
    const operatorSlug = path.basename(operatorDir);
    if (!operatorSlug) {
      continue;
    }
    candidateIds.push(createOperatorId(spacePath, operatorSlug));
  }

  return candidateIds;
}

function operatorMatchesCoachPath(operator: OperatorDefinition, coachSkillPath: string): boolean {
  const normalizedCoachPath = path.resolve(coachSkillPath);
  const coachParentDir = path.dirname(normalizedCoachPath);
  const operatorFilePath = path.resolve(operator.operatorFileAbsolutePath);
  const operatorDirPath = path.resolve(operator.operatorDirAbsolutePath);
  return (
    operatorFilePath === normalizedCoachPath ||
    operatorDirPath === normalizedCoachPath ||
    operatorDirPath === coachParentDir
  );
}

function findMatchingOperator(coachSkillPath: string, registry: OperatorRegistry): OperatorDefinition | undefined {
  const candidateIds = buildOperatorCandidateIds(coachSkillPath);
  for (const operatorId of candidateIds) {
    const operator = registry.getById(operatorId);
    if (!operator) {
      continue;
    }
    if (operatorMatchesCoachPath(operator, coachSkillPath)) {
      return operator;
    }
  }
  return undefined;
}

function resolveFromOperatorFrontmatter(
  coachSkillPath: string,
  fileContent: string,
): ResolvedMeetingCoachPrompt | null {
  const parsed = parseOperatorFrontmatterFromContent(fileContent);
  if (!parsed.success) {
    return null;
  }

  const roles = parsed.frontmatter.roles;
  const livePrompt = parsed.frontmatter.live_prompt?.trim();
  if (!roles.includes('live_meeting') || !livePrompt) {
    return null;
  }

  return {
    prompt: livePrompt,
    contentHash: computeContentHash(livePrompt),
    source: 'operator-frontmatter',
    ...(parsed.frontmatter.proactive_interval_minutes !== undefined
      ? { proactiveIntervalMinutes: parsed.frontmatter.proactive_interval_minutes }
      : {}),
  };
}

function resolveFromFileBody(coachSkillPath: string, fileContent: string): ResolvedMeetingCoachPrompt {
  const bodyPrompt = stripFrontmatter(fileContent);
  const resolvedFromFile: ResolvedMeetingCoachPrompt = {
    prompt: bodyPrompt,
    contentHash: computeContentHash(bodyPrompt),
    source: 'file-body',
  };

  log.info(
    {
      coachSkillPath,
      source: resolvedFromFile.source,
      contentHash: resolvedFromFile.contentHash,
      hasProactiveInterval: false,
    },
    'operators:meeting_coach_prompt_resolved',
  );

  return resolvedFromFile;
}

function resolveFromRegistryFallback(
  coachSkillPath: string,
  registry: OperatorRegistry,
): ResolvedMeetingCoachPrompt | null {
  const matchingOperator = findMatchingOperator(coachSkillPath, registry);
  if (!matchingOperator || !matchingOperator.roles.includes('live_meeting')) {
    return null;
  }
  const livePrompt = matchingOperator.livePrompt?.trim();
  if (!livePrompt) {
    return null;
  }

  const resolvedFromFrontmatter: ResolvedMeetingCoachPrompt = {
    prompt: livePrompt,
    contentHash: computeContentHash(livePrompt),
    source: 'operator-frontmatter',
    ...(matchingOperator.proactiveIntervalMinutes !== undefined
      ? { proactiveIntervalMinutes: matchingOperator.proactiveIntervalMinutes }
      : {}),
  };

  log.info(
    {
      coachSkillPath,
      source: resolvedFromFrontmatter.source,
      contentHash: resolvedFromFrontmatter.contentHash,
      hasProactiveInterval: resolvedFromFrontmatter.proactiveIntervalMinutes !== undefined,
    },
    'operators:meeting_coach_prompt_resolved',
  );

  return resolvedFromFrontmatter;
}

export function resolveMeetingCoachPrompt(
  coachSkillPath: string,
  registry: OperatorRegistry,
): ResolvedMeetingCoachPrompt {
  const normalizedCoachPath = path.resolve(coachSkillPath);
  const isOperatorMarkdown = path.basename(normalizedCoachPath) === 'OPERATOR.md';

  if (isOperatorMarkdown) {
    const fileContent = fs.readFileSync(normalizedCoachPath, 'utf-8');
    const resolvedFromFrontmatter = resolveFromOperatorFrontmatter(normalizedCoachPath, fileContent);
    if (resolvedFromFrontmatter) {
      log.info(
        {
          coachSkillPath,
          source: resolvedFromFrontmatter.source,
          contentHash: resolvedFromFrontmatter.contentHash,
          hasProactiveInterval: resolvedFromFrontmatter.proactiveIntervalMinutes !== undefined,
        },
        'operators:meeting_coach_prompt_resolved',
      );
      return resolvedFromFrontmatter;
    }

    return resolveFromFileBody(normalizedCoachPath, fileContent);
  }

  try {
    const fileContent = fs.readFileSync(normalizedCoachPath, 'utf-8');
    return resolveFromFileBody(normalizedCoachPath, fileContent);
  } catch (error) {
    const resolvedFromRegistry = resolveFromRegistryFallback(normalizedCoachPath, registry);
    if (resolvedFromRegistry) {
      return resolvedFromRegistry;
    }
    throw error;
  }
}
