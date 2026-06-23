/**
 * PrincipleOptionsPicker — mobile UI for the multi-choice principle picker
 * used by Approve-Always / Deny-Always flows on each approval detail sheet.
 *
 * Consumes `usePrincipleOptions` (shared in `@rebel/cloud-client`) and
 * renders all 5 generation states plus a free-text fallback:
 *   idle                  — nothing shown yet; caller hasn't invoked `startGeneration`
 *   loading               — skeleton ("generating principle options…")
 *   has-options           — list of LLM-suggested principle rows + custom input
 *   zero-options-fallback — "no suggestions — type your own"
 *   error                 — error message + retry + free-text fallback
 *
 * Stage D of `docs/plans/260417_approval_consolidation_closeout.md`.
 *
 * Copy bias: short + Rebel voice (see `docs/project/BRAND_VOICE.md`):
 *   - Header: "Why?"
 *   - Custom input placeholder: "Your reason (optional)"
 *   - Zero-options: "No suggestions — tell me why yourself."
 *   - Error: "Couldn't generate suggestions. Try again?"
 *
 * Host pattern: each approval sheet renders one picker per direction
 * ("accept" or "deny"). The caller owns the hook (so the `onApprove` /
 * `onDeny` closures capture the right action), and passes selected state
 * + setters in here. This avoids this component silently calling store
 * actions it doesn't know about.
 */

import { memo, useMemo } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import type {
  PrincipleOption,
  UsePrincipleOptionsReturn,
} from '@rebel/cloud-client';

import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Props — narrow subset of the hook's return so the picker is easy to mock
// ---------------------------------------------------------------------------

type HookSlice = Pick<
  UsePrincipleOptionsReturn,
  | 'generationState'
  | 'options'
  | 'generationError'
  | 'selectedOption'
  | 'otherText'
  | 'applyState'
  | 'applyError'
  | 'selectOption'
  | 'setOtherText'
  | 'confirmSelection'
  | 'confirmTrustedTool'
  | 'cancelTrustedTool'
  | 'retryGeneration'
  | 'retryApply'
  | 'direction'
>;

export interface PrincipleOptionsPickerProps extends HookSlice {
  /** Test-ID prefix so multiple pickers on the same screen don't collide. */
  testIDPrefix?: string;
  /**
   * Optional header override. Defaults to "Why?" per brand voice guidance.
   * Callers can pass an empty string to suppress the header entirely.
   */
  header?: string;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      gap: 10,
    },
    header: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
    },
    loadingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 8,
    },
    loadingText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    optionRow: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 12,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.surface,
    },
    optionRowSelected: {
      borderColor: colors.accent,
      backgroundColor: `${colors.accent}15`,
    },
    optionLabel: {
      ...typography.bodySmall,
      color: colors.textPrimary,
      flex: 1,
    },
    optionLabelSelected: {
      color: colors.textPrimary,
      fontWeight: '600',
    },
    optionScope: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    radio: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioSelected: {
      borderColor: colors.accent,
    },
    radioDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: colors.accent,
    },
    otherRow: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 12,
      gap: 8,
      backgroundColor: colors.surface,
    },
    otherRowSelected: {
      borderColor: colors.accent,
    },
    otherInput: {
      ...typography.body,
      color: colors.textPrimary,
      paddingVertical: 6,
      paddingHorizontal: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      minHeight: 44,
    },
    confirmButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 6,
    },
    confirmButtonDisabled: {
      opacity: 0.5,
    },
    confirmButtonText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: '#fff',
    },
    errorBlock: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: `${colors.error}55`,
      backgroundColor: `${colors.error}11`,
      padding: 12,
      gap: 8,
    },
    errorText: {
      ...typography.bodySmall,
      color: colors.error,
    },
    retryButton: {
      alignSelf: 'flex-start',
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: `${colors.error}88`,
    },
    retryButtonText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.error,
    },
    fallbackText: {
      ...typography.bodySmall,
      color: colors.textSecondary,
    },
    applyingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 6,
    },
    applyingText: {
      ...typography.caption,
      color: colors.textTertiary,
    },
    // F-D-R2-2 — confirming_trust block styling.
    trustConfirmBlock: {
      borderRadius: 10,
      borderWidth: 1,
      borderColor: `${colors.warning}55`,
      backgroundColor: `${colors.warning}11`,
      padding: 12,
      gap: 10,
    },
    trustConfirmMessage: {
      ...typography.bodySmall,
      color: colors.textPrimary,
    },
    trustConfirmActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      justifyContent: 'flex-end',
    },
    trustConfirmCancel: {
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    trustConfirmCancelText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    trustConfirmPrimary: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    trustConfirmPrimaryDanger: {
      backgroundColor: colors.error,
    },
    trustConfirmPrimaryText: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: '#fff',
    },
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type OptionRowProps = {
  option: PrincipleOption;
  index: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (index: number) => void;
  testID: string;
  styles: ReturnType<typeof createStyles>;
};

