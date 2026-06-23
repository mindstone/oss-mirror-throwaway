import { createScopedLogger } from '@core/logger';
import { callWithModelAuthAware } from '@core/services/behindTheScenesClient';
import type { AppSettings } from '@shared/types';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const log = createScopedLogger({ service: 'workspaceConflictResolver' });

/**
 * Get the merge system prompt (lazy access via prompt file service).
 */
function getMergeSystemPrompt(): string {
  return getPrompt(PROMPT_IDS.UTILITY_WORKSPACE_MERGE);
}
const MERGE_MAX_TOKENS = 8192;
const MERGE_TIMEOUT_MS = 60_000;
const MAX_FILE_SIZE_BYTES = 100 * 1024;

function buildMergePrompt(filePath: string, localContent: string, cloudContent: string): string {
  return [
    `File path: ${filePath}`,
    '',
    '<LOCAL_VERSION>',
    localContent,
    '</LOCAL_VERSION>',
    '',
    '<CLOUD_VERSION>',
    cloudContent,
    '</CLOUD_VERSION>',
    '',
    'Return only the merged content wrapped in <MERGED_FILE> and </MERGED_FILE> tags.',
  ].join('\n');
}

export function extractMergedContent(responseText: string): string | null {
  const mergedTagRegex = /<MERGED_FILE>([\s\S]*?)<\/MERGED_FILE>/gi;
  let sawMatch = false;
  let lastMatch: string | null = null;
  let lastNonEmptyMatch: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = mergedTagRegex.exec(responseText)) !== null) {
    sawMatch = true;
    const content = (match[1] ?? '').trim();
    lastMatch = content;
    if (content.length > 0) {
      lastNonEmptyMatch = content;
    }
  }

  if (!sawMatch) {
    return null;
  }

  return lastNonEmptyMatch ?? lastMatch ?? '';
}

export async function proposeMerge(
  settings: AppSettings,
  localContent: string,
  cloudContent: string,
  filePath: string,
): Promise<{ success: true; mergedContent: string } | { success: false; error: string }> {
  if (
    Buffer.byteLength(localContent, 'utf8') > MAX_FILE_SIZE_BYTES
    || Buffer.byteLength(cloudContent, 'utf8') > MAX_FILE_SIZE_BYTES
  ) {
    return {
      success: false,
      error: `File too large to merge with Rebel (max 100KB): ${filePath}`,
    };
  }

  try {
    const response = await callWithModelAuthAware(
      settings,
      settings.modelRoles?.auxiliary,
      {
        codexConnectivity: resolveCodexConnectivity(),
        system: getMergeSystemPrompt(),
        messages: [
          {
            role: 'user',
            content: buildMergePrompt(filePath, localContent, cloudContent),
          },
        ],
        maxTokens: MERGE_MAX_TOKENS,
        timeout: MERGE_TIMEOUT_MS,
      },
      { category: 'system' },
    );

    const responseText = response.content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text ?? '')
      .join('\n')
      .trim();

    if (!responseText) {
      return { success: false, error: 'Rebel returned an empty merge response.' };
    }

    const mergedContent = extractMergedContent(responseText);
    if (mergedContent === null) {
      return { success: false, error: 'Merge response missing <MERGED_FILE> delimiters.' };
    }
    if (mergedContent.length === 0) {
      return { success: false, error: 'Merge response contained empty merged content.' };
    }

    return { success: true, mergedContent };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ filePath, err: error }, 'Failed to propose workspace merge');
    return { success: false, error: `Failed to propose merge: ${message}` };
  }
}
