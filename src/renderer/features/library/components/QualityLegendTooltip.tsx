import { Sprout, Leaf, TreeDeciduous, Star } from 'lucide-react';
import type { SkillQualityBand } from '../utils/skillQualityUtils';
import { QUALITY_BAND_CONFIG } from '../utils/skillQualityUtils';

export const QUALITY_BAND_ICONS: Record<SkillQualityBand, typeof Sprout> = {
  seedling: Sprout,
  growing: Leaf,
  solid: TreeDeciduous,
  exemplary: Star,
};

export const QUALITY_BAND_ORDER: SkillQualityBand[] = ['seedling', 'growing', 'solid', 'exemplary'];

export const QUALITY_BAND_RANGES: Record<SkillQualityBand, string> = {
  seedling: '0–25',
  growing: '26–50',
  solid: '51–75',
  exemplary: '76–100',
};

const formatDimensionName = (dimension: string): string =>
  dimension
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

interface QualityLegendTooltipProps {
  activeBand: SkillQualityBand;
  score: number;
  topImprovement?: { dimension: string; suggestion: string };
}

/**
 * Rich tooltip showing all quality bands with the active one highlighted,
 * plus the highest-impact improvement suggestion when available.
 * Used by SkillCard in list and card presentations.
 */
export function QualityLegendTooltip({ activeBand, score, topImprovement }: QualityLegendTooltipProps) {
  const showCta = activeBand !== 'exemplary';
  return (
    <div style={{ maxWidth: 280, lineHeight: 1.45, fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Skill quality — {score}/100</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {QUALITY_BAND_ORDER.map((band) => {
          const config = QUALITY_BAND_CONFIG[band];
          const Icon = QUALITY_BAND_ICONS[band];
          const isActive = band === activeBand;
          return (
            <div
              key={band}
              style={{
                opacity: isActive ? 1 : 0.45,
                padding: isActive ? '5px 8px' : '2px 8px',
                background: isActive ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                borderRadius: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: isActive ? 600 : 400 }}>
                <Icon size={11} style={{ flexShrink: 0 }} />
                <span>{config.label}</span>
                <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 10 }}>{QUALITY_BAND_RANGES[band]}</span>
              </div>
              {isActive && (
                <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2, paddingLeft: 17 }}>
                  {config.description}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {topImprovement && (
        <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(99, 102, 241, 0.06)', borderRadius: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 11, marginBottom: 2 }}>
            Where to focus — {formatDimensionName(topImprovement.dimension)}
          </div>
          <div style={{ fontSize: 11, opacity: 0.75 }}>
            {topImprovement.suggestion}
          </div>
        </div>
      )}
      {showCta && !topImprovement && (
        <div style={{ marginTop: 8, fontSize: 11, opacity: 0.65, fontStyle: 'italic' }}>
          Use &ldquo;Improve with Rebel&rdquo; in the skill details to level up.
        </div>
      )}
    </div>
  );
}
