import { memo } from 'react';
import { FileText } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import styles from './ContextChip.module.css';

export interface OfficeContextChipProps {
  host?: string;
  title?: string;
}

function formatOfficeHost(host: string | undefined): string {
  switch (host) {
    case 'word':
      return 'Word';
    case 'excel':
      return 'Excel';
    case 'powerpoint':
      return 'PowerPoint';
    default:
      return 'Office';
  }
}

const OfficeContextChipComponent = ({
  host,
  title,
}: OfficeContextChipProps) => {
  const source = formatOfficeHost(host);
  if (!host && !title) return null;

  const tooltipText = title ? `${source}\n${title}` : source;

  return (
    <Tooltip content={tooltipText} placement="top">
      <div
        className={styles.chip}
        data-testid="office-context-chip"
        role="status"
        aria-label={`Office context: ${title ? `${source}, ${title}` : source}`}
      >
        <FileText size={12} className={styles.icon} aria-hidden="true" />
        <span className={styles.label}>From {source}</span>
        {title && (
          <>
            <span className={styles.separator} aria-hidden="true">·</span>
            <span className={styles.host}>{title}</span>
          </>
        )}
      </div>
    </Tooltip>
  );
};

export const OfficeContextChip = memo(OfficeContextChipComponent);
OfficeContextChip.displayName = 'OfficeContextChip';
