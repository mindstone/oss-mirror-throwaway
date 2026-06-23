import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYSTEM_SKILL_PATHS,
  DEFAULT_SYSTEM_SKILLS_SETTINGS,
  getEffectiveSkillPath,
  type SystemSkillsSettings,
} from '../systemSkills';

describe('systemSkills', () => {
  describe('DEFAULT_SYSTEM_SKILL_PATHS', () => {
    it('contains all expected system skill keys and paths', () => {
      expect(DEFAULT_SYSTEM_SKILL_PATHS).toEqual({
        safetyGuard: 'skills/safety/safety-guard/SKILL.md',
        memoryUpdate: 'skills/memory/memory-update/SKILL.md',
        memorySensitivity: 'skills/safety/memory-sensitivity/SKILL.md',
      });
    });
  });

  describe('DEFAULT_SYSTEM_SKILLS_SETTINGS', () => {
    it('resolves all skills to their default paths', () => {
      const skillKeys = Object.keys(DEFAULT_SYSTEM_SKILL_PATHS) as Array<keyof typeof DEFAULT_SYSTEM_SKILL_PATHS>;

      for (const skillKey of skillKeys) {
        expect(getEffectiveSkillPath(skillKey, DEFAULT_SYSTEM_SKILLS_SETTINGS)).toBe(
          DEFAULT_SYSTEM_SKILL_PATHS[skillKey],
        );
      }
    });
  });

  describe('getEffectiveSkillPath', () => {
    it('uses defaults when settings are absent', () => {
      expect(getEffectiveSkillPath('safetyGuard')).toBe(DEFAULT_SYSTEM_SKILL_PATHS.safetyGuard);
      expect(getEffectiveSkillPath('memoryUpdate', null)).toBe(DEFAULT_SYSTEM_SKILL_PATHS.memoryUpdate);
      expect(getEffectiveSkillPath('memorySensitivity', undefined)).toBe(DEFAULT_SYSTEM_SKILL_PATHS.memorySensitivity);
    });

    it('falls back to defaults when custom paths are blank', () => {
      const blankSettings: SystemSkillsSettings = {
        safetyGuardPath: '   ',
        memoryUpdatePath: '',
        memorySensitivityPath: '\n\t',
      };

      expect(getEffectiveSkillPath('safetyGuard', blankSettings)).toBe(DEFAULT_SYSTEM_SKILL_PATHS.safetyGuard);
      expect(getEffectiveSkillPath('memoryUpdate', blankSettings)).toBe(DEFAULT_SYSTEM_SKILL_PATHS.memoryUpdate);
      expect(getEffectiveSkillPath('memorySensitivity', blankSettings)).toBe(
        DEFAULT_SYSTEM_SKILL_PATHS.memorySensitivity,
      );
    });

    it('returns trimmed custom paths when provided', () => {
      const customSettings: SystemSkillsSettings = {
        safetyGuardPath: ' custom/safety/SKILL.md ',
        memoryUpdatePath: '\tcustom/memory-update/SKILL.md  ',
        memorySensitivityPath: '  custom/memory-sensitivity/SKILL.md\n',
      };

      expect(getEffectiveSkillPath('safetyGuard', customSettings)).toBe('custom/safety/SKILL.md');
      expect(getEffectiveSkillPath('memoryUpdate', customSettings)).toBe('custom/memory-update/SKILL.md');
      expect(getEffectiveSkillPath('memorySensitivity', customSettings)).toBe('custom/memory-sensitivity/SKILL.md');
    });
  });
});
