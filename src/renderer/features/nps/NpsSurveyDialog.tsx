import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@renderer/components/ui';
import styles from './NpsSurveyDialog.module.css';

type NpsSurveyDialogProps = {
  isOpen: boolean;
  onDismiss: () => void;
  onSubmit: (score: number, feedback: string) => Promise<void>;
};

const SCORES = Array.from({ length: 11 }, (_v, i) => i); // 0..10

export const NpsSurveyDialog = ({ isOpen, onDismiss, onSubmit }: NpsSurveyDialogProps) => {
  const titleId = useId();
  const descId = useId();
  const [score, setScore] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onDismiss]);

  useEffect(() => {
    if (!isOpen) {
      setScore(null);
      setFeedback('');
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const canSubmit = useMemo(() => typeof score === 'number' && !isSubmitting, [score, isSubmitting]);

  const handleSubmitClick = useCallback(async () => {
    if (score === null || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(score, feedback);
    } finally {
      setIsSubmitting(false);
    }
  }, [score, feedback, isSubmitting, onSubmit]);

  if (!isOpen) return null;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal
      aria-labelledby={titleId}
      aria-describedby={descId}
      onClick={onDismiss}
    >
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div className={styles.icon} aria-hidden>
            ⭐
          </div>
          <div className={styles.heading}>
            <span className={styles.overline}>Quick feedback</span>
            <h2 id={titleId} className={styles.title}>
              How likely are you to recommend Mindstone Rebel to a friend?
            </h2>
          </div>
        </header>
        <div className={styles.body} id={descId}>
          <p className={styles.question}>0 = Not at all likely, 10 = Extremely likely</p>
          <div className={styles.scale} role="group" aria-label="NPS score">
            {SCORES.map((s) => {
              const pressed = score === s;
              return (
                <button
                  key={s}
                  type="button"
                  className={styles.scoreButton}
                  aria-pressed={pressed}
                  onClick={() => setScore(s)}
                >
                  {s}
                </button>
              );
            })}
          </div>
          <div className={styles.labels} aria-hidden>
            <span>Not likely</span>
            <span>Extremely likely</span>
          </div>
          <textarea
            className={styles.textarea}
            placeholder="What’s the main reason for your score? (optional)"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
        </div>
        <footer className={styles.actions}>
          <Button variant="ghost" className={styles.dimButton} onClick={onDismiss} disabled={isSubmitting}>
            Not now
          </Button>
          <Button onClick={handleSubmitClick} disabled={!canSubmit}>
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </Button>
        </footer>
      </div>
    </div>
  );
};

NpsSurveyDialog.displayName = 'NpsSurveyDialog';


