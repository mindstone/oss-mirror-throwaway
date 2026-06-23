import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import type { TaskProgressItem, SnapshotCounts } from '@rebel/cloud-client';

const typography = createTypography(true);

const DEFAULT_MAX_VISIBLE = 8;

type TaskStatus = TaskProgressItem['status'];

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { gap: 4 },
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginBottom: 2,
    },
    countText: {
      ...typography.caption,
      fontSize: 11,
      lineHeight: 14,
      color: colors.textTertiary,
    },
    progressTrack: {
      height: 3,
      borderRadius: 1.5,
      backgroundColor: colors.border,
      marginBottom: 4,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      borderRadius: 1.5,
      backgroundColor: colors.success,
    },
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
      fontSize: 13,
      lineHeight: 18,
      color: colors.textSecondary,
      flex: 1,
    },
    taskTitleCompleted: {
      textDecorationLine: 'line-through',
      color: colors.textTertiary,
    },
    overflowText: {
      ...typography.caption,
      fontSize: 12,
      lineHeight: 16,
      color: colors.textTertiary,
      fontStyle: 'italic',
      marginTop: 2,
    },
  });
}

const STATUS_A11Y_LABEL: Record<TaskStatus, string> = {
  pending: 'Ready',
  in_progress: 'Working',
  completed: 'Done',
  blocked: 'Waiting',
};

const STATUS_ICON: Record<TaskStatus, { name: React.ComponentProps<typeof Feather>['name']; colorKey: keyof ColorTokens }> = {
  pending: { name: 'circle', colorKey: 'textTertiary' },
  in_progress: { name: 'loader', colorKey: 'warning' },
  completed: { name: 'check-circle', colorKey: 'success' },
  blocked: { name: 'clock', colorKey: 'textTertiary' },
};

type Props = {
  tasks: TaskProgressItem[];
  maxVisible?: number;
  snapshotCounts?: SnapshotCounts;
};

export const TaskChecklist = memo(function TaskChecklist({ tasks, maxVisible = DEFAULT_MAX_VISIBLE, snapshotCounts }: Props) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  // When snapshotCounts is provided, use it for progress bar (cumulative snapshot).
  // Otherwise compute from the displayed tasks (backward compat).
  const completedCount = snapshotCounts ? snapshotCounts.completed : tasks.filter((t) => t.status === 'completed').length;
  const totalCount = snapshotCounts ? snapshotCounts.total : tasks.length;
  const showProgress = totalCount >= 2;
  const progressFraction = totalCount > 0 ? completedCount / totalCount : 0;

  const visibleTasks = useMemo(() => {
    if (tasks.length <= maxVisible) return tasks;

    // When snapshotCounts is provided, tasks are pre-filtered by the caller
    // (delta or active subset) — preserve caller's ordering, just apply limit.
    if (snapshotCounts) return tasks.slice(0, maxVisible);

    const inProgress = tasks.filter((t) => t.status === 'in_progress');
    const pending = tasks.filter((t) => t.status === 'pending');
    const rest = tasks.filter((t) => t.status !== 'in_progress' && t.status !== 'pending');
    return [...inProgress, ...pending, ...rest].slice(0, maxVisible);
  }, [tasks, maxVisible, snapshotCounts]);

  const overflowCount = Math.max(0, tasks.length - visibleTasks.length);

  return (
    <Animated.View entering={FadeInDown.duration(180)} style={s.container}>
      {showProgress && (
        <>
          <View style={s.headerRow}>
            <Text style={s.countText}>{completedCount}/{totalCount}</Text>
          </View>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${progressFraction * 100}%` }]} />
          </View>
        </>
      )}
      {visibleTasks.map((task) => {
        const icon = STATUS_ICON[task.status] ?? STATUS_ICON.pending;
        const statusLabel = STATUS_A11Y_LABEL[task.status] ?? task.status;
        return (
          <View key={task.id} style={s.taskRow} accessible accessibilityLabel={`${statusLabel}: ${task.title}`}>
            <View style={s.iconWrap}>
              <Feather name={icon.name} size={12} color={String(colors[icon.colorKey])} accessibilityElementsHidden />
            </View>
            <Text style={[s.taskTitle, task.status === 'completed' && s.taskTitleCompleted]} importantForAccessibility="no">
              {task.title}
            </Text>
          </View>
        );
      })}
      {overflowCount > 0 ? (
        <Text style={s.overflowText}>+{overflowCount} more</Text>
      ) : null}
    </Animated.View>
  );
});
