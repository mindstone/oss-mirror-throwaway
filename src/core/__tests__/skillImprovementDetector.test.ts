import { describe, it, expect } from 'vitest';
import { detectDoctorSession, isDoctorSkill } from '@core/skillImprovementDetector';

describe('detectDoctorSession', () => {
  it('returns false when no doctor skill is used', () => {
    const result = detectDoctorSession(['meeting-prep', 'research-brief']);
    expect(result.isDoctorSession).toBe(false);
    expect(result.doctorSkill).toBeUndefined();
    expect(result.targetSkills).toEqual([]);
  });

  it('detects improve-skill as a doctor session', () => {
    const result = detectDoctorSession(['improve-skill', 'meeting-prep']);
    expect(result.isDoctorSession).toBe(true);
    expect(result.doctorSkill).toBe('improve-skill');
    expect(result.targetSkills).toEqual(['meeting-prep']);
  });

  it('detects customise-and-extend-skill as a doctor session', () => {
    const result = detectDoctorSession(['customise-and-extend-skill', 'email-draft']);
    expect(result.isDoctorSession).toBe(true);
    expect(result.doctorSkill).toBe('customise-and-extend-skill');
    expect(result.targetSkills).toEqual(['email-draft']);
  });

  it('detects skill-repair as a doctor session', () => {
    const result = detectDoctorSession(['skill-repair', 'research-brief']);
    expect(result.isDoctorSession).toBe(true);
    expect(result.doctorSkill).toBe('skill-repair');
    expect(result.targetSkills).toEqual(['research-brief']);
  });

  it('returns empty targetSkills when only a doctor skill is used', () => {
    const result = detectDoctorSession(['improve-skill']);
    expect(result.isDoctorSession).toBe(true);
    expect(result.doctorSkill).toBe('improve-skill');
    expect(result.targetSkills).toEqual([]);
  });

  it('extracts multiple target skills excluding doctor skills', () => {
    const result = detectDoctorSession([
      'improve-skill',
      'meeting-prep',
      'research-brief',
      'skill-repair',
    ]);
    expect(result.isDoctorSession).toBe(true);
    expect(result.targetSkills).toEqual(['meeting-prep', 'research-brief']);
  });

  it('handles empty skillsUsed', () => {
    const result = detectDoctorSession([]);
    expect(result.isDoctorSession).toBe(false);
    expect(result.targetSkills).toEqual([]);
  });
});

describe('isDoctorSkill', () => {
  it('returns true for all doctor skills', () => {
    expect(isDoctorSkill('improve-skill')).toBe(true);
    expect(isDoctorSkill('customise-and-extend-skill')).toBe(true);
    expect(isDoctorSkill('skill-repair')).toBe(true);
  });

  it('returns false for non-doctor skills', () => {
    expect(isDoctorSkill('meeting-prep')).toBe(false);
    expect(isDoctorSkill('research-brief')).toBe(false);
    expect(isDoctorSkill('')).toBe(false);
  });
});
