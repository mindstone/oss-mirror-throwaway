/**
 * Memory-write safety-level policy resolvers.
 *
 * Pure policy logic extracted from `memoryWriteHook.ts` (behavior-preserving)
 * to shrink that file and reduce merge-collision surface. These functions
 * decide the effective safety level for a memory write, verify Chief-of-Staff
 * spaces against local settings (not untrusted README frontmatter), and gate
 * the secret-scanning bypass for permissive-tier writes.
 *
 * Re-exported from `memoryWriteHook.ts` so existing import paths and the
 * whole-module `vi.mock('../../safety/memoryWriteHook')` targets keep working.
 */
import type { AppSettings } from '@shared/types';
import type { SafetyLevel } from './types';

/**
 * Helper: returns true if levelA is stricter than levelB.
 * Order: cautious > balanced > permissive
 * @internal Exported for testing
 */
export function isStricter(levelA: SafetyLevel, levelB: SafetyLevel): boolean {
  const order = { permissive: 0, balanced: 1, cautious: 2 };
  return order[levelA] > order[levelB];
}

/**
 * Check if a space path is the verified Chief-of-Staff from local settings.
 *
 * SECURITY: We only trust 'chief-of-staff' type from locally-configured spaces
 * (settings.spaces), NOT from README frontmatter which could be maliciously set.
 * A malicious shared space could set `space_type: chief-of-staff` in their README
 * to bypass safety controls.
 *
 * @internal Exported for testing
 */
export function isVerifiedChiefOfStaff(
  spacePath: string | null,
  settings: AppSettings
): boolean {
  if (!spacePath) return false;

  // Find the space in local settings and verify it's configured as Chief-of-Staff
  const localSpace = settings.spaces?.find(s => s.path === spacePath);
  return localSpace?.type === 'chief-of-staff';
}

/**
 * Decide whether a permissive-tier memory write should bypass the secret gate.
 *
 * Settings-first authority (FOX-3072): trusts `isVerifiedChiefOfStaff(spacePath, settings)`
 * over scanned README frontmatter. The frontmatter `sharing` field may be missing or drifted
 * on a genuine Chief-of-Staff space; relying on it alone caused spurious secret-gate prompts
 * for Chief-of-Staff writes (FOX-3072).
 *
 * Bypasses the secret gate if EITHER:
 * 1. Space is verified Chief-of-Staff via local settings (authoritative), OR
 * 2. Frontmatter `sharing === 'private'` (user-configured, explicit).
 *
 * SECURITY INVARIANTS (unchanged from previous behaviour):
 * - Non-private, non-CoS permissive spaces STILL hit the secret gate (defense-in-depth).
 *   The safety floor in `resolveMemorySafetyLevel` caps non-private to 'balanced', so
 *   reaching 'permissive' outside CoS/private is rare; when it does happen, the gate runs.
 * - A "fake" chief-of-staff path (not in `settings.spaces` or wrong type) does NOT bypass;
 *   `isVerifiedChiefOfStaff` reads from settings, which the scanner can only populate for
 *   the real app-created Chief-of-Staff path.
 *
 * @param spacePath - Space path from `matchPathToSpace`, or null if unknown
 * @param settings - AppSettings (authoritative source for CoS verification)
 * @param sharing - Frontmatter sharing value (may be undefined for broken CoS frontmatter)
 * @returns true if the secret gate should be skipped; false if the gate should run
 *
 * @internal Exported for testing
 */
export function shouldSkipSecretGateForPermissive(
  spacePath: string | null,
  settings: AppSettings,
  sharing: 'private' | 'restricted' | 'company-wide' | 'public' | undefined
): boolean {
  // Primary authority: verified Chief-of-Staff via settings.
  // This covers the FOX-3072 case where frontmatter `sharing` is missing.
  if (isVerifiedChiefOfStaff(spacePath, settings)) return true;

  // Secondary authority: explicit private sharing via frontmatter.
  if (sharing === 'private') return true;

  return false;
}

/**
 * Simplified memory safety resolution (new architecture).
 *
 * Resolution order:
 * 1. Private Mode forces cautious
 * 2. Unknown path (not in any space) → cautious
 * 3. Chief-of-Staff is ALWAYS permissive (hardcoded, user can't change)
 *    SECURITY: Only trusts Chief-of-Staff from local settings, not README frontmatter
 * 4. Per-space setting from spaceSafetyLevels (exact path match) or default 'balanced'
 * 5. SAFETY FLOOR: Shared spaces must be at least 'balanced' (even if user sets permissive)
 *
 * @param spacePath - For per-space settings lookup and CoS verification, null = unknown
 * @param sharing - From frontmatter, used for safety floor enforcement
 * @param settings - AppSettings with spaceSafetyLevels and spaces
 * @param privateMode - Whether session is in Private Mode
 * @returns The resolved safety level and whether a space-specific setting was used
 * @internal Exported for testing
 */
export function resolveMemorySafetyLevel(
  spacePath: string | null,
  sharing: 'private' | 'restricted' | 'company-wide' | 'public' | undefined,
  settings: AppSettings,
  privateMode: boolean
): { level: SafetyLevel; hasSpaceOverride: boolean } {
  // 1. Private Mode forces cautious
  if (privateMode) {
    return { level: 'cautious', hasSpaceOverride: false };
  }

  // 2. Unknown path (not in any space) → cautious
  if (!spacePath) {
    return { level: 'cautious', hasSpaceOverride: false };
  }

  // 3. Chief-of-Staff is ALWAYS permissive (hardcoded, user can't change)
  // SECURITY: Verify against local settings, NOT frontmatter spaceType
  // A malicious space could set space_type: chief-of-staff in README to bypass safety
  if (isVerifiedChiefOfStaff(spacePath, settings)) {
    return { level: 'permissive', hasSpaceOverride: false };
  }

  // 4. Per-space setting (exact path match) or default to 'balanced'
  const rawSpaceLevel = settings.spaceSafetyLevels?.[spacePath];
  // Check if a value exists (including null, 0, empty string - all are invalid but indicate intent)
  const hasSpaceOverride = spacePath in (settings.spaceSafetyLevels ?? {});
  // Validate the level - if invalid (e.g., manual settings.json edit with null/wrong type), default to cautious
  const validLevels: SafetyLevel[] = ['permissive', 'balanced', 'cautious'];
  const isValidLevel = typeof rawSpaceLevel === 'string' && validLevels.includes(rawSpaceLevel as SafetyLevel);
  const defaultLevel: SafetyLevel = (sharing === 'private') ? 'permissive' : 'balanced';
  const spaceLevel: SafetyLevel = isValidLevel
    ? (rawSpaceLevel as SafetyLevel)
    : (hasSpaceOverride ? 'cautious' : defaultLevel);  // Invalid/corrupted override → cautious, missing → permissive (private) or balanced (other)

  // 5. SAFETY FLOOR: Honour the user's explicit per-space `permissive` choice
  // on shared spaces — the auto-approve fast path is scoped to private/CoS
  // only, so non-private permissive falls through to the LLM-eval branch
  // downstream (260525_approval_overasking_diagnostic.md). `undefined`
  // sharing means missing or corrupted frontmatter (not an explicit user
  // choice), so we still apply the balanced floor for that case.
  const undefinedSharingFloor = sharing === undefined && spaceLevel === 'permissive';
  const effectiveLevel: SafetyLevel = undefinedSharingFloor ? 'balanced' : spaceLevel;

  return { level: effectiveLevel, hasSpaceOverride };
}
