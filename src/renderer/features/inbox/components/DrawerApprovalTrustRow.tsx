import { Fragment, memo, type ReactNode } from 'react';
import type { FileLocation } from '@rebel/shared';
import { FileLocationBadge } from '@renderer/components/ui';
import { SharingBadge, type SharingLevel } from '@renderer/components/approval/primitives';
import styles from './DrawerApprovalTrustRow.module.css';

export interface DrawerApprovalTrustRowProps {
  destinationLocation?: FileLocation | null;
  destinationLabel?: string | null;
  audienceSharing?: SharingLevel | null;
  audienceLabel?: string | null;
  reversibility?: string | null;
  riskCue?: string | null;
  className?: string;
}

interface TrustSegment {
  key: string;
  testId: string;
  className?: string;
  node: ReactNode;
}

function toTrimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const DrawerApprovalTrustRowComponent = ({
  destinationLocation,
  destinationLabel,
  audienceSharing,
  audienceLabel,
  reversibility,
  riskCue,
  className,
}: DrawerApprovalTrustRowProps): ReactNode => {
  const segments: TrustSegment[] = [];
  const trimmedDestinationLabel = toTrimmed(destinationLabel);
  const trimmedAudienceLabel = toTrimmed(audienceLabel);
  const trimmedReversibility = toTrimmed(reversibility);
  const trimmedRiskCue = toTrimmed(riskCue);

  if (destinationLocation) {
    segments.push({
      key: 'destination',
      testId: 'drawer-card-trust-destination',
      className: styles.destination,
      node: (
        <FileLocationBadge
          location={destinationLocation}
          compact
          className={styles.fileLocationBadge}
        />
      ),
    });
  } else if (trimmedDestinationLabel) {
    segments.push({
      key: 'destination',
      testId: 'drawer-card-trust-destination',
      className: styles.destinationText,
      node: trimmedDestinationLabel,
    });
  }

  if (audienceSharing) {
    segments.push({
      key: 'audience',
      testId: 'drawer-card-trust-audience',
      className: styles.audience,
      node: <SharingBadge sharing={audienceSharing} className={styles.sharingBadge} />,
    });
  } else if (trimmedAudienceLabel) {
    segments.push({
      key: 'audience',
      testId: 'drawer-card-trust-audience',
      className: styles.audienceText,
      node: trimmedAudienceLabel,
    });
  }

  if (trimmedReversibility) {
    segments.push({
      key: 'reversibility',
      testId: 'drawer-card-trust-reversibility',
      className: styles.reversibility,
      node: trimmedReversibility,
    });
  }

  if (trimmedRiskCue) {
    segments.push({
      key: 'risk-cue',
      testId: 'drawer-card-trust-risk-cue',
      className: styles.riskCue,
      node: trimmedRiskCue,
    });
  }

  if (segments.length === 0) {
    return null;
  }

  return (
    <div
      className={[styles.row, className].filter(Boolean).join(' ')}
      data-testid="drawer-card-trust-row"
    >
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 && (
            <span className={styles.separator} aria-hidden="true">
              ·
            </span>
          )}
          <span
            className={[styles.segment, segment.className].filter(Boolean).join(' ')}
            data-testid={segment.testId}
          >
            {segment.node}
          </span>
        </Fragment>
      ))}
    </div>
  );
};

export const DrawerApprovalTrustRow = memo(DrawerApprovalTrustRowComponent);
DrawerApprovalTrustRow.displayName = 'DrawerApprovalTrustRow';
