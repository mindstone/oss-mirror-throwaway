import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import type { MobileActivityViewModel } from '@rebel/cloud-client';
import type { TaskProgressItem } from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../../theme/colors';
import { createTypography } from '../../theme/typography';

const typography = createTypography(true);

const DEFAULT_PREVIEW_LIMIT = 3;
const DEFAULT_EXPANDED_LIMIT = 12;

export type ActivityPlanSectionProps = {
  viewModel: MobileActivityViewModel;
  isExpanded: boolean;
  previewLimit?: number;
  expandedLimit?: number;
};

type TaskStatus = TaskProgressItem['status'];

const STATUS_ICON_NAME: Record<TaskStatus, React.ComponentProps<typeof Feather>['name']> = {
  pending: 'circle',
  in_progress: 'loader',
  completed: 'check-circle',
  blocked: 'clock',
};

const STATUS_A11Y_LABEL: Record<TaskStatus, string> = {
  pending: 'Ready',
  in_progress: 'Working',
  completed: 'Done',
  blocked: 'Waiting',
};

const resolveStatusColor = (status: TaskStatus, colors: ColorTokens): string => {
  switch (status) {
    case 'in_progress':
      return colors.warning;
    case 'completed':
      return colors.success;
    case 'pending':
    case 'blocked':
    default:
      return colors.textTertiary;
  }
};

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { gap: 6 },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    label: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 11,
      lineHeight: 14,
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      flex: 1,
    },
    countText: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 11,
      lineHeight: 14,
    },
    progressTrack: {
      height: 3,
      borderRadius: 1.5,
      backgroundColor: colors.border,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: 1.5,
    },
    nowLine: {
      ...typography.bodySmall,
      color: colors.textPrimary,
      fontSize: 13,
      lineHeight: 18,
    },
    nowLabel: {
      color: colors.textTertiary,
      fontWeight: '600',
    },
    nextLine: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 12,
      lineHeight: 16,
    },
    taskList: { gap: 4, marginTop: 2 },
    taskRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
    },
    iconWrap: {
      width: 14,
      minHeight: 18,
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 2,
    },
    taskTitle: {
      ...typography.bodySmall,
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 18,
      flex: 1,
    },
    taskTitleCompleted: {
      textDecorationLine: 'line-through',
      color: colors.textTertiary,
    },
    overflowText: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 12,
      lineHeight: 16,
      marginTop: 2,
    },
  });
}

export const ActivityPlanSection = memo(function ActivityPlanSection({
  viewModel,
  isExpanded,
  previewLimit = DEFAULT_PREVIEW_LIMIT,
  expandedLimit = DEFAULT_EXPANDED_LIMIT,
}: ActivityPlanSectionProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const reducedMotion = useReducedMotion();

  const counts = viewModel.snapshotCounts;
  const total = counts?.total ?? viewModel.summary.taskCount;
  const completed = counts?.completed ?? viewModel.summary.completedTaskCount;
  const showProgressBar = total >= 2;
  const progressFraction = total > 0 ? Math.min(1, completed / total) : 0;
  const isComplete = total > 0 && completed === total;

  const tasks = viewModel.displayTasks;
  const visibleTasks = isExpanded ? tasks.slice(0, expandedLimit) : [];
  const overflowCount = isExpanded ? Math.max(0, tasks.length - visibleTasks.length) : 0;

  return (
    <View style={s.container}>
      <View style={s.headerRow}>
        <Text style={s.label}>Plan</Text>
        {total > 0 ? <Text style={s.countText}>{completed}/{total}</Text> : null}
      </View>

      {showProgressBar ? (
        <View style={s.progressTrack}>
          <View
            style={[
              s.progressFill,
              {
                width: `${progressFraction * 100}%`,
                backgroundColor: isComplete ? colors.success : colors.accent,
              },
            ]}
          />
        </View>
      ) : null}

      {!isExpanded && viewModel.currentTask ? (
        <Text style={s.nowLine} numberOfLines={2}>
          <Text style={s.nowLabel}>Now </Text>
          {viewModel.currentTask.title}
        </Text>
      ) : null}

      {!isExpanded && viewModel.nextTask ? (
        <Text style={s.nextLine} numberOfLines={1}>
          Next: {viewModel.nextTask.title}
        </Text>
      ) : null}

      {isExpanded && visibleTasks.length > 0 ? (
        <Animated.View
          entering={reducedMotion ? undefined : FadeInDown.duration(160)}
          style={s.taskList}
        >
          {visibleTasks.map((task) => {
            const iconName = STATUS_ICON_NAME[task.status] ?? STATUS_ICON_NAME.pending;
            const statusLabel = STATUS_A11Y_LABEL[task.status] ?? task.status;
            return (
              <View
                key={task.id}
                style={s.taskRow}
                accessible
                accessibilityLabel={`${statusLabel}: ${task.title}`}
              >
                <View style={s.iconWrap}>
                  <Feather
                    name={iconName}
                    size={12}
                    color={resolveStatusColor(task.status, colors)}
                  />
                </View>
                <Text
                  style={[s.taskTitle, task.status === 'completed' && s.taskTitleCompleted]}
                >
                  {task.title}
                </Text>
              </View>
            );
          })}
          {overflowCount > 0 ? (
            <Text style={s.overflowText}>+{overflowCount} more</Text>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
});
