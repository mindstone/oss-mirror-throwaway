import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { IconTile, type IconTileTone } from './IconTile';
import styles from './DecisionCardGroup.module.css';

export interface DecisionCardOption<TValue extends string = string> {
  id: TValue;
  icon: LucideIcon;
  title: React.ReactNode;
  description: React.ReactNode;
  badge?: React.ReactNode;
  selectedContent?: React.ReactNode;
  footer?: React.ReactNode;
  iconTone?: IconTileTone;
}

export interface DecisionCardGroupProps<TValue extends string = string> {
  'aria-label': string;
  options: DecisionCardOption<TValue>[];
  value: TValue;
  onValueChange: (value: TValue) => void;
  className?: string;
  selectedLabel?: React.ReactNode;
}

const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [data-decision-card-interactive]';

export function DecisionCardGroup<TValue extends string>({
  'aria-label': ariaLabel,
  options,
  value,
  onValueChange,
  className,
  selectedLabel = 'Selected',
}: DecisionCardGroupProps<TValue>) {
  const optionRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const activeIndex = Math.max(0, options.findIndex((option) => option.id === value));

  const selectAndFocusOption = (optionId: TValue) => {
    onValueChange(optionId);
    optionRefs.current[optionId]?.focus();
  };

  const handleCardClick = (event: React.MouseEvent<HTMLDivElement>, optionId: TValue) => {
    const target = event.target;
    if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;
    onValueChange(optionId);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, optionId: TValue) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onValueChange(optionId);
      return;
    }

    const currentIndex = options.findIndex((option) => option.id === optionId);
    if (currentIndex < 0) return;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      const nextOption = options[(currentIndex + 1) % options.length];
      selectAndFocusOption(nextOption.id);
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      const previousOption = options[(currentIndex - 1 + options.length) % options.length];
      selectAndFocusOption(previousOption.id);
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      selectAndFocusOption(options[0].id);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      selectAndFocusOption(options[options.length - 1].id);
    }
  };

  return (
    <div className={cn(styles.group, className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.id === value;

        return (
          <div
            key={option.id}
            className={cn(styles.card, selected && styles.selected)}
            onClick={(event) => handleCardClick(event, option.id)}
          >
            <div
              ref={(element) => {
                optionRefs.current[option.id] = element;
              }}
              role="radio"
              aria-checked={selected}
              tabIndex={options[activeIndex]?.id === option.id ? 0 : -1}
              className={styles.choice}
              onKeyDown={(event) => handleKeyDown(event, option.id)}
            >
              <div className={styles.header}>
                <IconTile icon={option.icon} tone={selected ? option.iconTone ?? 'default' : 'neutral'} size="sm" />
                <h4 className={styles.title}>{option.title}</h4>
                {option.badge && <span className={styles.badge}>{option.badge}</span>}
              </div>
              <div className={styles.description}>{option.description}</div>
            </div>
            {selected && option.selectedContent && (
              <div className={styles.selectedContent}>
                {option.selectedContent}
              </div>
            )}
            <div className={styles.footer}>
              <div className={styles.footerMeta}>{option.footer}</div>
              {selected && <div className={styles.selectedLabel}>{selectedLabel}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
