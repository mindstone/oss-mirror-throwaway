import { describe, expect, it } from 'vitest';
import {
  SAFETY_PROMPT_BLOCKED_PREFIX,
  backfillToolBlockSource,
} from '../blockSource';

describe('backfillToolBlockSource', () => {
  it('preserves an existing tool block source', () => {
    expect(backfillToolBlockSource('safety_prompt', `${SAFETY_PROMPT_BLOCKED_PREFIX} shell`))
      .toBe('safety_prompt');
    expect(backfillToolBlockSource('eval_error', `${SAFETY_PROMPT_BLOCKED_PREFIX} shell`))
      .toBe('eval_error');
  });

  it('backfills safety_prompt for an exact safety-prefix reason', () => {
    expect(backfillToolBlockSource(undefined, `${SAFETY_PROMPT_BLOCKED_PREFIX} shell can delete files`))
      .toBe('safety_prompt');
  });

  it('does not backfill non-safety reasons', () => {
    expect(backfillToolBlockSource(undefined, 'Some other reason')).toBeUndefined();
    expect(backfillToolBlockSource(undefined, 'Safety rules blocked: lowercase is not canonical')).toBeUndefined();
  });

  it('does not backfill empty or missing reasons', () => {
    expect(backfillToolBlockSource(undefined, '')).toBeUndefined();
    expect(backfillToolBlockSource(undefined, undefined)).toBeUndefined();
  });
});
