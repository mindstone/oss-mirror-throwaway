import { describe, expect, it } from 'vitest';
import {
  OperatorFrontmatterSchema,
  getOperatorFrontmatterWarnings,
  parseOperatorFrontmatterFromContent,
} from '../operatorFrontmatter';

const DEFAULT_BODY = 'This operator body is intentionally present for fallback prompt compatibility.';

function toOperatorContent(frontmatterLines: string[], body = DEFAULT_BODY): string {
  return `---\n${frontmatterLines.join('\n')}\n---\n${body}\n`;
}

describe('operatorFrontmatter schema', () => {
  it('defaults roles to ["operator"] when missing', () => {
    const result = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Brand Critic',
      'description: Keeps copy on voice.',
      'consult_when: Messaging decisions need pushback.',
      'kind: operator',
    ]));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.frontmatter.roles).toEqual(['operator']);
  });

  it('accepts supported role combinations and rejects invalid role arrays', () => {
    const operatorOnly = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Operator Only',
      'description: Async-only persona.',
      'consult_when: Async strategic calls.',
      'kind: operator',
      'roles: [operator]',
    ]));
    expect(operatorOnly.success).toBe(true);
    if (operatorOnly.success) {
      expect(operatorOnly.frontmatter.roles).toEqual(['operator']);
    }

    const liveOnly = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Live Only',
      'description: Live coaching persona.',
      'kind: operator',
      'roles: [live_meeting]',
      'live_prompt: Coach in short tactical nudges.',
    ]));
    expect(liveOnly.success).toBe(true);
    if (liveOnly.success) {
      expect(liveOnly.frontmatter.roles).toEqual(['live_meeting']);
    }

    const bothRoles = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Hybrid Persona',
      'description: Works in both runtimes.',
      'consult_when: Strategic moments.',
      'kind: operator',
      'roles: [operator, live_meeting]',
      'live_prompt: Keep interventions concise.',
    ]));
    expect(bothRoles.success).toBe(true);
    if (bothRoles.success) {
      expect(bothRoles.frontmatter.roles).toEqual(['operator', 'live_meeting']);
    }

    const emptyRoles = OperatorFrontmatterSchema.safeParse({
      name: 'Invalid',
      description: 'Invalid roles.',
      kind: 'operator',
      consult_when: 'Needed for operator role.',
      roles: [],
    });
    expect(emptyRoles.success).toBe(false);

    const unknownRole = OperatorFrontmatterSchema.safeParse({
      name: 'Invalid',
      description: 'Invalid roles.',
      kind: 'operator',
      consult_when: 'Needed for operator role.',
      roles: ['operator', 'not_real_role'],
    });
    expect(unknownRole.success).toBe(false);
  });

  it('parses operator-role personas missing consult_when as a tolerant warning, not a hard reject', () => {
    const operatorMissingConsultWhen = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Missing Consult Trigger',
      'description: Should now parse successfully.',
      'kind: operator',
      'roles: [operator]',
      'consultation_prompt: Fallback consultation prompt.',
    ], ''));
    expect(operatorMissingConsultWhen.success).toBe(true);
    if (operatorMissingConsultWhen.success) {
      expect(operatorMissingConsultWhen.frontmatter.consult_when).toBe('');
      const warnings = getOperatorFrontmatterWarnings(
        operatorMissingConsultWhen.frontmatter,
        '',
      );
      expect(warnings.some((w) => w.field === 'consult_when' && w.kind === 'missing-required')).toBe(true);
    }

    const liveOnlyWithoutConsultWhen = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Live Coach',
      'description: Should pass without consult_when.',
      'kind: operator',
      'roles: [live_meeting]',
      'live_prompt: Coach live meetings.',
    ]));
    expect(liveOnlyWithoutConsultWhen.success).toBe(true);
    if (liveOnlyWithoutConsultWhen.success) {
      expect(liveOnlyWithoutConsultWhen.frontmatter.consult_when).toBe('');
      const warnings = getOperatorFrontmatterWarnings(
        liveOnlyWithoutConsultWhen.frontmatter,
        DEFAULT_BODY,
      );
      expect(warnings.some((w) => w.field === 'consult_when' && w.kind === 'missing-required')).toBe(false);
    }

    const mixedRoleMissingConsultWhen = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Hybrid Persona Missing Trigger',
      'description: Operator+live_meeting persona surfaces a warning, not a hard fail.',
      'kind: operator',
      'roles: [operator, live_meeting]',
      'live_prompt: Coach live meetings.',
      'consultation_prompt: Strategic consults.',
    ], ''));
    expect(mixedRoleMissingConsultWhen.success).toBe(true);
    if (mixedRoleMissingConsultWhen.success) {
      const warnings = getOperatorFrontmatterWarnings(
        mixedRoleMissingConsultWhen.frontmatter,
        '',
      );
      expect(warnings.some((w) => w.field === 'consult_when' && w.kind === 'missing-required')).toBe(true);
    }
  });

  it('parses live_meeting personas missing live_prompt as a tolerant warning', () => {
    const missingLivePrompt = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Missing Live Prompt',
      'description: Should now parse successfully.',
      'kind: operator',
      'roles: [live_meeting]',
    ]));
    expect(missingLivePrompt.success).toBe(true);
    if (missingLivePrompt.success) {
      const warnings = getOperatorFrontmatterWarnings(
        missingLivePrompt.frontmatter,
        DEFAULT_BODY,
      );
      expect(warnings.some((w) => w.field === 'live_prompt' && w.kind === 'missing-required')).toBe(true);
    }

    const operatorWithoutLivePrompt = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Operator Prompt',
      'description: Should pass without live_prompt.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator]',
    ]));
    expect(operatorWithoutLivePrompt.success).toBe(true);
    if (operatorWithoutLivePrompt.success) {
      const warnings = getOperatorFrontmatterWarnings(
        operatorWithoutLivePrompt.frontmatter,
        DEFAULT_BODY,
      );
      expect(warnings.some((w) => w.field === 'live_prompt' && w.kind === 'missing-required')).toBe(false);
    }

    const mixedRoleMissingLivePrompt = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Hybrid Persona Missing Live Prompt',
      'description: Operator+live_meeting persona surfaces a warning, not a hard fail.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator, live_meeting]',
      'consultation_prompt: Strategic consults.',
    ], ''));
    expect(mixedRoleMissingLivePrompt.success).toBe(true);
    if (mixedRoleMissingLivePrompt.success) {
      const warnings = getOperatorFrontmatterWarnings(
        mixedRoleMissingLivePrompt.frontmatter,
        '',
      );
      expect(warnings.some((w) => w.field === 'live_prompt' && w.kind === 'missing-required')).toBe(true);
    }
  });

  it('parses operator-role personas missing both consultation_prompt and body as tolerant warning', () => {
    const missingConsultationPrompt = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Missing Consultation Prompt',
      'description: Should now parse successfully with empty body.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator]',
    ], ''));
    expect(missingConsultationPrompt.success).toBe(true);
    if (missingConsultationPrompt.success) {
      const warnings = getOperatorFrontmatterWarnings(
        missingConsultationPrompt.frontmatter,
        '',
      );
      expect(warnings.some((w) => w.field === 'consultation_prompt' && w.kind === 'missing-required')).toBe(true);
    }

    const withConsultationPrompt = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Frontmatter Prompt Persona',
      'description: Should pass with empty body.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator]',
      'consultation_prompt: Use this prompt when no markdown body exists.',
    ], ''));
    expect(withConsultationPrompt.success).toBe(true);
    if (withConsultationPrompt.success) {
      const warnings = getOperatorFrontmatterWarnings(
        withConsultationPrompt.frontmatter,
        '',
      );
      expect(warnings.some((w) => w.field === 'consultation_prompt' && w.kind === 'missing-required')).toBe(false);
    }
  });

  it('enforces display_name max length at 120 characters', () => {
    const validDisplayName = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Display Name Persona',
      'display_name: ' + 'D'.repeat(120),
      'description: Valid display name length.',
      'consult_when: Strategic consults.',
      'kind: operator',
    ]));
    expect(validDisplayName.success).toBe(true);

    const tooLongDisplayName = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Display Name Persona',
      'display_name: ' + 'D'.repeat(121),
      'description: Invalid display name length.',
      'consult_when: Strategic consults.',
      'kind: operator',
    ]));
    expect(tooLongDisplayName).toMatchObject({
      success: false,
      errorCode: 'invalid-frontmatter',
    });
  });

  it('accepts consultation_prompt up to 10000 chars and emits soft warnings above 2000', () => {
    const maxPrompt = 'c'.repeat(10000);
    const result = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Long Consultation Prompt',
      'description: Uses frontmatter prompt.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator]',
      `consultation_prompt: ${maxPrompt}`,
    ], ''));

    expect(result.success).toBe(true);
    if (!result.success) return;

    const warnings = getOperatorFrontmatterWarnings(result.frontmatter);
    expect(warnings.some((warning) => warning.field === 'consultation_prompt')).toBe(true);

    const tooLong = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Too Long Consultation Prompt',
      'description: Should fail.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator]',
      `consultation_prompt: ${'c'.repeat(10001)}`,
    ], ''));
    expect(tooLong).toMatchObject({
      success: false,
      errorCode: 'invalid-frontmatter',
    });
  });

  it('accepts live_prompt up to 10000 chars and emits soft warnings above 2000', () => {
    const maxPrompt = 'l'.repeat(10000);
    const result = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Long Live Prompt',
      'description: Uses live prompt.',
      'kind: operator',
      'roles: [live_meeting]',
      `live_prompt: ${maxPrompt}`,
    ]));

    expect(result.success).toBe(true);
    if (!result.success) return;

    const warnings = getOperatorFrontmatterWarnings(result.frontmatter);
    expect(warnings.some((warning) => warning.field === 'live_prompt')).toBe(true);

    const tooLong = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Too Long Live Prompt',
      'description: Should fail.',
      'kind: operator',
      'roles: [live_meeting]',
      `live_prompt: ${'l'.repeat(10001)}`,
    ]));
    expect(tooLong).toMatchObject({
      success: false,
      errorCode: 'invalid-frontmatter',
    });
  });

  it('accepts proactive_interval_minutes as a positive int and allows it on operator-only personas', () => {
    const valid = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Interval Persona',
      'description: Operator-only with proactive interval metadata.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator]',
      'proactive_interval_minutes: 5',
    ]));
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.frontmatter.proactive_interval_minutes).toBe(5);
    }

    const zero = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Invalid Zero Interval',
      'description: Should fail.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator]',
      'proactive_interval_minutes: 0',
    ]));
    expect(zero).toMatchObject({
      success: false,
      errorCode: 'invalid-frontmatter',
    });

    const nonInteger = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Invalid Decimal Interval',
      'description: Should fail.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator]',
      'proactive_interval_minutes: 1.5',
    ]));
    expect(nonInteger).toMatchObject({
      success: false,
      errorCode: 'invalid-frontmatter',
    });

    const tooLarge = parseOperatorFrontmatterFromContent(toOperatorContent([
      'name: Invalid Large Interval',
      'description: Should fail.',
      'consult_when: Strategic consults.',
      'kind: operator',
      'roles: [operator]',
      'proactive_interval_minutes: 999999',
    ]));
    expect(tooLarge).toMatchObject({
      success: false,
      errorCode: 'invalid-frontmatter',
    });
  });
});
