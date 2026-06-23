import path from 'node:path';
import properLockfile from 'proper-lockfile';
import { createScopedLogger } from '@core/logger';
import { getWorkspaceFileSystem } from '@core/workspaceFileSystem';
import { parseOperatorId } from '@shared/types/operators';

const log = createScopedLogger({ service: 'operatorDiaryStore' });

let extractionBreadcrumbEmitted = false;

function ensureExtractionBreadcrumb(): void {
  if (extractionBreadcrumbEmitted) {
    return;
  }
  extractionBreadcrumbEmitted = true;
  log.info({}, 'operators:diary_store_extracted');
}

function resolveDiaryPaths(operatorId: string): {
  operatorSlug: string;
  diaryRelativePath: string;
  diaryLockRelativePath: string;
} {
  const { operatorSlug } = parseOperatorId(operatorId);
  const diaryRelativePath = path.join('operators', operatorSlug, 'diary.md');
  return {
    operatorSlug,
    diaryRelativePath,
    diaryLockRelativePath: `${diaryRelativePath}.lock`,
  };
}

export async function appendDiary(operatorId: string, spacePath: string, entry: string): Promise<void> {
  ensureExtractionBreadcrumb();
  const resolvedSpacePath = path.resolve(spacePath);
  const workspaceFileSystem = getWorkspaceFileSystem();
  if (!workspaceFileSystem.appendFile) {
    throw new Error('WorkspaceFileSystem.appendFile is required for Operator diary appends.');
  }
  const { diaryRelativePath, diaryLockRelativePath } = resolveDiaryPaths(operatorId);
  if (!(await workspaceFileSystem.exists(resolvedSpacePath, diaryLockRelativePath))) {
    await workspaceFileSystem.writeFile(resolvedSpacePath, diaryLockRelativePath, '');
  }

  const diaryLockRealPath = await workspaceFileSystem.realPath(resolvedSpacePath, diaryLockRelativePath);
  const release = await properLockfile.lock(diaryLockRealPath, {
    retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
    realpath: false,
  });

  try {
    if (!(await workspaceFileSystem.exists(resolvedSpacePath, diaryRelativePath))) {
      await workspaceFileSystem.writeFile(resolvedSpacePath, diaryRelativePath, '');
    }
    const stat = await workspaceFileSystem.stat(resolvedSpacePath, diaryRelativePath);
    const entryText = entry.trim();
    const nextChunk = stat.sizeBytes && stat.sizeBytes > 0
      ? `\n${entryText}\n`
      : `${entryText}\n`;
    await workspaceFileSystem.appendFile(resolvedSpacePath, diaryRelativePath, nextChunk);
  } catch (error) {
    log.error({ error, operatorId, spacePath: resolvedSpacePath }, 'diary_append_failed');
    throw error;
  } finally {
    await release();
  }
}

export async function readDiary(operatorId: string, spacePath: string): Promise<string> {
  ensureExtractionBreadcrumb();
  const resolvedSpacePath = path.resolve(spacePath);
  const workspaceFileSystem = getWorkspaceFileSystem();
  const { diaryRelativePath } = resolveDiaryPaths(operatorId);
  if (!(await workspaceFileSystem.exists(resolvedSpacePath, diaryRelativePath))) {
    return '';
  }
  return workspaceFileSystem.readFile(resolvedSpacePath, diaryRelativePath);
}

export function _resetOperatorDiaryStoreForTests(): void {
  extractionBreadcrumbEmitted = false;
}
