import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkRoleResolutionChokepoint } from '../check-role-resolution-chokepoint';
import { STEPS } from '../run-validate-fast';
import { GUARD_NAMES as SOURCE_POLICY_GUARDS } from '../groups/source-policy-chokepoints';

const CONVERSATION_SELECTOR = path.join('src', 'renderer', 'features', 'agent-session', 'components', 'ConversationModelSelector.tsx');
const QUALITY_TIERS = path.join('src', 'shared', 'data', 'qualityTiers.ts');

function runGuard(sources: Record<string, string>) {
  return checkRoleResolutionChokepoint((relativePath) => sources[relativePath] ?? '');
}

describe('check-role-resolution-chokepoint', () => {
  it('passes the migrated canonical resolver shape', () => {
    const violations = runGuard({
      [CONVERSATION_SELECTOR]: `
        import { resolveAllRoleAssignments } from '@core/rebelCore/roleAssignment';
        const globalRoleAssignments = resolveAllRoleAssignments(settings, { profiles });
        const globalWorkingName = globalRoleAssignments.working.display.modelLabel;
      `,
      [QUALITY_TIERS]: `
        export interface QualityTierResolvedGlobalDefault {
          workingEffectiveModelId?: string | null;
          thinkingEffectiveModelId?: string | null;
          workingProfileRef?: string;
          thinkingProfileRef?: string;
        }
        export function overridesMatchGlobalDefault(overrides: unknown, resolvedGlobal: QualityTierResolvedGlobalDefault): boolean {
          return Boolean(overrides || resolvedGlobal);
        }
      `,
    });

    expect(violations).toEqual([]);
  });

  it('fails when ConversationModelSelector drops resolveAllRoleAssignments', () => {
    const violations = runGuard({
      [CONVERSATION_SELECTOR]: `const globalWorkingName = 'Custom';`,
      [QUALITY_TIERS]: `
        export interface QualityTierResolvedGlobalDefault {}
        export function overridesMatchGlobalDefault(overrides: unknown, resolvedGlobal: QualityTierResolvedGlobalDefault): boolean {
          return Boolean(overrides || resolvedGlobal);
        }
      `,
    });

    expect(violations.map((violation) => violation.message).join('\n')).toContain('resolveAllRoleAssignments()');
  });

  it('catches the pre-migration profile-id-to-model lookup shape', () => {
    const violations = runGuard({
      [CONVERSATION_SELECTOR]: `
        import { resolveAllRoleAssignments } from '@core/rebelCore/roleAssignment';
        const globalWorkingModel = profiles.find((p) => p.id === globalWorkingProfileId)?.model;
      `,
      [QUALITY_TIERS]: `
        export interface QualityTierResolvedGlobalDefault {}
        export function overridesMatchGlobalDefault(overrides: unknown, resolvedGlobal: QualityTierResolvedGlobalDefault): boolean {
          return Boolean(overrides || resolvedGlobal);
        }
      `,
    });

    expect(violations.map((violation) => violation.message).join('\n')).toContain('raw-role-profile-model-lookup');
  });

  it('fails if qualityTiers reverts to raw globalDefaults + profiles', () => {
    const violations = runGuard({
      [CONVERSATION_SELECTOR]: `
        import { resolveAllRoleAssignments } from '@core/rebelCore/roleAssignment';
        resolveAllRoleAssignments(settings, { profiles });
      `,
      [QUALITY_TIERS]: `
        export function overridesMatchGlobalDefault(overrides: unknown, globalDefaults: unknown, profiles: unknown[]): boolean {
          return Boolean(overrides || globalDefaults || profiles);
        }
      `,
    });

    const messages = violations.map((violation) => violation.message).join('\n');
    expect(messages).toContain('QualityTierResolvedGlobalDefault');
    expect(messages).toContain('raw-global-defaults-plus-profiles-api');
  });

  it('is wired into validate:fast via the source-policy-chokepoints group', () => {
    expect(STEPS.map((step) => step.name)).toContain('validate:source-policy-chokepoints');
    expect(SOURCE_POLICY_GUARDS).toContain('check-role-resolution-chokepoint');
  });
});
