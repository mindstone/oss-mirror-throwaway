import {
  describeFileLocation,
  legacyMissingLocation,
} from '../../fileLocation';
import type {
  ActionPreviewInput,
  ActionPreviewModel,
  ContentVisibility,
  GenericStructuredRow,
  MemoryActionPreviewInput,
  StagedFileActionPreviewInput,
} from '../model';
import { projectGenericStructured } from './generic';
import { projectBlastRadius } from './blastRadius';
import { hasNetNewEvidence } from '../sourceCapture';

const MAX_EXCERPTS = 4;
const MAX_EXCERPT_LENGTH = 260;

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? filePath;
}

function asMemoryOrStagedFile(
  input: ActionPreviewInput,
): MemoryActionPreviewInput | StagedFileActionPreviewInput | null {
  if (input.kind === 'memory' || input.kind === 'staged-file') {
    return input;
  }
  return null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSpaceName(spaceName: string): string {
  return /chief[\s-_]*of[\s-_]*staff/i.test(spaceName) ? 'Chief-of-Staff' : spaceName;
}

function deriveSharingLabel(
  sharing: MemoryActionPreviewInput['sharing'],
): string | null {
  switch (sharing) {
    case 'private':
      return 'Private to you';
    case 'restricted':
      return 'Shared workspace';
    case 'company-wide':
      return 'Company-wide';
    case 'public':
      return 'Public';
    default:
      return null;
  }
}

function deriveContentVisibility(
  input: MemoryActionPreviewInput | StagedFileActionPreviewInput,
): ContentVisibility {
  if (input.sensitivityReason) return 'withheld';
  if (toNonEmptyString(input.summary)) return 'safe';
  if (toNonEmptyString(input.contentPreview)) return 'safe';
  if (input.kind === 'memory' && toNonEmptyString(input.content)) return 'safe';
  return 'unknown';
}

function deriveSummary(
  input: MemoryActionPreviewInput | StagedFileActionPreviewInput,
): string | null {
  return toNonEmptyString(input.summary)
    ?? toNonEmptyString(input.contentPreview)
    ?? (input.kind === 'memory' ? toNonEmptyString(input.content) : null);
}

function truncate(value: string): string {
  if (value.length <= MAX_EXCERPT_LENGTH) return value;
  return `${value.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

function deriveExcerpts(
  input: MemoryActionPreviewInput | StagedFileActionPreviewInput,
): string[] {
  const bodySource = toNonEmptyString(input.contentPreview)
    ?? (input.kind === 'memory' ? toNonEmptyString(input.content) : null)
    ?? null;
  if (!bodySource) return [];

  const candidateLines = bodySource
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (candidateLines.length === 0) {
    return [truncate(bodySource)];
  }

  return candidateLines.slice(0, MAX_EXCERPTS).map((line) => truncate(line));
}

function buildRows(summary: string | null, excerpts: string[]): GenericStructuredRow[] {
  const rows: GenericStructuredRow[] = [];
  if (summary) {
    rows.push({ key: 'what will be saved', value: summary });
  }
  excerpts.forEach((excerpt, index) => {
    rows.push({ key: `excerpt ${index + 1}`, value: excerpt });
  });
  return rows;
}

export function projectDataCapture(input: ActionPreviewInput): ActionPreviewModel {
  const fileInput = asMemoryOrStagedFile(input);
  if (!fileInput) {
    return projectGenericStructured(input, 'data-capture');
  }

  const { blastRadius, reversibility, riskReasons } = projectBlastRadius(fileInput, 'data-capture');
  const whereLabel = blastRadius.where[0]?.label ?? normalizeSpaceName(fileInput.spaceName);
  const audienceLabel = deriveSharingLabel(fileInput.sharing);
  const location = describeFileLocation(legacyMissingLocation({
    fileName: basename(fileInput.filePath),
    spaceName: normalizeSpaceName(fileInput.spaceName),
    legacyPath: fileInput.filePath,
  }));

  const contentVisibility = deriveContentVisibility(fileInput);
  const summary = contentVisibility === 'safe' ? deriveSummary(fileInput) : null;
  const excerpts = contentVisibility === 'safe' ? deriveExcerpts(fileInput) : [];
  const structuredArgs = contentVisibility === 'safe' ? buildRows(summary, excerpts) : [];
  const isNew = hasNetNewEvidence(fileInput);

  const safeRawArgs: Record<string, unknown> = {
    where: whereLabel,
    location: location.shortLabel,
    path: fileInput.filePath,
    isNew,
  };
  if (audienceLabel) {
    safeRawArgs.sharing = audienceLabel;
  }
  if (contentVisibility === 'safe') {
    if (summary) safeRawArgs.summary = summary;
    if (excerpts.length > 0) safeRawArgs.excerpts = excerpts;
  }

  const normalizedSpace = normalizeSpaceName(fileInput.spaceName);
  return {
    effectKind: 'data-capture',
    title: normalizedSpace.length > 0 ? `Save to ${normalizedSpace}` : 'Save captured source',
    contentVisibility,
    blastRadius,
    reversibility,
    riskReasons,
    structuredArgs,
    safeRawArgs,
  };
}
