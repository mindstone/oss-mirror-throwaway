/**
 * System Skills Configuration
 *
 * Defines the operating-system-level skills that are referenced by code
 * and need to be present for core functionality to work.
 *
 * These paths are configurable via AppSettings.systemSkills, allowing
 * the system to self-heal by updating paths if they change.
 */

/**
 * Default paths for system skills, relative to rebel-system root.
 * Used as fallbacks when no custom path is configured.
 */
export const DEFAULT_SYSTEM_SKILL_PATHS = {
  /** Safety guard skill for tool risk evaluation */
  safetyGuard: 'skills/safety/safety-guard/SKILL.md',
  /** Memory update skill for automatic memory maintenance */
  memoryUpdate: 'skills/memory/memory-update/SKILL.md',
  /** Memory sensitivity skill for evaluating write sensitivity in balanced mode */
  memorySensitivity: 'skills/safety/memory-sensitivity/SKILL.md',
} as const;

/**
 * Settings for system skill paths.
 * All paths are relative to rebel-system root.
 * If null/undefined, the default path is used.
 */
export interface SystemSkillsSettings {
  /** Path to safety guard skill, relative to rebel-system. Default: skills/safety/safety-guard/SKILL.md */
  safetyGuardPath?: string | null;
  /** Path to memory update skill, relative to rebel-system. Default: skills/memory/memory-update/SKILL.md */
  memoryUpdatePath?: string | null;
  /** Path to memory sensitivity skill, relative to rebel-system. Default: skills/safety/memory-sensitivity/SKILL.md */
  memorySensitivityPath?: string | null;
}

/**
 * Default system skills settings (uses default paths)
 */
export const DEFAULT_SYSTEM_SKILLS_SETTINGS: SystemSkillsSettings = {
  safetyGuardPath: null,
  memoryUpdatePath: null,
};

/**
 * Get the effective path for a system skill.
 * Returns the configured path if set, otherwise the default.
 */
export function getEffectiveSkillPath(
  skillKey: keyof typeof DEFAULT_SYSTEM_SKILL_PATHS,
  settings?: SystemSkillsSettings | null
): string {
  if (!settings) {
    return DEFAULT_SYSTEM_SKILL_PATHS[skillKey];
  }

  const settingsKeyMap: Record<keyof typeof DEFAULT_SYSTEM_SKILL_PATHS, keyof SystemSkillsSettings> = {
    safetyGuard: 'safetyGuardPath',
    memoryUpdate: 'memoryUpdatePath',
    memorySensitivity: 'memorySensitivityPath',
  };

  const settingsKey = settingsKeyMap[skillKey];
  const customPath = settings[settingsKey];

  if (customPath && customPath.trim().length > 0) {
    return customPath.trim();
  }

  return DEFAULT_SYSTEM_SKILL_PATHS[skillKey];
}
