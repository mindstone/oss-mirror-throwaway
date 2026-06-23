/**
 * # ModelChoice — canonical "pick a model" type
 *
 * Single discriminated union representing every way a user (or the system)
 * can fill a model role. Replaces three storage encodings with one renderer
 * shape:
 *
 *   - dual fields (`workingProfileId` OR `model`; `thinkingProfileId` OR
 *     `thinkingModel`)
 *   - prefix-encoded strings (`profile:<id>` / `model:<id>` / bare)
 *   - UI sentinels (`auto` / `off`)
 *
 * Storage stays as it is. The codec in `@shared/utils/modelChoiceCodec`
 * round-trips between persisted settings and `ModelChoice`. Every consumer
 * (resolver, picker, fallback handling, conversation overrides) reasons
 * about `ModelChoice` and never about raw fields directly.
 *
 * @see docs/plans/260509_centralize_model_role_selection.md
 */

/**
 * The five things a role assignment can be:
 *
 *  - `model`: a curated catalog model id (e.g. `claude-opus-4-7`,
 *    `gpt-5.5`, `anthropic/claude-sonnet-4-6`)
 *  - `profile`: a user-managed profile id, resolved against
 *    `localModel.profiles`
 *  - `inherit`: explicit "use the working role's model" (Thinking only)
 *  - `auto`: explicit "Rebel picks something sensible" (Recovery only)
 *  - `off`: explicit "do not use this role" (Thinking, Recovery)
 *
 * Roles that don't support a given variant simply never receive it — the
 * union stays exhaustive at the type level so reducers/displays can rely
 * on it.
 */
import type { ModelRoleTier } from './agent';

export type ModelChoice =
  | { kind: 'model'; modelId: string }
  | { kind: 'profile'; profileId: string }
  | { kind: 'inherit' }
  | { kind: 'auto' }
  | { kind: 'off' };

/**
 * Roles whose model is computed by `resolveRoleAssignment`: the canonical
 * capability tiers ({@link ModelRoleTier}) plus the `'recovery'` slot (a
 * configurable long-context fallback model, distinct from the trio). Built on
 * `ModelRoleTier` so tier membership has a single source of truth.
 */
export type RoleId = ModelRoleTier | 'recovery';

/**
 * Generic human-facing label for each role. NOTE: the Settings UI overrides
 * these per-row via the `label` prop (currently "Main work" / "Planner" /
 * "Behind the Scenes"), so these are fallbacks for any surface that renders a
 * role label without supplying its own — do NOT treat them as the canonical
 * display names, and don't assume they match the Settings IA.
 */
export const ROLE_LABELS: Record<RoleId, string> = {
  working: 'Working',
  thinking: 'Thinking',
  background: 'Background',
  recovery: 'Recovery',
};

/**
 * Whether a role supports a given `ModelChoice.kind`. Used by the picker to
 * generate the right set of options per role.
 */
export function roleSupports(role: RoleId, kind: ModelChoice['kind']): boolean {
  switch (kind) {
    case 'model':
    case 'profile':
      return true;
    case 'inherit':
      return role === 'thinking';
    case 'auto':
      return role === 'recovery';
    case 'off':
      return role === 'thinking' || role === 'recovery';
  }
}
