import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_SYNC_TEMP_MARKER } from '@shared/workspaceConstants';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export interface AtomicWriteResult {
  tempPath: string;
}

function buildTempPath(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}${WORKSPACE_SYNC_TEMP_MARKER}`,
  );
}

function cleanupTemp(tempPath: string): void {
  try {
    fs.rmSync(tempPath, { force: true });
  } catch (err) {
    // Best-effort cleanup after a failed atomic write; caller logs the real failure.
    ignoreBestEffortCleanup(err, {
      operation: 'cloudAtomicWrite.cleanupTemp',
      reason: 'temp-file-removal-after-failed-write',
      owner: 'main.cloudAtomicWrite',
    });
  }
}

export function writeFileAtomicInTargetDirSync(
  targetPath: string,
  content: string,
  encoding: BufferEncoding = 'utf8',
): AtomicWriteResult {
  const tempPath = buildTempPath(targetPath);
  let fd: number | null = null;

  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, content, { encoding });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, targetPath);
    return { tempPath };
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeErr) {
        // Best-effort cleanup; preserve the original write/rename error.
        ignoreBestEffortCleanup(closeErr, {
          operation: 'cloudAtomicWrite.writeFileAtomicInTargetDirSync',
          reason: 'close-temp-fd-on-error',
          owner: 'main.cloudAtomicWrite',
        });
      }
    }
    cleanupTemp(tempPath);
    throw err;
  }
}

export async function writeFileAtomicInTargetDir(
  targetPath: string,
  content: string,
  encoding: BufferEncoding = 'utf8',
): Promise<AtomicWriteResult> {
  const tempPath = buildTempPath(targetPath);
  let handle: fs.promises.FileHandle | null = null;

  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(content, { encoding });
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, targetPath);
    return { tempPath };
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeErr) {
        // Best-effort cleanup; preserve the original write/rename error.
        ignoreBestEffortCleanup(closeErr, {
          operation: 'cloudAtomicWrite.writeFileAtomicInTargetDir',
          reason: 'close-temp-handle-on-error',
          owner: 'main.cloudAtomicWrite',
        });
      }
    }
    try {
      await fs.promises.rm(tempPath, { force: true });
    } catch (rmErr) {
      // Best-effort cleanup after a failed atomic write.
      ignoreBestEffortCleanup(rmErr, {
        operation: 'cloudAtomicWrite.writeFileAtomicInTargetDir',
        reason: 'temp-file-removal-after-failed-write',
        owner: 'main.cloudAtomicWrite',
      });
    }
    throw err;
  }
}
