import { describe, expect, it } from 'vitest';
import {
  DecisionNextActionSchema,
  deriveChatSafeGuidance,
  deriveSoftwareEngineerRecoveryGuidance,
} from '../decisionEnvelope';

describe('decisionEnvelope', () => {
  it('extends DecisionNextActionSchema with run_software_engineer_workflow', () => {
    expect(DecisionNextActionSchema.parse('run_software_engineer_workflow')).toBe('run_software_engineer_workflow');
  });

  it('returns chat-safe guidance for run_software_engineer_workflow', () => {
    expect(deriveChatSafeGuidance('run_software_engineer_workflow')).toBe(
      'Let me think this through properly before I share it.',
    );
  });

  it('derives software engineer recovery guidance variant A when invalidation reason is absent', () => {
    expect(deriveSoftwareEngineerRecoveryGuidance({})).toEqual({
      chatSafe: 'Let me think this through properly before I share it.',
      internal:
        'You reported ready_to_submit on a non-trivial connector without invoking the Software Engineer workflow. Read rebel-system/skills/workflows/software-engineer/SKILL.md, then re-run the build phases as the SE planner/implementer/reviewer. Re-call rebel_mcp_report_contribution_state(status: "ready_to_submit", ...) once docs/build-plan.md reflects the SE working-doc template (workflow: software-engineer, models.*, ## Review History).',
    });
  });

  it('derives software engineer recovery guidance variant B for fingerprint mismatch invalidation', () => {
    expect(deriveSoftwareEngineerRecoveryGuidance({ invalidationReason: 'fingerprint_mismatch' })).toEqual({
      chatSafe: 'Let me think this through properly before I share it.',
      internal:
        'You ran the Software Engineer workflow earlier, but the connector code has changed since. The SE evidence on this contribution was invalidated and must be refreshed against the current build state. Re-invoke the Software Engineer workflow against the current connector path. The SE working doc at docs/build-plan.md should be updated (or re-created) to reflect the changed code. Re-call rebel_mcp_report_contribution_state(status: "ready_to_submit", ...) once SE has run on the new build state.',
    });
  });
});
