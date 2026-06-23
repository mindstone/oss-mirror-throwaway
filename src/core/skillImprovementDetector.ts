const DOCTOR_SKILL_NAMES = new Set([
  'improve-skill',
  'customise-and-extend-skill',
  'skill-repair',
]);

export interface DoctorSessionDetection {
  isDoctorSession: boolean;
  doctorSkill?: string;
  targetSkills: string[];
}

/**
 * Detect whether a session used a skill doctor and extract the target skills.
 * Doctor skills are system skills that modify other skills.
 * Target skills are all non-doctor skills in the session's skillsUsed list.
 */
export function detectDoctorSession(skillsUsed: string[]): DoctorSessionDetection {
  let doctorSkill: string | undefined;

  for (const skill of skillsUsed) {
    if (DOCTOR_SKILL_NAMES.has(skill)) {
      doctorSkill = skill;
      break;
    }
  }

  if (!doctorSkill) {
    return { isDoctorSession: false, targetSkills: [] };
  }

  const targetSkills = skillsUsed.filter(s => !DOCTOR_SKILL_NAMES.has(s));

  return {
    isDoctorSession: true,
    doctorSkill,
    targetSkills,
  };
}

/**
 * Check if a skill name refers to a doctor skill.
 */
export function isDoctorSkill(skillName: string): boolean {
  return DOCTOR_SKILL_NAMES.has(skillName);
}
