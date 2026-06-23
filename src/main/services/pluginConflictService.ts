import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { getSettings } from '@core/services/settingsStore';
import { callWithModelAuthAware } from './behindTheScenesClient';
import { hasValidAuth } from '@core/utils/authEnvUtils';
import { listConflictFiles, type ParsedConflictFile } from './pluginConflictDetector';

// Re-export for backward compatibility (test mocks import from this module).
export { detectPluginConflicts } from './pluginConflictDetector';

const log = createScopedLogger({ service: 'pluginConflictService' });

const MERGE_MAX_TOKENS = 4096;

export interface PluginConflict {
  pluginId: string;
  conflictFiles: string[];
  spacePath: string;
}

export type PluginConflictResolution = 'keep-mine' | 'keep-theirs';

export interface ParsedMergeResponse {
  mergedManifest: Record<string, unknown>;
  mergedSource: string;
}

async function pickPreferredConflictFile(candidates: ParsedConflictFile[]): Promise<ParsedConflictFile> {
  const candidatesWithStats = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const stats = await fs.stat(candidate.absolutePath);
        return { candidate, mtimeMs: stats.mtimeMs };
      } catch {
        return { candidate, mtimeMs: Number.NEGATIVE_INFINITY };
      }
    }),
  );

  candidatesWithStats.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return a.candidate.fileName.localeCompare(b.candidate.fileName);
  });

  return candidatesWithStats[0].candidate;
}

async function applyKeepTheirs(pluginDir: string, conflictFiles: ParsedConflictFile[]): Promise<void> {
  const conflictsByTarget = new Map<ParsedConflictFile['targetFile'], ParsedConflictFile[]>();
  for (const conflictFile of conflictFiles) {
    const existing = conflictsByTarget.get(conflictFile.targetFile) ?? [];
    existing.push(conflictFile);
    conflictsByTarget.set(conflictFile.targetFile, existing);
  }

  for (const [targetFile, candidates] of conflictsByTarget) {
    const selectedConflictFile = await pickPreferredConflictFile(candidates);
    await fs.copyFile(selectedConflictFile.absolutePath, path.join(pluginDir, targetFile));
  }
}

async function deleteConflictFiles(conflictFiles: ParsedConflictFile[]): Promise<void> {
  for (const conflictFile of conflictFiles) {
    try {
      await fs.unlink(conflictFile.absolutePath);
    } catch (error) {
      const isMissingFile = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
      if (!isMissingFile) {
        throw error;
      }
    }
  }
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is invalid JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function extractCodeBlock(responseText: string, languages: string[]): string | null {
  const escapedLanguages = languages.map((language) => language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const languagePattern = escapedLanguages.join('|');
  // Use global flag and take the LAST match — LLMs may echo input before the merged output
  const codeBlockRegex = new RegExp(`\`\`\`(?:${languagePattern})\\s*([\\s\\S]*?)\`\`\``, 'gi');
  let lastMatch: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(responseText)) !== null) {
    const code = match[1]?.trim();
    if (code && code.length > 0) {
      lastMatch = code;
    }
  }
  return lastMatch;
}

export function parseMergeResponse(responseText: string): ParsedMergeResponse {
  const manifestBlock = extractCodeBlock(responseText, ['json']);
  if (!manifestBlock) {
    throw new Error('Merge response missing a ```json manifest block.');
  }

  const sourceBlock = extractCodeBlock(responseText, ['tsx', 'typescript', 'ts', 'jsx', 'javascript']);
  if (!sourceBlock) {
    throw new Error('Merge response missing a ```tsx source block.');
  }

  const mergedManifest = parseJsonObject(manifestBlock, 'Merged manifest');

  return {
    mergedManifest,
    mergedSource: sourceBlock,
  };
}

function buildMergePrompt(input: {
  pluginId: string;
  currentManifest: Record<string, unknown>;
  currentSource: string;
  conflictManifest: Record<string, unknown>;
  conflictSource: string;
}): string {
  return [
    `Plugin ID: ${input.pluginId}`,
    '',
    'Current version (mine):',
    '```json',
    JSON.stringify(input.currentManifest, null, 2),
    '```',
    '```tsx',
    input.currentSource,
    '```',
    '',
    'Conflicted version (theirs):',
    '```json',
    JSON.stringify(input.conflictManifest, null, 2),
    '```',
    '```tsx',
    input.conflictSource,
    '```',
    '',
    'Return exactly two fenced code blocks in this order:',
    '1) ```json with the merged manifest JSON object',
    '2) ```tsx with the merged plugin source code',
    '',
    'Do not include any commentary outside the two code blocks.',
  ].join('\n');
}

