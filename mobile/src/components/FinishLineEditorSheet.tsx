import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { FINISH_LINE_MAX_LENGTH, normalizeFinishLine } from '@core/utils/finishLine';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';

const typography = createTypography(true);
const COUNTER_THRESHOLD = 400;

export interface FinishLineEditorSheetProps {
  visible: boolean;
  initialValue: string | undefined;
  onClose: () => void;
  onSave: (next: string) => Promise<void>;
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 18,
      backgroundColor: `${colors.shadowColor}80`,
    },
    card: {
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 20,
      elevation: 8,
      overflow: 'hidden',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 18,
      paddingTop: 18,
      paddingBottom: 10,
    },
    title: {
      ...typography.body,
      color: colors.textPrimary,
      fontSize: 17,
      fontWeight: '700',
    },
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
    },
    body: {
      paddingHorizontal: 18,
      paddingBottom: 14,
      gap: 8,
    },
    input: {
      minHeight: 124,
      maxHeight: 180,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      paddingHorizontal: 14,
      paddingVertical: 12,
      ...typography.body,
      fontSize: 15,
      lineHeight: 21,
      textAlignVertical: 'top',
    },
    helperRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
    },
    helperText: {
      ...typography.caption,
      color: colors.textTertiary,
      flex: 1,
    },
    counter: {
      ...typography.caption,
      color: colors.textTertiary,
      fontWeight: '600',
    },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 18,
      paddingTop: 12,
      paddingBottom: 18,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    footerButton: {
      minHeight: 38,
      paddingHorizontal: 14,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryButton: {
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    clearButton: {
      borderWidth: 1,
      borderColor: colors.error,
      backgroundColor: colors.errorLight,
    },
    saveButton: {
      minWidth: 72,
      backgroundColor: colors.accent,
    },
    buttonDisabled: {
      opacity: 0.45,
    },
    buttonText: {
      ...typography.bodySmall,
      fontSize: 14,
      fontWeight: '700',
      color: colors.textSecondary,
    },
    clearButtonText: {
      color: colors.error,
    },
    saveButtonText: {
      color: '#fff',
    },
  });
}

export function FinishLineEditorSheet({
  visible,
  initialValue,
  onClose,
  onSave,
}: FinishLineEditorSheetProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [draft, setDraft] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDraft(normalizeFinishLine(initialValue) ?? '');
    setIsSaving(false);
  }, [initialValue, visible]);

  const initialNormalized = normalizeFinishLine(initialValue) ?? '';
  const draftNormalized = normalizeFinishLine(draft) ?? '';
  const hasExistingValue = initialNormalized.length > 0;
  const hasDraftValue = draftNormalized.length > 0;
  const isUnchanged = draftNormalized === initialNormalized;
  const saveDisabled = isSaving || isUnchanged || (draftNormalized.length === 0 && !hasExistingValue);
  const showCounter = draft.length > COUNTER_THRESHOLD;
  const helperText = hasDraftValue
    ? 'Rebel stops when this is met.'
    : 'No finish line. Rebel will use its usual judgment.';

  const handleSave = useCallback(async () => {
    if (saveDisabled) return;
    setIsSaving(true);
    try {
      await onSave(draftNormalized);
    } finally {
      setIsSaving(false);
    }
  }, [draftNormalized, onSave, saveDisabled]);

  const handleClear = useCallback(async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await onSave('');
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, onSave]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      testID="finish-line-editor-sheet"
      accessibilityViewIsModal
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={s.overlay}
      >
        <View style={s.card} accessibilityLabel="Finish line editor">
          <View style={s.header}>
            <Text style={s.title}>Finish line</Text>
            <Pressable
              testID="finish-line-editor-close-button"
              style={s.closeButton}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close finish line editor"
            >
              <Feather name="x" size={18} color={colors.textSecondary} />
            </Pressable>
          </View>

          <View style={s.body}>
            <TextInput
              testID="finish-line-editor-input"
              style={s.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Example: The brief is ready to send, with risks called out."
              placeholderTextColor={colors.textTertiary}
              multiline
              autoFocus={visible}
              maxLength={FINISH_LINE_MAX_LENGTH}
              accessibilityLabel="Finish line"
              accessibilityHint="Rebel stops when this is met"
            />
            <View style={s.helperRow}>
              <Text style={s.helperText}>{helperText}</Text>
              {showCounter && (
                <Text
                  testID="finish-line-editor-counter"
                  style={s.counter}
                  accessibilityLiveRegion="polite"
                  accessibilityRole="text"
                >
                  {draft.length}/{FINISH_LINE_MAX_LENGTH}
                </Text>
              )}
            </View>
          </View>

          <View style={s.footer}>
            <TouchableOpacity
              testID="finish-line-editor-cancel-button"
              style={[s.footerButton, s.secondaryButton]}
              onPress={onClose}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              accessibilityState={{ disabled: isSaving }}
            >
              <Text style={s.buttonText}>Cancel</Text>
            </TouchableOpacity>
            {hasExistingValue && (
              <TouchableOpacity
                testID="finish-line-editor-clear-button"
                style={[s.footerButton, s.clearButton, isSaving && s.buttonDisabled]}
                onPress={handleClear}
                disabled={isSaving}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Clear finish line"
                accessibilityState={{ disabled: isSaving }}
              >
                <Text style={[s.buttonText, s.clearButtonText]}>Clear</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              testID="finish-line-editor-save-button"
              style={[s.footerButton, s.saveButton, saveDisabled && s.buttonDisabled]}
              onPress={handleSave}
              disabled={saveDisabled}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={isSaving ? 'Saving finish line' : 'Save finish line'}
              accessibilityState={{ disabled: saveDisabled, busy: isSaving }}
            >
              {isSaving ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={[s.buttonText, s.saveButtonText]}>Save</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
