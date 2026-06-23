import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { Pressable } from './Pressable';
import { ApprovalSheetShell } from './approval/ApprovalSheetShell';

const typography = createTypography(true);

export type AskSparkPickerSubtitleVariant = 'default' | 'offline' | 'rate-limited';

export interface AskSparkOption {
  label: string;
  triggerExtracted: string;
  icon: React.ComponentProps<typeof Feather>['name'];
}

export const ASK_SPARK_OPTIONS: AskSparkOption[] = [
  {
    label: 'Summarise so far',
    triggerExtracted: 'Summarise what we\'ve covered in this meeting so far.',
    icon: 'align-left',
  },
  {
    label: 'Find open questions',
    triggerExtracted: 'What open questions have come up in this meeting?',
    icon: 'help-circle',
  },
  {
    label: 'Name the elephant',
    triggerExtracted: 'What\'s the elephant in the room in this meeting?',
    icon: 'alert-circle',
  },
  {
    label: 'Draft next steps',
    triggerExtracted: 'Draft the next steps from this meeting.',
    icon: 'check-square',
  },
  {
    label: 'Show my prep notes',
    triggerExtracted: 'Show me my prep notes for this meeting.',
    icon: 'file-text',
  },
];

const SUBTITLES: Record<AskSparkPickerSubtitleVariant, string> = {
  default: 'Pick a question. Answers stay here, not in the call.',
  offline: 'Pick a question. Spark will answer when reconnected.',
  'rate-limited': 'Voice trigger is paused. The button still works.',
};

export interface AskSparkPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelectPrompt: (triggerExtracted: string) => void;
  subtitleVariant?: AskSparkPickerSubtitleVariant;
}

export function AskSparkPicker({
  visible,
  onClose,
  onSelectPrompt,
  subtitleVariant = 'default',
}: AskSparkPickerProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  return (
    <ApprovalSheetShell
      visible={visible}
      onClose={onClose}
      title="Ask Spark"
      subtitle={SUBTITLES[subtitleVariant]}
      testID="ask-spark-picker"
      maxHeight="55%"
    >
      <View style={s.options}>
        {ASK_SPARK_OPTIONS.map((option) => (
          <Pressable
            key={option.label}
            onPress={() => {
              onClose();
              onSelectPrompt(option.triggerExtracted);
            }}
            style={s.optionRow}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            testID={`ask-spark-option-${option.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
          >
            <Feather name={option.icon} size={18} color={colors.accent} />
            <Text style={s.optionLabel}>{option.label}</Text>
            <Feather name="chevron-right" size={16} color={colors.textTertiary} />
          </Pressable>
        ))}
      </View>
    </ApprovalSheetShell>
  );
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    options: {
      gap: 8,
    },
    optionRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      width: '100%',
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    optionLabel: {
      ...typography.bodySmall,
      flex: 1,
      color: colors.textPrimary,
      fontWeight: '600',
    },
  });
}
