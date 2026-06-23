import type { SurveyScaleQuestion } from '@shared/types/survey';
import styles from '../SurveyModal.module.css';

interface ScaleQuestionProps {
  question: SurveyScaleQuestion;
  value: number | null;
  comment: string;
  onChange: (value: number) => void;
  onCommentChange: (comment: string) => void;
}

export const ScaleQuestion = ({ question, value, comment, onChange, onCommentChange }: ScaleQuestionProps) => {
  const min = question.min ?? 1;
  const max = question.max ?? 5;
  const range = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  return (
    <div className={styles.scaleGroup}>
      <div className={styles.scaleButtons} role="group" aria-label="Rating scale">
        {range.map((n) => (
          <button
            key={n}
            type="button"
            className={styles.scaleButton}
            aria-pressed={value === n}
            onClick={() => onChange(n)}
          >
            {n}
          </button>
        ))}
      </div>
      {(question.minLabel || question.maxLabel) && (
        <div className={styles.scaleLabels} aria-hidden>
          <span>{question.minLabel}</span>
          <span>{question.maxLabel}</span>
        </div>
      )}
      <textarea
        className={styles.scaleComment}
        placeholder="Want to tell us more? (optional)"
        value={comment}
        onChange={(e) => onCommentChange(e.target.value)}
        rows={2}
      />
    </div>
  );
};
