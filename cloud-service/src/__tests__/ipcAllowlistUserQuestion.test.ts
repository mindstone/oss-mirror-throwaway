/**
 * Stage 3b — Cloud-service IPC allowlist coverage for the user-question
 * response channel.
 *
 * Asserts that `agent:user-question-response` is allowlisted on the generic
 * /api/ipc/:channel endpoint. Mobile calls this channel directly against the
 * cloud service to submit an answer to an AskUserQuestion batch that paused
 * a turn. Handler is registered in bootstrap.ts via
 * registerUserQuestionResponseHandler().
 *
 * See: docs/plans/260420_user_question_cross_surface_resilience.md (Stage 3b)
 */

import { describe, it, expect } from 'vitest';
import { CLOUD_IPC_ALLOWLIST } from '../routes/ipc';

describe('cloud-service IPC allowlist — user-question response', () => {
  it('allows agent:user-question-response', () => {
    expect(CLOUD_IPC_ALLOWLIST.has('agent:user-question-response')).toBe(true);
  });
});
