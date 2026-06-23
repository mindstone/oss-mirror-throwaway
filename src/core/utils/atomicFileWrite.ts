import { writeFile, writeFileSync } from 'atomically';
import { getErrorMessage } from './getErrorMessage';

export interface WriteResult {
  durable: boolean;
  error?: string;
  errorCode?: string;
}

const DISK_WRITE_ERROR_CODES = new Set(['ENOSPC', 'EACCES', 'EROFS', 'EPERM', 'EBUSY']);
const UNKNOWN_ERROR_CODE = 'UNKNOWN';

function classifyWriteErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== 'string') return UNKNOWN_ERROR_CODE;

  // Windows note: antivirus/indexers commonly raise EPERM/EBUSY for transient file contention.
  if (DISK_WRITE_ERROR_CODES.has(code)) return code;

  return UNKNOWN_ERROR_CODE;
}

function buildWriteFailure(error: unknown): WriteResult {
  return {
    durable: false,
    error: getErrorMessage(error),
    errorCode: classifyWriteErrorCode(error),
  };
}

export async function atomicWriteFile(filePath: string, data: string): Promise<WriteResult> {
  try {
    await writeFile(filePath, data, 'utf8');
    return { durable: true };
  } catch (error) {
    return buildWriteFailure(error);
  }
}

export function atomicWriteFileSync(filePath: string, data: string): WriteResult {
  try {
    writeFileSync(filePath, data, 'utf8');
    return { durable: true };
  } catch (error) {
    return buildWriteFailure(error);
  }
}
