/**
 * DetailsAccordion — Shared expandable technical details primitive.
 *
 * Renders a "Show details" / "Hide details" toggle that reveals
 * tool name and JSON parameters. Extracted from UnifiedApprovalCard.
 */

import { memo, useState, useCallback, type FC } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { getFriendlyToolName } from '@rebel/shared';
import styles from './DetailsAccordion.module.css';

function formatToolInput(input: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(input, null, 2);
    return str.length > 800 ? str.slice(0, 800) + '\n...' : str;
  } catch {
    return String(input);
  }
}

export interface DetailsAccordionProps {
  toolName?: string;
  params?: Record<string, unknown>;
  defaultExpanded?: boolean;
  className?: string;
  toggleTestId?: string;
}

const DetailsAccordionComponent: FC<DetailsAccordionProps> = ({
  toolName,
  params,
  defaultExpanded = false,
  className,
  toggleTestId,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasParams = params && Object.keys(params).length > 0;

  const toggleExpanded = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(prev => !prev);
  }, []);

  // Don't render if there's nothing to show
  if (!toolName && !hasParams) {
    return null;
  }

  return (
    <div className={className}>
      <button
        type="button"
        className={styles.toggle}
        onClick={toggleExpanded}
        aria-expanded={expanded}
        data-testid={toggleTestId}
      >
        <ChevronRight
          size={10}
          className={cn(styles.chevron, expanded && styles.chevronOpen)}
        />
        {expanded ? 'Hide details' : 'Show details'}
      </button>

      {expanded && (
        <div className={styles.details}>
          {toolName && (
            <div className={styles.row}>
              <span className={styles.label}>Tool</span>
              <code className={styles.code}>
                {getFriendlyToolName(toolName) || toolName}
              </code>
            </div>
          )}
          {hasParams && (
            <div className={styles.row}>
              <span className={styles.label}>Parameters</span>
              <pre className={styles.pre}>{formatToolInput(params)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const DetailsAccordion = memo(DetailsAccordionComponent);
DetailsAccordion.displayName = 'DetailsAccordion';
