import { Badge } from '@renderer/components/ui';
import type { ThinkingEffort } from '@shared/types';
import { thinkingLabel } from './profileHelpers';

export interface ThinkingLevelPillProps {
  /** Effort value. When missing, shows "No reasoning". */
  effort?: ThinkingEffort;
  /** Optional className hook so parents can toggle icon-only at narrow widths. */
  className?: string;
}

/**
 * Read-only presentational pill that summarises a profile's thinking effort.
 *
 * Used in Stage 2 inside the compact profile table. `ThinkingLevelSegmentedControl`
 * is a separate interactive control — this component is intentionally static.
 */
export const ThinkingLevelPill = ({ effort, className }: ThinkingLevelPillProps) => {
  if (!effort) {
    return (
      <Badge variant="muted" size="sm" className={className}>
        No reasoning
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" size="sm" className={className}>
      {thinkingLabel(effort)}
    </Badge>
  );
};
