import { describe, expect, it } from 'vitest';
import { getStagedFileWhyText } from '../approvalWhyText';
import type { StagedFileItem } from '../../hooks/useStagedFiles';
import {
  EVAL_ERROR_FORBIDDEN_SURFACE_SUBSTRINGS,
  buildEvalErrorUserReason,
} from '@shared/safety/evalErrorCopy';

function makeStagedFile(overrides: Partial<StagedFileItem> = {}): StagedFileItem {
  return {
    id: 'staged-file-id',
    realPath: '/workspace/General/notes.md',
    fileName: 'notes.md',
    spaceName: 'General',
    spacePath: 'General/notes.md',
    sessionId: 'session-id',
    sessionTitle: null,
    baseHash: 'new-file',
    summary: 'Summary',
    stagedAt: Date.UTC(2026, 3, 23),
    sensitivity: 'high',
    ...overrides,
  };
}

describe('getStagedFileWhyText', () => {
  it('returns safety prompt copy for safety_prompt blocks', () => {
    // BASELINE: F4 — generic text, no rule specifics. After fix, should reference the matched rule.
    const result = getStagedFileWhyText(makeStagedFile({ blockedBy: 'safety_prompt' }));
    expect(result).toBe('Your safety rules flagged saving "notes.md" to General.');
  });

  it('returns sensitivity copy for sensitivity_eval blocks', () => {
    const result = getStagedFileWhyText(makeStagedFile({ blockedBy: 'sensitivity_eval' }));
    expect(result).toBe('I spotted content that might be sensitive. Worth a quick check before publishing.');
  });

  it('returns structural policy copy for structural_policy blocks', () => {
    const result = getStagedFileWhyText(makeStagedFile({ blockedBy: 'structural_policy' }));
    expect(result).toBe('This space requires approval for all saves.');
  });

  it('returns eval error copy for eval_error blocks', () => {
    const result = getStagedFileWhyText(makeStagedFile({ blockedBy: 'eval_error' }));
    expect(result).toBe(buildEvalErrorUserReason());
  });

  it('keeps eval_error why copy free of policy-block/risk framing', () => {
    const result = getStagedFileWhyText(makeStagedFile({ blockedBy: 'eval_error' }));
    expect(result).toBeTruthy();
    const lower = result!.toLowerCase();
    for (const forbidden of EVAL_ERROR_FORBIDDEN_SURFACE_SUBSTRINGS) {
      expect(lower).not.toContain(forbidden);
    }
  });

  it('returns sharing fallback text when blockedBy is missing and sharing is company-wide', () => {
    const result = getStagedFileWhyText(
      makeStagedFile({
        blockedBy: undefined,
        sharing: 'company-wide',
        spaceName: 'Executive Updates',
      }),
    );
    expect(result).toContain('Executive Updates');
    expect(result).toContain('the whole company');
  });

  it('returns undefined when blockedBy is missing and sharing is private', () => {
    const result = getStagedFileWhyText(
      makeStagedFile({
        blockedBy: undefined,
        sharing: 'private',
      }),
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when blockedBy and sharing are missing', () => {
    const result = getStagedFileWhyText(
      makeStagedFile({
        blockedBy: undefined,
        sharing: undefined,
      }),
    );
    expect(result).toBeUndefined();
  });
});
