import { describe, expect, it } from 'vitest';
import {
  EVAL_ERROR_FORBIDDEN_SURFACE_SUBSTRINGS,
  buildEvalErrorAgentReason,
  buildEvalErrorUserReason,
} from '../evalErrorCopy';

describe('evalErrorCopy', () => {
  it('keeps eval_error agent/user copy free of policy-block and risk framing', () => {
    const surfaces = [
      buildEvalErrorAgentReason('Send email'),
      buildEvalErrorUserReason(),
    ];

    for (const text of surfaces) {
      const lower = text.toLowerCase();
      for (const forbidden of EVAL_ERROR_FORBIDDEN_SURFACE_SUBSTRINGS) {
        expect(lower).not.toContain(forbidden);
      }
    }
  });
});
