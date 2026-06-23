import { useEffect, type ReactElement } from 'react';
import { AlertTriangle } from 'lucide-react';
import { createLogger } from '@rebel/cloud-client';
import { describeFileLocation, type FileLocation } from '@rebel/shared';
import { cn } from '../../lib/utils';
import { Tooltip } from './Tooltip';
import styles from './FileLocationBadge.module.css';

const warnedLegacyKeys = new Set<string>();
const log = createLogger('FileLocationBadge');

/**
 * Renders a path-like label with middle-ellipsis behavior: the filename tail
 * always stays visible, while the prefix (space + nested directories) gets
 * end-truncated with ellipsis when the container overflows. Implemented as
 * a flexbox pair — the prefix has `min-width: 0; overflow: hidden;
 * text-overflow: ellipsis` and the suffix uses `flex-shrink: 0` to stay pinned.
 */
function renderMiddleEllipsisLabel(fullLabel: string, fileName: string): ReactElement {
  // Find the filename at the end of the label; split deterministically so we
  // never truncate in the middle of a character. If the filename isn't
  // present (e.g. "Unknown file" on legacy), fall back to plain end-ellipsis.
  const suffixIndex = fullLabel.lastIndexOf(fileName);
  if (suffixIndex < 0 || suffixIndex === 0) {
    return (
      <span className={styles.label} data-testid="file-location-badge-label">
        {fullLabel}
      </span>
    );
  }
  const prefix = fullLabel.slice(0, suffixIndex);
  const suffix = fullLabel.slice(suffixIndex);
  return (
    <span className={styles.labelSplit} data-testid="file-location-badge-label">
      <span className={styles.labelPrefix}>{prefix}</span>
      <span className={styles.labelSuffix}>{suffix}</span>
    </span>
  );
}

export interface FileLocationBadgeProps {
  location: FileLocation;
  compact?: boolean;
  className?: string;
}

export function FileLocationBadge({
  location,
  compact = false,
  className,
}: FileLocationBadgeProps): ReactElement {
  const description = describeFileLocation(location);
  const warnKey = `${description.fileName}|${description.label}`;

  useEffect(() => {
    if (location.kind !== 'legacy-missing-location' || warnedLegacyKeys.has(warnKey)) {
      return;
    }
    warnedLegacyKeys.add(warnKey);
    // cloud-client createLogger uses message-first signature (msg, data?) —
    // NOT Pino. Eslint's Pino arg-order rule doesn't differentiate, so we
    // suppress it here. Swapping would runtime-break the logger.
    // eslint-disable-next-line no-restricted-syntax -- cloud-client logger is (msg, data) not (data, msg); flipping order would break it at runtime
    log.warn('Rendering degraded FileLocationBadge', {
      fileName: description.fileName,
      label: description.label,
      kind: location.kind,
    });
  }, [description.fileName, description.label, location.kind, warnKey]);

  return (
    <Tooltip content={description.tooltip} placement="bottom" delayShow={300} maxWidth="none">
      <span
        className={cn(
          styles.badge,
          compact && styles.compact,
          description.degraded && styles.degraded,
          className,
        )}
        data-testid="file-location-badge"
        data-tooltip-content={description.tooltip}
        aria-label={description.tooltip}
        tabIndex={0}
      >
        {description.degraded && (
          <AlertTriangle
            className={styles.icon}
            size={compact ? 12 : 14}
            aria-hidden="true"
            data-testid="file-location-badge-warning-icon"
          />
        )}
        {/* Middle-ellipsis via two-span split: the prefix (everything before
            the filename) end-truncates; the filename tail always stays
            visible. Plan § UI Brief requires the filename to remain legible
            for deeply-nested paths (e.g. `General / skills/.../SKILL.md`). */}
        {renderMiddleEllipsisLabel(compact ? description.shortLabel : description.label, description.fileName)}
      </span>
    </Tooltip>
  );
}
