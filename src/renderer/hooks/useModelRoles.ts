import type { AppSettings, ModelProfile } from '@shared/types';
import { resolveAllRoleAssignments, type RoleAssignment } from '@core/rebelCore/roleAssignment';
import type { ProfileConnectivity } from '@shared/utils/connectivityHelpers';

export interface ResolvedRole {
  label: string;
  modelName: string;
  isCustom: boolean;
}

function resolvedRoleFrom(label: string, assignment: RoleAssignment, fallbackName: string): ResolvedRole {
  // Status-truthful: when the user's choice is broken, reflect that in the
  // breadcrumb name so it matches Settings rather than silently falling
  // through to a stale model id.
  switch (assignment.status.kind) {
    case 'ok': {
      const isCustom = assignment.status.source === 'profile';
      return {
        label,
        modelName: assignment.display.modelLabel || fallbackName,
        isCustom,
      };
    }
    case 'no-selection':
    case 'missing-profile':
    case 'assigned-but-disconnected':
    case 'incomplete-profile':
      return { label, modelName: assignment.warning ?? 'Not configured', isCustom: false };
    case 'profile-unavailable-model-active':
      return {
        label,
        modelName: assignment.display.modelLabel || fallbackName,
        isCustom: false,
      };
    case 'auto':
      return { label, modelName: 'Automatic', isCustom: false };
    case 'off':
      return { label, modelName: 'Off', isCustom: false };
  }
}

/**
 * Pure function that resolves Working, Thinking, and Background model roles
 * from settings and profile data. Forwards through `resolveAllRoleAssignments`
 * so breadcrumbs match the Settings panel and the runtime resolver.
 *
 * @see docs/plans/260509_centralize_model_role_selection.md
 */
export function resolveModelRoles(
  draftSettings: AppSettings,
  profiles: ModelProfile[],
  connectivity?: ProfileConnectivity,
): { working: ResolvedRole; thinking: ResolvedRole; background: ResolvedRole; hasAnyCustom: boolean } {
  const all = resolveAllRoleAssignments(draftSettings, { profiles, connectivity });
  const working = resolvedRoleFrom('Working', all.working, 'Sonnet 4.6');
  const thinking = resolvedRoleFrom('Thinking', all.thinking, 'Off');
  const background = resolvedRoleFrom('Background', all.background, 'Haiku 4.5');
  const hasAnyCustom = working.isCustom || thinking.isCustom || background.isCustom;
  return { working, thinking, background, hasAnyCustom };
}
