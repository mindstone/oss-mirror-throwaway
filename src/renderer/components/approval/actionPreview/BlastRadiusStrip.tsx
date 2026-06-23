import type { BlastRadius, RiskReason } from '@rebel/shared';
import type { SharingLevel } from '@renderer/components/approval/primitives/SharingBadge';
import { SharingBadge } from '@renderer/components/approval/primitives/SharingBadge';
import { BlastRadiusChip } from './BlastRadiusChip';
import styles from './ActionPreview.module.css';

interface ChipGroupProps {
  label: string;
  group: 'where' | 'audience' | 'afterwards';
  values: BlastRadius['where'];
  testId: string;
}

function toSharingLevel(label: string): SharingLevel | null {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'private' || normalized === 'private to you') return 'private';
  if (normalized === 'restricted' || normalized === 'shared workspace') return 'restricted';
  if (normalized === 'company-wide' || normalized === 'company wide') return 'company-wide';
  if (normalized === 'public' || normalized === 'public channel') return 'public';
  if (normalized === 'unclear' || normalized === 'unclear audience') return 'unclear';
  return null;
}

const AUDIENCE_LABEL_OVERRIDES: Record<Exclude<SharingLevel, 'unclear'>, string> = {
  private: 'Private to you',
  restricted: 'Shared workspace',
  'company-wide': 'Company-wide',
  public: 'Public',
};

const ChipGroup = ({ label, group, values, testId }: ChipGroupProps) => {
  if (values.length === 0) {
    return null;
  }

  return (
    <div className={styles.stripGroup} data-testid={testId}>
      <p className={styles.stripLabel}>{label}</p>
      <div className={styles.chipRow}>
        {values.map((chip) => {
          const sharingLevel = group === 'audience' ? toSharingLevel(chip.label) : null;

          if (sharingLevel) {
            return (
              <SharingBadge
                key={`${group}-${chip.label}`}
                sharing={sharingLevel}
                className={styles.audienceSharingBadge}
                labelOverride={
                  sharingLevel === 'unclear'
                    ? undefined
                    : AUDIENCE_LABEL_OVERRIDES[sharingLevel]
                }
              />
            );
          }

          return (
            <BlastRadiusChip
              key={`${group}-${chip.label}`}
              group={group}
              label={chip.label}
              testId={`blast-radius-chip-${group}-${chip.label.toLowerCase().replace(/\s+/g, '-')}`}
            />
          );
        })}
      </div>
    </div>
  );
};

export interface BlastRadiusStripProps {
  blastRadius: BlastRadius;
  riskReasons?: RiskReason[];
  className?: string;
}

export const BlastRadiusStrip = ({ blastRadius, riskReasons = [], className }: BlastRadiusStripProps) => {
  const hasAnyChip = blastRadius.where.length > 0
    || blastRadius.whoCanSeeIt.length > 0
    || blastRadius.afterwards.length > 0
    || riskReasons.length > 0;

  if (!hasAnyChip) {
    return null;
  }

  return (
    <section
      className={`${styles.blastRadiusStrip}${className ? ` ${className}` : ''}`}
      aria-label="Blast radius summary"
      data-testid="blast-radius-strip"
    >
      <ChipGroup
        label="Where"
        group="where"
        values={blastRadius.where}
        testId="blast-radius-group-where"
      />
      <ChipGroup
        label="Who can see it"
        group="audience"
        values={blastRadius.whoCanSeeIt}
        testId="blast-radius-group-who-can-see-it"
      />
      <ChipGroup
        label="Afterwards"
        group="afterwards"
        values={blastRadius.afterwards}
        testId="blast-radius-group-afterwards"
      />
      {riskReasons.length > 0 && (
        <div className={styles.stripGroup} data-testid="blast-radius-group-risk">
          <p className={styles.stripLabel}>Why this matters</p>
          <div className={styles.chipRow}>
            {riskReasons.map((riskReason) => (
              <BlastRadiusChip
                key={`risk-${riskReason}`}
                group="risk"
                label={riskReason}
                testId={`blast-radius-chip-risk-${riskReason.toLowerCase().replace(/\s+/g, '-')}`}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
};
