/**
 * UserQuestionCard — Mobile
 *
 * Touch-optimized inline card for the Ask User Questions feature.
 *
 * Mirrors the desktop UserQuestionCard behavior but with RN primitives:
 *  - Progressive one-question-at-a-time stepper
 *  - Select options (single or multi-select)
 *  - Optional free-text input for requiresInput options
 *  - Skip-all, submit, and dismiss controls
 *  - Read-only answered view after submission
 *
 * See docs/plans/260420_user_question_cross_surface_resilience.md Stage 5.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import type {
  UserQuestion,
  UserQuestionAnswer,
  UserQuestionBatch,
} from '@shared/types';
import { isApprovalClarificationBatch } from '@shared/types/userQuestion';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';

const typography = createTypography(true);

const SKIPPED_MARKER = '[Skipped]';
const OTHER_OPTION_ID = '__other__';
const CHECK_ICON_COLOR = '#ffffff';

export interface UserQuestionCardProps {
  batch: UserQuestionBatch;
  isAnswered: boolean;
  answers?: UserQuestionAnswer[];
  skipped?: boolean;
  isSubmitting: boolean;
  error?: string | null;
  onSubmit: (batchId: string, answers: UserQuestionAnswer[]) => Promise<void>;
  onSkip: (batchId: string) => Promise<void>;
  onDismiss: (batchId: string) => void;
  onMinimize?: (batchId: string) => void;
}

interface QuestionSelection {
  selectedOptionIds: Set<string>;
  freeText: string;
  otherSelected: boolean;
}

function createInitialSelections(
  questions: UserQuestion[],
): Map<string, QuestionSelection> {
  const map = new Map<string, QuestionSelection>();
  for (const q of questions) {
    map.set(q.id, {
      selectedOptionIds: new Set<string>(),
      freeText: '',
      otherSelected: false,
    });
  }
  return map;
}

function buildAnswers(
  questions: UserQuestion[],
  selections: Map<string, QuestionSelection>,
): UserQuestionAnswer[] {
  return questions.map((q) => {
    const sel = selections.get(q.id);
    if (!sel) return { questionId: q.id, selectedOptionIds: [] };
    const isFreeTextOnly = q.options.length === 0;
    const hasRequiresInputSelected = q.options.some(
      (o) => o.requiresInput && sel.selectedOptionIds.has(o.id),
    );
    const freeText = (isFreeTextOnly || hasRequiresInputSelected || sel.otherSelected) && sel.freeText.trim()
      ? sel.freeText.trim()
      : undefined;
    return {
      questionId: q.id,
      selectedOptionIds: Array.from(sel.selectedOptionIds),
      ...(freeText ? { freeText } : {}),
    };
  });
}

function formatAnswerSummary(
  question: UserQuestion,
  answer: UserQuestionAnswer,
): string {
  if (answer.freeText === SKIPPED_MARKER) return 'Skipped';
  const labels = answer.selectedOptionIds
    .map((id) => question.options.find((o) => o.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  if (answer.freeText && answer.freeText.trim()) {
    return labels.length > 0
      ? `${labels.join(', ')} — ${answer.freeText}`
      : answer.freeText;
  }
  return labels.length > 0 ? labels.join(', ') : '(no answer)';
}

function UserQuestionCardImpl({
  batch,
  isAnswered,
  answers,
  skipped,
  isSubmitting,
  error,
  onSubmit,
  onSkip,
  onDismiss,
  onMinimize,
}: UserQuestionCardProps) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const isApprovalClarification = isApprovalClarificationBatch(batch);

  const [stepIndex, setStepIndex] = useState(0);
  const [selections, setSelections] = useState<Map<string, QuestionSelection>>(
    () => createInitialSelections(batch.questions),
  );

  const currentQuestion = batch.questions[stepIndex];
  const isLastStep = stepIndex === batch.questions.length - 1;

  const toggleOption = useCallback((questionId: string, optionId: string, multiSelect: boolean) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const sel = next.get(questionId) ?? {
        selectedOptionIds: new Set<string>(),
        freeText: '',
        otherSelected: false,
      };
      const selectedOptionIds = new Set(sel.selectedOptionIds);
      if (multiSelect) {
        if (selectedOptionIds.has(optionId)) {
          selectedOptionIds.delete(optionId);
        } else {
          selectedOptionIds.add(optionId);
        }
      } else {
        selectedOptionIds.clear();
        selectedOptionIds.add(optionId);
      }
      next.set(questionId, { ...sel, selectedOptionIds, otherSelected: false });
      return next;
    });
  }, []);

  const toggleOther = useCallback((questionId: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const sel = next.get(questionId) ?? {
        selectedOptionIds: new Set<string>(),
        freeText: '',
        otherSelected: false,
      };
      next.set(questionId, {
        ...sel,
        selectedOptionIds: new Set<string>(),
        otherSelected: !sel.otherSelected,
      });
      return next;
    });
  }, []);

  const setFreeText = useCallback((questionId: string, text: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const sel = next.get(questionId) ?? {
        selectedOptionIds: new Set<string>(),
        freeText: '',
        otherSelected: false,
      };
      next.set(questionId, { ...sel, freeText: text });
      return next;
    });
  }, []);

  const canAdvance = useMemo(() => {
    if (!currentQuestion) return false;
    const sel = selections.get(currentQuestion.id);
    if (!sel) return false;
    if (currentQuestion.options.length === 0) return sel.freeText.trim().length > 0;
    if (sel.otherSelected) return sel.freeText.trim().length > 0;
    if (sel.selectedOptionIds.size === 0) return false;
    // If any selected option requires input, freeText must be non-empty.
    const needsInput = currentQuestion.options.some(
      (o) => o.requiresInput && sel.selectedOptionIds.has(o.id),
    );
    if (needsInput && sel.freeText.trim().length === 0) return false;
    return true;
  }, [currentQuestion, selections]);

  const handleNext = useCallback(() => {
    if (!canAdvance) return;
    if (isLastStep) {
      const payload = buildAnswers(batch.questions, selections);
      void onSubmit(batch.batchId, payload);
    } else {
      setStepIndex((idx) => Math.min(idx + 1, batch.questions.length - 1));
    }
  }, [batch.batchId, batch.questions, canAdvance, isLastStep, onSubmit, selections]);

  const handleBack = useCallback(() => {
    setStepIndex((idx) => Math.max(idx - 1, 0));
  }, []);

  const handleSkip = useCallback(() => {
    void onSkip(batch.batchId);
  }, [batch.batchId, onSkip]);

  const handleDismiss = useCallback(() => {
    onDismiss(batch.batchId);
  }, [batch.batchId, onDismiss]);

  const handleOpenOptionUrl = useCallback((url: string) => {
    void Linking.openURL(url).catch(() => {
      // URL invalid / browser unavailable — degrade silently
    });
  }, []);

  // Answered / skipped read-only view
  if (isAnswered) {
    const headerLabel = isApprovalClarification
        ? 'Clarification answered'
        : skipped
          ? 'You skipped these questions'
          : 'You answered';
    return (
      <View style={styles.cardAnswered} testID={`user-question-card-answered-${batch.batchId}`}>
        <View style={styles.header}>
          <Feather
            name="check-circle"
            size={18}
            color={colors.textSecondary}
          />
          <Text style={styles.headerLabelMuted}>
            {headerLabel}
          </Text>
        </View>
        {!skipped && answers && batch.questions.map((q, idx) => {
          const answer = answers[idx];
          if (!answer) return null;
          return (
            <View key={q.id} style={styles.answeredRow}>
              <Text style={styles.answeredQuestion}>{q.header ?? q.question}</Text>
              <Text style={styles.answeredValue}>{formatAnswerSummary(q, answer)}</Text>
            </View>
          );
        })}
        {isApprovalClarification && !skipped ? (
          <Text style={styles.approvalNote}>
            Rebel will check your Safety Rules before sending or changing anything.
          </Text>
        ) : null}
      </View>
    );
  }

  if (!currentQuestion) {
    return null;
  }

  const currentSelection = selections.get(currentQuestion.id);

  return (
    <View
      style={[styles.card, isApprovalClarification && styles.cardApproval]}
      testID={`user-question-card-${batch.batchId}`}
    >
      <View style={styles.header}>
        <Feather
          name={isApprovalClarification ? 'shield' : 'help-circle'}
          size={18}
          color={isApprovalClarification ? colors.textSecondary : colors.accent}
        />
        <Text style={[
          styles.headerLabel,
          isApprovalClarification && styles.headerLabelApproval,
        ]}>
          {isApprovalClarification ? 'One detail before continuing' : 'Rebel has a question'}
        </Text>
        {isApprovalClarification && batch.questions.length > 1 ? (
          <View style={styles.progressPill}>
            <Text style={styles.progressPillText}>
              {stepIndex + 1} of {batch.questions.length}
            </Text>
          </View>
        ) : null}
        {onMinimize && (
          <TouchableOpacity
            onPress={() => onMinimize(batch.batchId)}
            accessibilityLabel="Minimize question"
            testID={`user-question-minimize-${batch.batchId}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="minus" size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={handleDismiss}
          accessibilityLabel="Dismiss question"
          testID={`user-question-dismiss-${batch.batchId}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Feather name="x" size={18} color={colors.textTertiary} />
        </TouchableOpacity>
      </View>

      {batch.questions.length > 1 && !isApprovalClarification && (
        <Text style={styles.stepIndicator}>
          Question {stepIndex + 1} of {batch.questions.length}
        </Text>
      )}

      <Text style={styles.question}>{currentQuestion.question}</Text>

      {isApprovalClarification && currentQuestion.context ? (
        <Text style={styles.context}>{currentQuestion.context}</Text>
      ) : null}

      {isApprovalClarification ? (
        <Text style={styles.context}>
          This only clarifies this request. Rebel checks your Safety Rules before acting.
        </Text>
      ) : null}

      {currentQuestion.context && !isApprovalClarification ? (
        <Text style={styles.context}>{currentQuestion.context}</Text>
      ) : null}

      <View style={styles.optionsContainer}>
        {currentQuestion.options.length === 0 ? (
          <TextInput
            style={styles.freeTextInput}
            value={currentSelection?.freeText ?? ''}
            onChangeText={(t) => setFreeText(currentQuestion.id, t)}
            placeholder="Type your answer"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="sentences"
            autoCorrect
            testID={`user-question-input-${OTHER_OPTION_ID}`}
          />
        ) : currentQuestion.options.map((option) => {
          const selected = currentSelection?.selectedOptionIds.has(option.id) ?? false;
          return (
            <View key={option.id}>
              <TouchableOpacity
                style={[styles.option, selected && styles.optionSelected]}
                onPress={() => toggleOption(currentQuestion.id, option.id, currentQuestion.multiSelect)}
                accessibilityLabel={option.label}
                testID={`user-question-option-${option.id}`}
              >
                <View style={styles.optionRow}>
                  <View style={[styles.optionDot, selected && styles.optionDotSelected]}>
                    {selected ? <Feather name="check" size={12} color={CHECK_ICON_COLOR} /> : null}
                  </View>
                  <View style={styles.optionTextContainer}>
                    <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                      {option.label}
                    </Text>
                    {option.description ? (
                      <Text style={styles.optionDescription}>{option.description}</Text>
                    ) : null}
                  </View>
                  {option.url ? (
                    <TouchableOpacity
                      onPress={() => handleOpenOptionUrl(option.url!)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityLabel="Open link"
                    >
                      <Feather name="external-link" size={16} color={colors.accent} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              </TouchableOpacity>
              {selected && option.requiresInput ? (
                <TextInput
                  style={styles.freeTextInput}
                  value={currentSelection?.freeText ?? ''}
                  onChangeText={(t) => setFreeText(currentQuestion.id, t)}
                  placeholder={option.inputPlaceholder ?? 'Enter value'}
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID={`user-question-input-${option.id}`}
                />
              ) : null}
            </View>
          );
        })}
        {currentQuestion.options.length > 0 ? (
          <View>
            <TouchableOpacity
              style={[
                styles.option,
                currentSelection?.otherSelected && styles.optionSelected,
              ]}
              onPress={() => toggleOther(currentQuestion.id)}
              accessibilityLabel="Something else"
              testID={`user-question-option-${OTHER_OPTION_ID}`}
            >
              <View style={styles.optionRow}>
                <View style={[
                  styles.optionDot,
                  currentSelection?.otherSelected && styles.optionDotSelected,
                ]}>
                  {currentSelection?.otherSelected ? (
                    <Feather name="check" size={12} color={CHECK_ICON_COLOR} />
                  ) : null}
                </View>
                <View style={styles.optionTextContainer}>
                  <Text style={[
                    styles.optionLabel,
                    currentSelection?.otherSelected && styles.optionLabelSelected,
                  ]}>
                    Something else
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
            {currentSelection?.otherSelected ? (
              <TextInput
                style={styles.freeTextInput}
                value={currentSelection.freeText}
                onChangeText={(t) => setFreeText(currentQuestion.id, t)}
                placeholder="Type the answer"
                placeholderTextColor={colors.textTertiary}
                autoCapitalize="sentences"
                autoCorrect
                testID={`user-question-input-${OTHER_OPTION_ID}`}
              />
            ) : null}
          </View>
        ) : null}
      </View>

      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : null}

      <View style={styles.actions}>
        {!isApprovalClarification ? (
          <TouchableOpacity
            style={styles.skipButton}
            onPress={handleSkip}
            disabled={isSubmitting}
            accessibilityLabel="Skip all questions"
            testID={`user-question-skip-${batch.batchId}`}
          >
            <Text style={styles.skipText}>Skip all</Text>
          </TouchableOpacity>
        ) : null}
        <View style={styles.spacer} />
        {stepIndex > 0 ? (
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBack}
            disabled={isSubmitting}
            accessibilityLabel="Back"
            testID={`user-question-back-${batch.batchId}`}
          >
            <Feather name="chevron-left" size={16} color={colors.textSecondary} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[
            styles.submitButton,
            (!canAdvance || isSubmitting) && styles.submitButtonDisabled,
          ]}
          onPress={handleNext}
          disabled={!canAdvance || isSubmitting}
          accessibilityLabel={
            isApprovalClarification && isLastStep
              ? 'Answer clarification'
              : isLastStep
                ? 'Submit answers'
                : 'Next question'
          }
          testID={`user-question-next-${batch.batchId}`}
        >
          {isSubmitting && isLastStep ? (
            <ActivityIndicator size="small" color={CHECK_ICON_COLOR} />
          ) : (
            <>
              <Text style={styles.submitText}>
                {isLastStep && !isApprovalClarification ? 'Submit' : 'Next'}
              </Text>
              <Feather
                name={isLastStep && !isApprovalClarification ? 'send' : 'chevron-right'}
                size={16}
                color={CHECK_ICON_COLOR}
              />
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

export const UserQuestionCard = memo(UserQuestionCardImpl);

interface MinimizedQuestionPillProps {
  batchId: string;
  onRestore: (batchId: string) => void;
  onDismiss: (batchId: string) => void;
}

function MinimizedQuestionPillImpl({ batchId, onRestore, onDismiss }: MinimizedQuestionPillProps) {
  const colors = useColors();
  const pillStyles = useMemo(() => createPillStyles(colors), [colors]);
  return (
    <View style={pillStyles.pill} testID={`minimized-question-pill-${batchId}`}>
      <TouchableOpacity
        style={pillStyles.pillBody}
        onPress={() => onRestore(batchId)}
        accessibilityLabel="Restore question"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Feather name="help-circle" size={14} color={colors.accent} />
        <Text style={pillStyles.pillLabel}>Rebel has a question</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={pillStyles.pillDismiss}
        onPress={() => onDismiss(batchId)}
        accessibilityLabel="Dismiss question"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Feather name="x" size={14} color={colors.textTertiary} />
      </TouchableOpacity>
    </View>
  );
}

export const MinimizedQuestionPill = memo(MinimizedQuestionPillImpl);

function createPillStyles(colors: ColorTokens) {
  return StyleSheet.create({
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      borderRadius: 20,
      backgroundColor: 'rgba(37, 99, 235, 0.08)',
      borderWidth: 1,
      borderColor: 'rgba(37, 99, 235, 0.15)',
    },
    pillBody: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 6,
      paddingLeft: 10,
      paddingRight: 4,
    },
    pillLabel: {
      ...typography.caption,
      fontWeight: '600',
      color: colors.accent,
    },
    pillDismiss: {
      paddingVertical: 6,
      paddingHorizontal: 8,
    },
  });
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      gap: 12,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    cardApproval: {
      borderColor: colors.accentMuted,
      backgroundColor: colors.surface,
      gap: 14,
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 8,
      elevation: 3,
    },
    cardAnswered: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 14,
      gap: 6,
      borderWidth: 1,
      borderColor: colors.border,
      opacity: 0.85,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    headerLabel: {
      ...typography.body,
      fontWeight: '700',
      color: colors.textPrimary,
      flex: 1,
    },
    headerLabelApproval: {
      ...typography.bodySmall,
      fontWeight: '700',
      color: colors.textPrimary,
    },
    headerLabelMuted: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textSecondary,
      flex: 1,
    },
    progressPill: {
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.accentMuted,
      backgroundColor: colors.accentLight,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    progressPillText: {
      ...typography.caption,
      fontWeight: '700',
      color: colors.textSecondary,
    },
    stepIndicator: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    question: {
      ...typography.body,
      color: colors.textPrimary,
      fontWeight: '600',
    },
    context: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    approvalNote: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      backgroundColor: colors.background,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    optionsContainer: {
      gap: 8,
    },
    option: {
      backgroundColor: colors.background,
      borderRadius: 10,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    optionSelected: {
      borderColor: colors.accent,
      backgroundColor: colors.accentLight,
    },
    optionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    optionDot: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: colors.textTertiary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    optionDotSelected: {
      borderColor: colors.accent,
      backgroundColor: colors.accent,
    },
    optionTextContainer: {
      flex: 1,
      gap: 2,
    },
    optionLabel: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    optionLabelSelected: {
      color: colors.accent,
    },
    optionDescription: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    freeTextInput: {
      ...typography.bodySmall,
      color: colors.textPrimary,
      backgroundColor: colors.background,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: 'transparent',
      marginTop: 6,
    },
    error: {
      ...typography.caption,
      color: colors.error,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    spacer: {
      flex: 1,
    },
    skipButton: {
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    skipText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    backText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    submitButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    submitButtonDisabled: {
      opacity: 0.5,
    },
    submitText: {
      ...typography.bodySmall,
      fontWeight: '700',
      color: CHECK_ICON_COLOR,
    },
    answeredRow: {
      gap: 2,
      marginTop: 4,
    },
    answeredQuestion: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    answeredValue: {
      ...typography.bodySmall,
      color: colors.textPrimary,
    },
  });
}
