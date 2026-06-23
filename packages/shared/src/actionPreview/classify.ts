import { isSideEffectVerb } from '../toolVerbs';
import { detectMessageKind } from './projectors/message';
import { hasNetNewEvidence, hasSourceCaptureEvidence } from './sourceCapture';
import type {
  ActionEffectKind,
  ActionPreviewInput,
  StagedToolActionPreviewInput,
  ToolActionPreviewInput,
} from './model';

const EXTERNAL_RECORD_PACKAGES = [
  'hubspot',
  'salesforce',
  'zendesk',
  'notion',
  'linear',
  'jira',
  'github',
  'airtable',
  'trello',
  'intercom',
] as const;

function getToolLikeFields(input: ToolActionPreviewInput | StagedToolActionPreviewInput): {
  toolIdLike: string;
  packageIdLike: string;
  args: Record<string, unknown>;
} {
  const toolIdLike = input.kind === 'tool'
    ? `${input.effectiveToolId ?? ''} ${input.toolName}`.trim()
    : `${input.toolId} ${input.displayName ?? ''}`.trim();
  return {
    toolIdLike: toolIdLike.toLowerCase(),
    packageIdLike: (input.packageId ?? '').toLowerCase(),
    args: input.args ?? {},
  };
}

function hasBrowserEvidence(input: ToolActionPreviewInput | StagedToolActionPreviewInput): boolean {
  const { packageIdLike, toolIdLike } = getToolLikeFields(input);
  return packageIdLike.includes('browser') || toolIdLike.includes('browser');
}

function hasExternalRecordEvidence(input: ToolActionPreviewInput | StagedToolActionPreviewInput): boolean {
  const { packageIdLike, toolIdLike } = getToolLikeFields(input);
  if (!isSideEffectVerb(toolIdLike)) return false;
  return EXTERNAL_RECORD_PACKAGES.some((pkg) => packageIdLike.includes(pkg) || toolIdLike.includes(pkg));
}

function hasCommandEvidence(input: ToolActionPreviewInput | StagedToolActionPreviewInput): boolean {
  const { packageIdLike, toolIdLike, args } = getToolLikeFields(input);
  const hasCommandArg = typeof args.command === 'string' && args.command.trim().length > 0;
  const hasShellNaming =
    packageIdLike.includes('bash')
    || packageIdLike.includes('shell')
    || toolIdLike.includes('bash')
    || toolIdLike.includes('shell')
    || toolIdLike.includes('terminal');
  return hasCommandArg || hasShellNaming;
}

export function classifyEffectKind(input: ActionPreviewInput): ActionEffectKind {
  if (input.kind === 'memory' || input.kind === 'staged-file') {
    // Conflicts must always stay on document/diff paths.
    if (input.hasConflict === true) {
      return 'document';
    }

    const sourceCaptureEvidence = hasSourceCaptureEvidence(input);
    const netNewEvidence = hasNetNewEvidence(input);
    if (sourceCaptureEvidence && netNewEvidence) {
      return 'data-capture';
    }
    return 'document';
  }

  if (detectMessageKind(input) !== null) return 'message';
  if (hasCommandEvidence(input)) return 'command';
  if (hasBrowserEvidence(input)) return 'browser';
  if (hasExternalRecordEvidence(input)) return 'external-record';
  return 'generic';
}