export async function proposeMerge(
  pluginId: string,
  spacePath: string,
): Promise<{ success: true; mergedManifest: Record<string, unknown>; mergedSource: string } | { success: false; error: string }> {
  const pluginDir = path.join(spacePath, 'plugins', pluginId);
  const currentManifestPath = path.join(pluginDir, 'manifest.json');
  const currentSourcePath = path.join(pluginDir, 'index.tsx');

  try {
    const settings = getSettings();
    if (!hasValidAuth(settings)) {
      return {
        success: false,
        error: 'Rebel merge requires an API key or OAuth token in Settings.',
      };
    }

    const [currentManifestRaw, currentSource, conflictFiles] = await Promise.all([
      fs.readFile(currentManifestPath, 'utf-8'),
      fs.readFile(currentSourcePath, 'utf-8'),
      listConflictFiles(pluginDir),
    ]);

    if (conflictFiles.length === 0) {
      return { success: false, error: 'No conflict files found for this plugin.' };
    }

    const manifestConflicts = conflictFiles.filter((file) => file.targetFile === 'manifest.json');
    const sourceConflicts = conflictFiles.filter((file) => file.targetFile === 'index.tsx');

    let conflictManifestRaw = currentManifestRaw;
    if (manifestConflicts.length > 0) {
      const preferredManifestConflict = await pickPreferredConflictFile(manifestConflicts);
      conflictManifestRaw = await fs.readFile(preferredManifestConflict.absolutePath, 'utf-8');
    }

    let conflictSource = currentSource;
    if (sourceConflicts.length > 0) {
      const preferredSourceConflict = await pickPreferredConflictFile(sourceConflicts);
      conflictSource = await fs.readFile(preferredSourceConflict.absolutePath, 'utf-8');
    }

    const currentManifest = parseJsonObject(currentManifestRaw, 'Current manifest');
    const conflictManifest = parseJsonObject(conflictManifestRaw, 'Conflicted manifest');

    const response = await callWithModelAuthAware(
      settings,
      settings.modelRoles?.auxiliary,
      {
        system: getPrompt(PROMPT_IDS.UTILITY_PLUGIN_MERGE),
        messages: [
          {
            role: 'user',
            content: buildMergePrompt({
              pluginId,
              currentManifest,
              currentSource,
              conflictManifest,
              conflictSource,
            }),
          },
        ],
        maxTokens: MERGE_MAX_TOKENS,
        timeout: 60_000,
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

    const { mergedManifest, mergedSource } = parseMergeResponse(responseText);

    return {
      success: true,
      mergedManifest,
      mergedSource,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ pluginId, spacePath, err: error }, 'Failed to propose Rebel merge');
    return { success: false, error: `Failed to propose merge: ${message}` };
  }
}

export async function acceptMerge(
  pluginId: string,
  spacePath: string,
  mergedManifest: Record<string, unknown>,
  mergedSource: string,
): Promise<{ success: true } | { success: false; error: string }> {
  if (!mergedSource || mergedSource.trim().length === 0) {
    return { success: false, error: 'Merged source cannot be empty.' };
  }

  if (!mergedManifest || typeof mergedManifest !== 'object' || Array.isArray(mergedManifest)) {
    return { success: false, error: 'Merged manifest must be a JSON object.' };
  }

  const manifestId = mergedManifest.id;
  if (typeof manifestId === 'string' && manifestId.trim().length > 0 && manifestId !== pluginId) {
    return {
      success: false,
      error: `Merged manifest id "${manifestId}" does not match plugin id "${pluginId}".`,
    };
  }

  if (typeof mergedManifest.name !== 'string' || mergedManifest.name.trim().length === 0) {
    return { success: false, error: 'Merged manifest is missing a valid "name" field.' };
  }

  const pluginDir = path.join(spacePath, 'plugins', pluginId);

  try {
    const { writePluginToSpace } = await import('./pluginSpaceService');
    const writeResult = await writePluginToSpace({ ...mergedManifest, id: pluginId }, mergedSource, spacePath);
    if (!writeResult.ok) {
      return { success: false, error: writeResult.error };
    }

    const conflictFiles = await listConflictFiles(pluginDir);
    await deleteConflictFiles(conflictFiles);

    // Defensive idempotent invalidate: `writePluginToSpace` already invalidated
    // for the current workspace key, so this call is a no-op in practice. Kept
    // for safety — if someone refactors writePluginToSpace to skip invalidation
    // on the merge path, the merge flow still stays correct.
    const { invalidatePluginIdentityCache } = await import('../ipc/plugins/shared');
    invalidatePluginIdentityCache('resolvePluginConflict:accept-merge');

    log.info({ pluginId, spacePath, conflictFileCount: conflictFiles.length }, 'Accepted Rebel merge');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ pluginId, spacePath, err: error }, 'Failed to accept Rebel merge');
    return { success: false, error: `Failed to accept merge: ${message}` };
  }
}

export async function resolvePluginConflict(
  pluginId: string,
  spacePath: string,
  resolution: PluginConflictResolution,
): Promise<{ success: true } | { success: false; error: string }> {
  const pluginDir = path.join(spacePath, 'plugins', pluginId);
  const conflictFiles = await listConflictFiles(pluginDir);

  if (conflictFiles.length === 0) {
    return { success: true };
  }

  try {
    if (resolution === 'keep-theirs') {
      await applyKeepTheirs(pluginDir, conflictFiles);
      // `applyKeepTheirs` overwrites `manifest.json` via `fs.copyFile` and can
      // change the plugin id (narrow id-rename edge case), which bypasses
      // `writePluginToSpace`. Invalidate the Stage 4 coalesced cache so the
      // next `isKnownPlugin` caller sees the updated identity set.
      const { invalidatePluginIdentityCache } = await import('../ipc/plugins/shared');
      invalidatePluginIdentityCache('resolvePluginConflict:keep-theirs');
    }

    await deleteConflictFiles(conflictFiles);
    log.info({ pluginId, spacePath, resolution }, 'Resolved plugin conflict');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ pluginId, spacePath, resolution, err: error }, 'Failed to resolve plugin conflict');
    return { success: false, error: `Failed to resolve conflict: ${message}` };
  }
}
