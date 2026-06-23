export type SkillQualityBand = 'seedling' | 'growing' | 'solid' | 'exemplary';

export type SkillImproveQualityContext = {
  score: number;
  band: SkillQualityBand;
  topImprovement: {
    dimension: string;
    suggestion: string;
  };
};

export interface SkillQualityBadgeData {
  score: number;
  emoji: string;
  label: string;
  description: string;
  badgeClassName: string;
}

export const QUALITY_BAND_CONFIG: Record<SkillQualityBand, Omit<SkillQualityBadgeData, 'score'>> = {
  seedling: {
    emoji: '\u{1F331}',
    label: 'Just started',
    description: 'The bones are here. A description and an example would transform this.',
    badgeClassName: 'qualityBadgeSeedling',
  },
  growing: {
    emoji: '\u{1F33F}',
    label: 'Taking shape',
    description: 'Getting somewhere. A bit more detail and Rebel can really run with this.',
    badgeClassName: 'qualityBadgeGrowing',
  },
  solid: {
    emoji: '\u{1F333}',
    label: 'Strong',
    description: 'Well-built, well-used. A counter-example away from exceptional.',
    badgeClassName: 'qualityBadgeSolid',
  },
  exemplary: {
    emoji: '\u{2728}',
    label: 'Exceptional',
    description: 'Battle-tested and thoroughly documented. This is what peak looks like.',
    badgeClassName: 'qualityBadgeExemplary',
  },
};

export function getQualityBandFromScore(score: number): SkillQualityBand {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  if (clamped <= 22) return 'seedling';
  if (clamped <= 45) return 'growing';
  if (clamped <= 68) return 'solid';
  return 'exemplary';
}

export function getSkillQualityBadgeData(
  qualityScore: number | undefined,
  qualityBand?: SkillQualityBand
): SkillQualityBadgeData | null {
  if (qualityScore === undefined) return null;

  const score = Math.max(0, Math.min(100, Math.round(qualityScore)));
  const band = qualityBand ?? getQualityBandFromScore(score);
  const config = QUALITY_BAND_CONFIG[band];

  return { ...config, score };
}

export function buildImproveQualityContext(
  qualityScore: number | undefined,
  qualityBand: SkillQualityBand | undefined,
  qualityTopImprovement: { dimension: string; suggestion: string } | undefined
): SkillImproveQualityContext | undefined {
  if (qualityScore === undefined || !qualityBand || !qualityTopImprovement) {
    return undefined;
  }

  return {
    score: qualityScore,
    band: qualityBand,
    topImprovement: qualityTopImprovement,
  };
}
