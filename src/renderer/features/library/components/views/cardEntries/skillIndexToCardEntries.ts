import type { SkillInfo, SkillsScanResult } from '../../../hooks/useSkillsIndex';
import type { SkillSourceType } from '../../SkillCard';

export type SkillCardSource = 'built-in' | 'user' | 'community';

export interface SkillCardEntry {
  id: string;
  kind: 'skill';
  name: string;
  path: string;
  relativePath: string;
  category?: string;
  source: SkillCardSource;
  skillSource: SkillSourceType;
  tags: string[];
  commandShortcut: string;
  lastUsedAt?: number;
  usageCount?: number;
  content: string;
  frontmatter?: SkillInfo['frontmatter'];
  sharing?: 'private' | 'restricted' | 'team' | 'company-wide' | 'public';
  storageProvider?: 'google_drive' | 'onedrive' | 'dropbox' | 'box' | 'icloud' | 'local' | 'other';
  examplePaths?: string[];
  qualityScore?: number;
  qualityBand?: 'seedling' | 'growing' | 'solid' | 'exemplary';
  qualityTopImprovement?: {
    dimension: string;
    suggestion: string;
  };
}

function toCardSource(
  groupType: 'platform' | 'space' | 'workspace',
): {
  source: SkillCardSource;
  skillSource: SkillSourceType;
} {
  switch (groupType) {
    case 'platform':
      return { source: 'built-in', skillSource: 'platform' };
    case 'space':
      return { source: 'user', skillSource: 'space' };
    case 'workspace':
      return { source: 'user', skillSource: 'workspace' };
    default:
      return { source: 'community', skillSource: 'workspace' };
  }
}

function buildSkillContent(skill: SkillInfo): string {
  const description = skill.frontmatter?.description?.trim();
  if (!description) {
    return `# ${skill.name}\n`;
  }
  return `# ${skill.name}\n\n${description}\n`;
}

function collectTags(skill: SkillInfo): string[] {
  const tags = new Set<string>();
  if (skill.category) {
    tags.add(skill.category);
  }
  for (const useCase of skill.frontmatter?.use_cases ?? []) {
    if (useCase.trim().length > 0) {
      tags.add(useCase.trim());
    }
  }
  return Array.from(tags);
}

export function skillIndexToCardEntries(
  skillIndex: SkillsScanResult | null | undefined,
): SkillCardEntry[] {
  if (!skillIndex?.groups || skillIndex.groups.length === 0) {
    return [];
  }

  const entries: SkillCardEntry[] = [];

  for (const group of skillIndex.groups) {
    const mappedSource = toCardSource(group.type);

    for (const skills of Object.values(group.categories)) {
      for (const skill of skills) {
        entries.push({
          id: skill.absolutePath,
          kind: 'skill',
          name: skill.name,
          path: skill.absolutePath,
          relativePath: skill.relativePath,
          category: skill.category,
          source: mappedSource.source,
          skillSource: mappedSource.skillSource,
          tags: collectTags(skill),
          commandShortcut: `@\`${skill.relativePath}\``,
          lastUsedAt: skill.lastUsedAt,
          usageCount: skill.usageCount,
          content: buildSkillContent(skill),
          frontmatter: skill.frontmatter,
          sharing: group.sharing,
          storageProvider: group.storageProvider,
          examplePaths: skill.examples,
          qualityScore: skill.qualityScore,
          qualityBand: skill.qualityBand,
          qualityTopImprovement: skill.qualityTopImprovement,
        });
      }
    }
  }

  return entries;
}
