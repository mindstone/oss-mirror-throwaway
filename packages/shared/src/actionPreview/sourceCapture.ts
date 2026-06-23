import type { ActionPreviewInput, StagedFileActionPreviewInput } from './model';

const SOURCE_CAPTURE_AUTOMATION_ID = 'system-source-capture';
// Matches the renderer extractor pattern: yyMMdd_HHmm_sourceType_description.md
const SOURCE_CAPTURE_FILENAME_RE = /^(\d{6})_(\d{4})_([a-z]+)_(.+)\.md$/;

function basename(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.at(-1) ?? filePath;
}

function isMemoryOrStagedFileInput(
  input: ActionPreviewInput,
): input is ActionPreviewInput & { kind: 'memory' | 'staged-file' } {
  return input.kind === 'memory' || input.kind === 'staged-file';
}

export function isSourceCaptureFileName(filePath: string): boolean {
  const fileName = basename(filePath);
  return SOURCE_CAPTURE_FILENAME_RE.test(fileName);
}

export function hasSourceCaptureEvidence(input: ActionPreviewInput): boolean {
  if (!isMemoryOrStagedFileInput(input)) return false;
  if (input.automationId === SOURCE_CAPTURE_AUTOMATION_ID) return true;
  return isSourceCaptureFileName(input.filePath);
}

export function hasNetNewEvidence(input: ActionPreviewInput): boolean {
  if (!isMemoryOrStagedFileInput(input)) return false;
  return input.isNewFile === true
    || ((input as StagedFileActionPreviewInput).baseHash ?? '').toLowerCase() === 'new-file';
}
