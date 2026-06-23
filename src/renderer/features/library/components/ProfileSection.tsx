import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, FileText, type LucideIcon } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import styles from './ProfileSection.module.css';

type ProfileSectionProps = {
  heading: string;
  subtitle?: string;
  prompt: string;
  placeholder?: string;
  value: string;
  icon?: LucideIcon;
  isFilled?: boolean;
  onChange: (value: string) => void;
  onInterview?: () => void;
  isExpanded: boolean;
  onToggle: () => void;
};

export function ProfileSection({
  heading,
  subtitle,
  prompt,
  placeholder,
  value,
  icon: Icon,
  isFilled,
  onChange,
  onInterview,
  isExpanded,
  onToggle,
}: ProfileSectionProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(value);
  const isDirty = draft !== value;
  const isActionClickRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (isExpanded) requestAnimationFrame(resizeTextarea);
  }, [isExpanded, resizeTextarea]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      const el = e.target;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    },
    [],
  );

  const handleSave = useCallback(() => {
    isActionClickRef.current = true;
    onChange(draft);
    requestAnimationFrame(() => { isActionClickRef.current = false; });
  }, [onChange, draft]);

  const handleCancel = useCallback(() => {
    isActionClickRef.current = true;
    setDraft(value);
    requestAnimationFrame(() => { isActionClickRef.current = false; });
  }, [value]);

  const handleBlur = useCallback(() => {
    if (isActionClickRef.current) return;
    if (draft !== value) onChange(draft);
  }, [draft, value, onChange]);

  const SectionIcon = Icon ?? FileText;

  const previewLine = (() => {
    if (!value) return '';
    const lines = value.split('\n');
    const firstMeaningful = lines.find((l) => {
      const trimmed = l.trim();
      if (!trimmed) return false;
      if (/^```/.test(trimmed)) return false;
      if (/^\w+:/.test(trimmed) && !trimmed.includes(' ')) return false;
      if (/^[A-Z_]+:/.test(trimmed)) return false;
      return true;
    });
    return firstMeaningful?.trim().replace(/^[-*•]\s*/, '').slice(0, 120) ?? '';
  })();

  return (
    <div className={cn(styles.card, isExpanded && styles.cardExpanded, isFilled && styles.cardFilled)}>
      <button
        type="button"
        className={styles.header}
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        {isFilled ? (
          <span className={styles.filledBadge}>
            <Check size={10} strokeWidth={3} />
          </span>
        ) : (
          <SectionIcon size={15} className={styles.sectionIcon} aria-hidden />
        )}
        <span className={styles.heading}>{heading}</span>
        {!isExpanded && (() => {
          if (previewLine) {
            return <span className={styles.preview}>{previewLine}</span>;
          }
          if (!isFilled && subtitle) {
            return <span className={styles.previewSubtitle}>{subtitle}</span>;
          }
          if (isFilled) {
            return <span className={styles.preview}>{prompt}</span>;
          }
          return <span className={styles.previewEmpty}>{prompt}</span>;
        })()}
        <ChevronDown
          size={16}
          className={cn(styles.chevron, isExpanded && styles.chevronExpanded)}
        />
      </button>

      {isExpanded && (
        <div className={styles.body}>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          {prompt && <p className={styles.prompt}>{prompt}</p>}
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={draft}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder={placeholder}
            rows={3}
          />
          {isDirty && (
            <div className={styles.actions}>
              <Button size="sm" onMouseDown={() => { isActionClickRef.current = true; }} onClick={handleSave}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onMouseDown={() => { isActionClickRef.current = true; }} onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          )}
          {!isFilled && !isDirty && onInterview && (
            <p className={styles.interviewHint}>
              Not sure what to write?{' '}
              <button type="button" className={styles.interviewLink} onClick={onInterview}>
                Let Rebel interview you
              </button>{' '}
              and it will fill this in for you.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
