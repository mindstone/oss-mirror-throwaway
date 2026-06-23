import type { SurveyOpenEndedQuestion } from '@shared/types/survey';
import styles from '../SurveyModal.module.css';

interface OpenEndedQuestionProps {
  question: SurveyOpenEndedQuestion;
  value: string;
  onChange: (value: string) => void;
}

export const OpenEndedQuestion = ({ question, value, onChange }: OpenEndedQuestionProps) => {
  return (
    <textarea
      className={styles.textarea}
      placeholder={question.placeholder ?? 'Type your answer…'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={4}
    />
  );
};
