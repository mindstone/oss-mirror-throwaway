import { memo, useState, useCallback } from 'react';
import { Braces, ChevronRight } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { FrontmatterFields } from '../hooks/useAnnotatedMarkdownEditor';
import styles from './FrontmatterPill.module.css';

interface FrontmatterPillProps {
  fields: FrontmatterFields;
}

const HIDDEN_KEYS = new Set([
  'rebel_annotations',
]);

function formatKey(key: string): string {
  return key.replace(/[_-]/g, ' ');
}

function renderValue(value: string | string[] | number | boolean) {
  if (typeof value === 'boolean') {
    return (
      <span className={cn(styles.boolValue, value ? styles.boolTrue : styles.boolFalse)}>
        {value ? 'Yes' : 'No'}
      </span>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className={styles.fieldValue}>—</span>;
    return (
      <span className={styles.listValue}>
        {value.map((item, i) => (
          <span key={i} className={styles.listTag}>{item}</span>
        ))}
      </span>
    );
  }

  return <span className={styles.fieldValue}>{String(value)}</span>;
}

const FrontmatterPillComponent = ({ fields }: FrontmatterPillProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const toggle = useCallback(() => setIsOpen(prev => !prev), []);

  const entries = Object.entries(fields).filter(([key]) => !HIDDEN_KEYS.has(key));
  if (entries.length === 0) return null;

  return (
    <div className={styles.wrapper}>
      <button
        type="button"
        className={cn(styles.pill, isOpen && styles.pillOpen)}
        onClick={toggle}
        aria-expanded={isOpen}
        aria-label={isOpen ? 'Hide document properties' : 'Show document properties'}
      >
        <span className={styles.pillIcon}>
          <Braces size={12} />
        </span>
        Properties
        <span className={cn(styles.chevron, isOpen && styles.chevronOpen)}>
          <ChevronRight size={11} />
        </span>
      </button>

      <div className={cn(styles.panel, isOpen && styles.panelOpen)}>
        <div className={styles.panelInner}>
          <div className={styles.fields}>
            {entries.map(([key, value]) => (
              <div key={key} className={styles.field}>
                <span className={styles.fieldKey}>{formatKey(key)}</span>
                {renderValue(value)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export const FrontmatterPill = memo(FrontmatterPillComponent);
FrontmatterPill.displayName = 'FrontmatterPill';