const OptionRow = memo(function OptionRow({
  option,
  index,
  selected,
  disabled,
  onSelect,
  testID,
  styles,
}: OptionRowProps) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={() => onSelect(index)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={`Principle option ${index + 1}: ${option.label}`}
      style={[styles.optionRow, selected && styles.optionRowSelected]}
      activeOpacity={0.7}
    >
      <View style={[styles.radio, selected && styles.radioSelected]}>
        {selected ? <View style={styles.radioDot} /> : null}
      </View>
      <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
        {option.label}
      </Text>
    </TouchableOpacity>
  );
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PrincipleOptionsPicker = memo(function PrincipleOptionsPicker({
  generationState,
  options,
  generationError,
  selectedOption,
  otherText,
  applyState,
  applyError,
  selectOption,
  setOtherText,
  confirmSelection,
  confirmTrustedTool,
  cancelTrustedTool,
  retryGeneration,
  retryApply,
  direction,
  testIDPrefix = 'principle-picker',
  header = 'Why?',
}: PrincipleOptionsPickerProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const applying = applyState === 'applying';
  const confirmingTrust = applyState === 'confirming_trust';

  const confirmDisabled =
    applying
    || selectedOption === null
    || (selectedOption === 'other' && otherText.trim().length === 0);

  const confirmLabel = direction === 'deny' ? 'Block' : 'Allow';

  // Custom free-text row. Shown in has-options, zero-options-fallback, and error states.
  const renderCustomInput = (disabled: boolean) => (
    <View
      testID={`${testIDPrefix}-other-row`}
      style={[
        s.otherRow,
        selectedOption === 'other' && s.otherRowSelected,
      ]}
    >
      <TouchableOpacity
        testID={`${testIDPrefix}-other-select`}
        onPress={() => selectOption('other')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: selectedOption === 'other', disabled }}
        accessibilityLabel="Write my own reason"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={[s.radio, selectedOption === 'other' && s.radioSelected]}>
            {selectedOption === 'other' ? <View style={s.radioDot} /> : null}
          </View>
          <Text
            style={[
              s.optionLabel,
              selectedOption === 'other' && s.optionLabelSelected,
            ]}
          >
            Write my own reason
          </Text>
        </View>
      </TouchableOpacity>
      {selectedOption === 'other' ? (
        <TextInput
          testID={`${testIDPrefix}-other-input`}
          style={s.otherInput}
          placeholder="Your reason (optional)"
          placeholderTextColor={colors.textTertiary}
          value={otherText}
          onChangeText={setOtherText}
          editable={!disabled}
          multiline
          autoFocus
          accessibilityLabel="Custom principle reason"
        />
      ) : null}
    </View>
  );

  return (
    <View testID={testIDPrefix} style={s.container}>
      {header ? <Text style={s.header}>{header}</Text> : null}

      {generationState === 'loading' && (
        <View testID={`${testIDPrefix}-loading`} style={s.loadingRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={s.loadingText}>Generating suggestions…</Text>
        </View>
      )}

      {generationState === 'loaded' && options.length > 0 && (
        <>
          {options.map((opt, idx) => (
            <OptionRow
              key={`${idx}-${opt.label}`}
              option={opt}
              index={idx}
              selected={selectedOption === idx}
              disabled={applying}
              onSelect={selectOption}
              testID={`${testIDPrefix}-option-${idx}`}
              styles={s}
            />
          ))}
          {renderCustomInput(applying)}
        </>
      )}

      {generationState === 'loaded' && options.length === 0 && (
        <>
          <Text testID={`${testIDPrefix}-zero-options`} style={s.fallbackText}>
            No suggestions — tell me why yourself.
          </Text>
          {renderCustomInput(applying)}
        </>
      )}

      {generationState === 'error' && (
        <View testID={`${testIDPrefix}-error`} style={s.errorBlock}>
          <Text style={s.errorText}>
            {generationError ?? "Couldn't generate suggestions. Try again?"}
          </Text>
          <TouchableOpacity
            testID={`${testIDPrefix}-retry-generation`}
            style={s.retryButton}
            onPress={retryGeneration}
            disabled={applying}
            accessibilityRole="button"
            accessibilityLabel="Retry generating principle suggestions"
            activeOpacity={0.7}
          >
            <Text style={s.retryButtonText}>Try again</Text>
          </TouchableOpacity>
          {renderCustomInput(applying)}
        </View>
      )}

      {/* Apply error (distinct from generation error) */}
      {applyState === 'error' && (
        <View testID={`${testIDPrefix}-apply-error`} style={s.errorBlock}>
          <Text style={s.errorText}>{applyError ?? 'Failed to save.'}</Text>
          <TouchableOpacity
            testID={`${testIDPrefix}-retry-apply`}
            style={s.retryButton}
            onPress={retryApply}
            accessibilityRole="button"
            accessibilityLabel="Retry saving the principle"
            activeOpacity={0.7}
          >
            <Text style={s.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {applying && (
        <View testID={`${testIDPrefix}-applying`} style={s.applyingRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={s.applyingText}>Saving…</Text>
        </View>
      )}

      {/*
       * F-D-R2-2 — confirming_trust branch. Reached when the user picks a
       * `trusted_tool`-scoped option; the hook pauses in
       * `applyState === 'confirming_trust'` awaiting explicit user
       * confirmation or cancel. Without this branch the picker silently
       * stalls after Confirm. Mirrors the desktop copy in
       * `src/renderer/components/approval/UnifiedApprovalCard.tsx:491+620`.
       */}
      {confirmingTrust && (
        <View testID={`${testIDPrefix}-confirming-trust`} style={s.trustConfirmBlock}>
          <Text style={s.trustConfirmMessage}>
            {direction === 'deny'
              ? 'This will always be blocked by your safety rules. Are you sure?'
              : 'This tool will always be allowed without safety checks. Are you sure?'}
          </Text>
          <View style={s.trustConfirmActions}>
            <TouchableOpacity
              testID={`${testIDPrefix}-confirming-trust-cancel`}
              style={s.trustConfirmCancel}
              onPress={cancelTrustedTool}
              accessibilityRole="button"
              accessibilityLabel="Cancel trust confirmation"
              activeOpacity={0.7}
            >
              <Text style={s.trustConfirmCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID={`${testIDPrefix}-confirming-trust-confirm`}
              style={[
                s.trustConfirmPrimary,
                direction === 'deny' && s.trustConfirmPrimaryDanger,
              ]}
              onPress={confirmTrustedTool}
              accessibilityRole="button"
              accessibilityLabel={
                direction === 'deny'
                  ? 'Confirm — always block'
                  : 'Confirm — always allow'
              }
              activeOpacity={0.8}
            >
              <Text style={s.trustConfirmPrimaryText}>
                {direction === 'deny' ? 'Yes, always block' : 'Yes, always allow'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/*
       * Show confirm button when the hook has either fully loaded or
       * errored (but we're not already in the trust-confirmation branch).
       * S2 — both branches of the deny/allow ternary produced identical
       * strings; replaced with a single interpolation.
       */}
      {(generationState === 'loaded' || generationState === 'error')
        && !confirmingTrust
        && (
        <TouchableOpacity
          testID={`${testIDPrefix}-confirm`}
          style={[s.confirmButton, confirmDisabled && s.confirmButtonDisabled]}
          onPress={confirmSelection}
          disabled={confirmDisabled}
          accessibilityRole="button"
          accessibilityLabel={`Confirm principle — ${confirmLabel}`}
          accessibilityState={{ disabled: confirmDisabled }}
          activeOpacity={0.8}
        >
          <Feather
            name={direction === 'deny' ? 'shield-off' : 'check'}
            size={14}
            color="#fff"
          />
          <Text style={s.confirmButtonText}>{`${confirmLabel} always`}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
});

PrincipleOptionsPicker.displayName = 'PrincipleOptionsPicker';

export default PrincipleOptionsPicker;
