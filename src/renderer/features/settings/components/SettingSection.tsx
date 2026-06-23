import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import styles from './SettingSection.module.css';

export type SettingSectionProps = {
  /** Section heading */
  title: string;
  /** Optional description below the heading */
  description?: string;
  /** Optional icon rendered before the title */
  icon?: LucideIcon;
  /** Optional badge rendered after the title (e.g., MaturityBadge) */
  badge?: ReactNode;
  /** Section ID for deep-link scrolling via useScrollToSection */
  'data-section'?: string;
  /** Test ID for E2E tests */
  'data-testid'?: string;
  /** If true, renders as collapsible (collapsed by default) */
  advanced?: boolean;
  /** If true, hides the chevron icon in the advanced toggle */
  hideAdvancedChevron?: boolean;
  /** Initial expanded state for advanced sections */
  defaultExpanded?: boolean;
  /** Controlled expanded state for advanced sections. */
  open?: boolean;
  /** Controlled expanded-state change handler for advanced sections. */
  onOpenChange?: (open: boolean) => void;
  /** Section content (SettingRow components, custom layouts, etc.) */
  children: ReactNode;
};

export const SettingSection = ({
  title,
  description,
  icon: Icon,
  badge,
  'data-section': dataSection,
  'data-testid': dataTestId,
  advanced = false,
  hideAdvancedChevron = false,
  defaultExpanded = false,
  open,
  onOpenChange,
  children,
}: SettingSectionProps) => {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const expanded = open ?? internalExpanded;
  const setExpanded = (nextExpanded: boolean) => {
    if (open === undefined) {
      setInternalExpanded(nextExpanded);
    }
    onOpenChange?.(nextExpanded);
  };

  if (advanced) {
    return (
      <section
        className={styles.section}
        data-section={dataSection}
        data-testid={dataTestId}
        data-advanced-section
      >
        <button
          type="button"
          className={styles.advancedToggle}
          data-advanced-toggle
          data-section-focus-target
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {!hideAdvancedChevron && (
            <span
              className={[
                styles.advancedChevron,
                expanded ? styles.advancedChevronExpanded : '',
              ].filter(Boolean).join(' ')}
            >
              <ChevronRight size={16} />
            </span>
          )}
          {Icon && <Icon size={18} className={styles.icon} />}
          <span className={styles.advancedTitle}>{title}</span>
          {badge}
        </button>
        {description && (
          <p className={`${styles.advancedDescription} ${hideAdvancedChevron ? styles.advancedDescriptionNoChevron : ''}`}>
            {description}
          </p>
        )}
        {/*
          Always render content in DOM (hidden when collapsed) so
          useScrollToSection can find data-section elements inside
          and auto-expand via data-advanced-toggle.
        */}
        <div
          data-advanced-content
          data-expanded={expanded || undefined}
          style={{ display: expanded ? undefined : 'none' }}
        >
          <div className={styles.advancedContent}>
            {children}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={styles.section}
      data-section={dataSection}
      data-testid={dataTestId}
    >
      {(title || description) && (
        <div className={styles.header}>
          <div className={styles.titleRow}>
            {Icon && <Icon size={18} className={styles.icon} />}
            <h2 className={styles.title} data-section-focus-target>
              {title}
            </h2>
            {badge}
          </div>
          {description && (
            <p className={styles.description}>{description}</p>
          )}
        </div>
      )}
      <div className={styles.content}>
        {children}
      </div>
    </section>
  );
};
