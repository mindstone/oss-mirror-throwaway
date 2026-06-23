import { useCallback, useId, useState } from 'react';
import { Dialog, DialogContent, Button } from '@renderer/components/ui';
import type { SurveyConfig, SurveyQuestion } from '@shared/types/survey';
import { ScaleQuestion } from './components/ScaleQuestion';
import { OpenEndedQuestion } from './components/OpenEndedQuestion';
import styles from './SurveyModal.module.css';

const REBEL_MASCOT_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/rebel6.svg';

type SurveyAnswer = string | number | null;

interface SurveyModalProps {
  isOpen: boolean;
  config: SurveyConfig;
  onDismiss: (questionReached: number) => Promise<void>;
  onComplete: (answers: Array<{ questionIndex: number; questionType: string; answer: SurveyAnswer; comment?: string }>) => Promise<void>;
}

export const SurveyModal = ({ isOpen, config, onDismiss, onComplete }: SurveyModalProps) => {
  const titleId = useId();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<SurveyAnswer[]>(() =>
    config.questions.map(() => null)
  );
  const [scaleComments, setScaleComments] = useState<Record<number, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const totalQuestions = config.questions.length;
  const currentQuestion = config.questions[currentIndex];
  const isLastQuestion = currentIndex === totalQuestions - 1;
  const currentAnswer = answers[currentIndex];
  const hasAnswer = currentAnswer !== null && currentAnswer !== '';

  const resetState = useCallback(() => {
    setCurrentIndex(0);
    setAnswers(config.questions.map(() => null));
    setScaleComments({});
    setIsSubmitting(false);
  }, [config.questions]);

  const handleOpenChange = useCallback(async (open: boolean) => {
    if (!open) {
      await onDismiss(currentIndex);
      resetState();
    }
  }, [onDismiss, currentIndex, resetState]);

  const handleAnswer = useCallback((value: SurveyAnswer) => {
    setAnswers(prev => {
      const next = [...prev];
      next[currentIndex] = value;
      return next;
    });
  }, [currentIndex]);

  const handleScaleComment = useCallback((comment: string) => {
    setScaleComments(prev => ({ ...prev, [currentIndex]: comment }));
  }, [currentIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex < totalQuestions - 1) {
      setCurrentIndex(prev => prev + 1);
    }
  }, [currentIndex, totalQuestions]);

  const handlePrevious = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    }
  }, [currentIndex]);

  const handleSubmit = useCallback(async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const formattedAnswers = config.questions.map((q, i) => ({
        questionIndex: i,
        questionType: q.type,
        answer: answers[i],
        ...(q.type === 'scale' && scaleComments[i] ? { comment: scaleComments[i] } : {}),
      }));
      await onComplete(formattedAnswers);
      resetState();
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, config.questions, answers, scaleComments, onComplete, resetState]);

  const handleSkipSurvey = useCallback(async () => {
    await onDismiss(currentIndex);
    resetState();
  }, [onDismiss, currentIndex, resetState]);

  const stepLabel = `${currentIndex + 1} of ${totalQuestions}`;

  if (!isOpen) return null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={handleOpenChange}
      disableOutsideClose
    >
      <DialogContent size="md" className={styles.dialog} aria-labelledby={titleId}>
        <div className={styles.container}>
          <div className={styles.header}>
            <img
              src={REBEL_MASCOT_URL}
              alt=""
              aria-hidden="true"
              className={styles.mascot}
            />
            <div className={styles.headerText}>
              <h2 id={titleId} className={styles.title}>{config.title}</h2>
              {config.subtitle && <p className={styles.subtitle}>{config.subtitle}</p>}
            </div>
            <span className={styles.stepCounter} aria-label={`Question ${currentIndex + 1} of ${totalQuestions}`}>
              {stepLabel}
            </span>
          </div>

          <div className={styles.questionArea}>
            <p className={styles.questionText}>{currentQuestion.text}</p>
            <div className={styles.answerArea}>
              <QuestionRenderer
                question={currentQuestion}
                answer={currentAnswer}
                comment={scaleComments[currentIndex] ?? ''}
                onAnswer={handleAnswer}
                onCommentChange={handleScaleComment}
              />
            </div>
          </div>

          <div className={styles.footer}>
            <Button
              variant="ghost"
              size="sm"
              className={styles.skipButton}
              onClick={handleSkipSurvey}
              disabled={isSubmitting}
            >
              Skip survey
            </Button>
            <div className={styles.navButtons}>
              {currentIndex > 0 && (
                <Button variant="outline" size="sm" onClick={handlePrevious} disabled={isSubmitting}>
                  Previous
                </Button>
              )}
              {isLastQuestion ? (
                <Button size="sm" onClick={handleSubmit} disabled={isSubmitting}>
                  {isSubmitting ? 'Submitting…' : 'Submit'}
                </Button>
              ) : (
                <Button size="sm" onClick={handleNext}>
                  {hasAnswer ? 'Next' : 'Skip'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

function QuestionRenderer({
  question,
  answer,
  comment,
  onAnswer,
  onCommentChange,
}: {
  question: SurveyQuestion;
  answer: SurveyAnswer;
  comment: string;
  onAnswer: (value: SurveyAnswer) => void;
  onCommentChange: (comment: string) => void;
}) {
  switch (question.type) {
    case 'scale':
      return (
        <ScaleQuestion
          question={question}
          value={typeof answer === 'number' ? answer : null}
          comment={comment}
          onChange={onAnswer}
          onCommentChange={onCommentChange}
        />
      );
    case 'open-ended':
      return (
        <OpenEndedQuestion
          question={question}
          value={typeof answer === 'string' ? answer : ''}
          onChange={onAnswer}
        />
      );
    default:
      return null;
  }
}

SurveyModal.displayName = 'SurveyModal';
