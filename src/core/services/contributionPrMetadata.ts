import { createScopedLogger } from '@core/logger';
import {
  appendBuildContextAppendix,
  BODY_MAX,
  buildValidationEvidence,
  composePrMetadata,
  hasUserPrFormContent,
  MAX_APPENDIX_LEN,
  sanitizeForGitHub,
  type AppendixWarning,
  type BuildContext,
  type ComposePrMetadataInput,
  type ConfigInferenceResult,
} from '@core/services/contributionPrFormatter';
import type { ConnectorContribution } from '@core/services/contributionTypes';

const log = createScopedLogger({ service: 'contribution-pr-metadata' });

const SANITIZE_TAG_COUNT_PATTERN = /<(script|iframe|object|embed)\b/gi;

function countSanitizationStrips(input: string): number {
  const matches = input.match(SANITIZE_TAG_COUNT_PATTERN);
  return matches ? matches.length : 0;
}

export type PrecedenceBranch = 'user_form' | 'agent_override' | 'formatter_default';

export type ComposePrMetadataFromContributionResult = {
  title: string;
  body: string;
  precedenceBranch: PrecedenceBranch;
  hadPrTitleOverride: boolean;
  hadPrBodyOverride: boolean;
  mutatedFields: string[];
  strippedSequenceCount: number;
};

export type ComposePrMetadataFromContributionContext = {
  submissionPath: 'Rebel relay' | 'GitHub fork';
  attributionMode: 'rebel-name' | 'github' | 'anonymous';
  attributionName: string | undefined;
  includeSubmitterInTitle: boolean;
  configResult: ConfigInferenceResult;
  inferredSummary?: string;
  buildContext?: BuildContext;
};

function emitAppendixWarnings(
  contributionId: string,
  submissionPath: 'Rebel relay' | 'GitHub fork',
  precedenceBranch: PrecedenceBranch,
  warnings: readonly AppendixWarning[],
): void {
  for (const warning of warnings) {
    log.warn(
      { contributionId, submissionPath, precedenceBranch, warning },
      'Build Context appendix warning',
    );
  }
}

export function composePrMetadataFromContribution(
  contribution: ConnectorContribution,
  ctx: ComposePrMetadataFromContributionContext,
): ComposePrMetadataFromContributionResult {
  const userFormEngaged = hasUserPrFormContent({
    summary: contribution.summary,
    motivation: contribution.motivation,
    reviewerNotes: contribution.reviewerNotes,
  });

  const hadPrTitleOverride =
    typeof contribution.prTitle === 'string' && contribution.prTitle.trim() !== '';
  const hadPrBodyOverride =
    typeof contribution.prBody === 'string' && contribution.prBody.trim() !== '';

  const baseInput: ComposePrMetadataInput = {
    connectorName: contribution.connectorName,
    attributionMode: ctx.attributionMode,
    attributionName: ctx.attributionName,
    includeSubmitterInTitle: ctx.includeSubmitterInTitle,
    submissionPath: ctx.submissionPath,
    summary: contribution.summary,
    inferredSummary: ctx.inferredSummary,
    motivation: contribution.motivation,
    reviewerNotes: contribution.reviewerNotes,
    configResult: ctx.configResult,
    validationEvidence: buildValidationEvidence(),
  };

  const appendBuildContextToBody = (
    body: string,
    precedenceBranch: PrecedenceBranch,
  ): string => {
    if (!ctx.buildContext) {
      return body;
    }
    const appended = appendBuildContextAppendix(body, ctx.buildContext, {
      bodyMax: BODY_MAX,
      maxAppendixLen: MAX_APPENDIX_LEN,
    });
    emitAppendixWarnings(
      contribution.id,
      ctx.submissionPath,
      precedenceBranch,
      appended.warnings,
    );
    return appended.body;
  };

  if (userFormEngaged) {
    const metadata = composePrMetadata(baseInput);
    return {
      title: metadata.title,
      body: appendBuildContextToBody(metadata.body, 'user_form'),
      precedenceBranch: 'user_form',
      hadPrTitleOverride,
      hadPrBodyOverride,
      mutatedFields: [],
      strippedSequenceCount: 0,
    };
  }

  const defaultInput: ComposePrMetadataInput = {
    ...baseInput,
    summary: undefined,
    motivation: undefined,
    reviewerNotes: undefined,
  };
  const defaultMetadata = composePrMetadata(defaultInput);

  if (hadPrTitleOverride || hadPrBodyOverride) {
    let title = defaultMetadata.title;
    let body = defaultMetadata.body;
    const mutatedFields: string[] = [];
    let strippedSequenceCount = 0;

    if (hadPrTitleOverride) {
      const raw = contribution.prTitle as string;
      const sanitized = sanitizeForGitHub(raw);
      if (sanitized !== raw) {
        mutatedFields.push('prTitle');
        strippedSequenceCount += countSanitizationStrips(raw);
      }
      title = sanitized;
    }
    if (hadPrBodyOverride) {
      const raw = contribution.prBody as string;
      const sanitized = sanitizeForGitHub(raw);
      if (sanitized !== raw) {
        mutatedFields.push('prBody');
        strippedSequenceCount += countSanitizationStrips(raw);
      }
      body = sanitized;
    }

    return {
      title,
      body: appendBuildContextToBody(body, 'agent_override'),
      precedenceBranch: 'agent_override',
      hadPrTitleOverride,
      hadPrBodyOverride,
      mutatedFields,
      strippedSequenceCount,
    };
  }

  return {
    title: defaultMetadata.title,
    body: appendBuildContextToBody(defaultMetadata.body, 'formatter_default'),
    precedenceBranch: 'formatter_default',
    hadPrTitleOverride,
    hadPrBodyOverride,
    mutatedFields: [],
    strippedSequenceCount: 0,
  };
}
