import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import styles from './ConversationPane.module.css';

export interface MessageWorkDisclosureProps {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  forceOpenWhenActiveOrFailed?: boolean;
  ariaLabel?: string;
  children: ReactNode;
}

export function MessageWorkDisclosure({
  label,
  count,
  defaultOpen = false,
  forceOpenWhenActiveOrFailed = false,
  ariaLabel,
  children,
}: MessageWorkDisclosureProps) {
  const controlledRegionId = useId();
  const [isOpen, setIsOpen] = useState(defaultOpen || forceOpenWhenActiveOrFailed);

  useEffect(() => {
    if (forceOpenWhenActiveOrFailed) {
      setIsOpen(true);
    }
  }, [forceOpenWhenActiveOrFailed]);

  return (
    <section
      className={styles.messageWorkDisclosure}
      data-testid="message-work-disclosure"
    >
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={styles.messageWorkDisclosureToggle}
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-controls={controlledRegionId}
        aria-label={ariaLabel}
      >
        <ChevronDown
          size={14}
          className={cn(styles.messageWorkDisclosureChevron, isOpen && styles.messageWorkDisclosureChevronOpen)}
          aria-hidden
        />
        <span className={styles.messageWorkDisclosureLabel}>{label}</span>
        {typeof count === 'number' ? (
          <span className={styles.messageWorkDisclosureCount} aria-label={`${count} item${count === 1 ? '' : 's'}`}>
            {count}
          </span>
        ) : null}
      </Button>
      <div
        id={controlledRegionId}
        className={styles.messageWorkDisclosureBody}
        hidden={!isOpen}
      >
        {children}
      </div>
    </section>
  );
}
