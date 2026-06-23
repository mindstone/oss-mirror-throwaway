import { WriteFailureError } from '@shared/utils/documentIoErrorClassification';

export type WriteFilePayload = {
  path: string;
  content: string;
  baseContentHash?: string;
};

export type WriteFileSuccessEnvelope = {
  result: 'ok';
  path: string;
  updatedAt?: number;
  currentHash?: string;
};

export type WriteFileConflictEnvelope = {
  result: 'conflict';
  path: string;
  currentHash: string;
};

type WriteFileFailedEnvelope = {
  result: 'failed';
  errorCode: string;
};

export type WriteFileOrFailResult =
  | WriteFileSuccessEnvelope
  | WriteFileConflictEnvelope;

/**
 * Writes a library file through the renderer IPC bridge.
 *
 * Throws on I/O failure (`'failed'`). Returns the conflict envelope unchanged
 * because conflict is product state, not I/O failure — caller must explicitly
 * handle `result === 'conflict'`.
 */
export async function writeFileOrFail(payload: WriteFilePayload): Promise<WriteFileOrFailResult> {
  const result: WriteFileOrFailResult | WriteFileFailedEnvelope = await window.libraryApi.writeFile(payload);
  if (result.result === 'failed') {
    throw new WriteFailureError(result.errorCode);
  }
  return result;
}
