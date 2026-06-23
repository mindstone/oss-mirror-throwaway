import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { FILE_WRITE_TOOLS } from './safety/constants';
import { sharedSkillMutationService } from './sharedSkillMutationService';

const log = createScopedLogger({ service: 'skillWriteTrackingHook' });

export interface SkillWriteTrackingHookOptions {
  coreDirectory: string;
}

function extractFilePath(toolInput: Record<string, unknown>): string | null {
  if (typeof toolInput.file_path === 'string') return toolInput.file_path;
  if (typeof toolInput.path === 'string') return toolInput.path;
  if (typeof toolInput.filePath === 'string') return toolInput.filePath;
  return null;
}

export function createSkillWriteTrackingHook(options: SkillWriteTrackingHookOptions) {
  const { coreDirectory } = options;

  return async (input: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_output?: { isError?: boolean } | unknown;
  }): Promise<Record<string, never>> => {
    const toolName = input.tool_name;
    const toolInput = input.tool_input as Record<string, unknown> | undefined;

    if (!toolName || !FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number]) || !toolInput) {
      return {};
    }

    const filePath = extractFilePath(toolInput);
    if (!filePath) {
      return {};
    }

    const toolOutput = input.tool_output as { isError?: boolean } | undefined;
    if (toolOutput?.isError) {
      await sharedSkillMutationService.clearPendingManagedWrite(filePath, coreDirectory);
      return {};
    }

    const sharedSkillTarget = await sharedSkillMutationService.classifySharedSkillPath(filePath, coreDirectory);
    if (!sharedSkillTarget) {
      return {};
    }

    const preview = sharedSkillMutationService.extractManagedContentFromToolInput(toolName, toolInput);
    if (!preview) {
      log.warn({ toolName, filePath }, 'Skipped shared-skill write tracking because content could not be reconstructed from tool input');
      return {};
    }

    const absolutePath = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(coreDirectory, filePath);
    let diskContent: string;
    try {
      diskContent = await fs.readFile(absolutePath, 'utf8');
    } catch (error) {
      log.warn({ err: error, absolutePath }, 'Skipped shared-skill write tracking; could not read file after tool write');
      return {};
    }

    log.debug({ toolName, filePath: absolutePath }, 'Recording successful shared-skill write for version tracking');
    await sharedSkillMutationService.recordSuccessfulManagedWrite(absolutePath, diskContent, coreDirectory);
    return {};
  };
}
