import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown, useReducedMotion } from 'react-native-reanimated';
import {
  deriveActivityHeader,
  type MobileActivityViewModel,
} from '@rebel/cloud-client';
import { useColors, type ColorTokens } from '../../theme/colors';
import { ActivityHeader } from './ActivityHeader';
import { ActivityGoalSection } from './ActivityGoalSection';
import { ActivityPlanSection } from './ActivityPlanSection';
import { ActivityAssistantsSection } from './ActivityAssistantsSection';
import { ActivityLogSection } from './ActivityLogSection';

export type MobileActivitySurfaceProps = {
  mode: 'active' | 'completed';
  viewModel: MobileActivityViewModel;
  initialExpanded?: boolean;
  testID?: string;
  /**
   * Optional content rendered above the activity sections (used for primary
   * MCP app placeholders rendered by the completed-turn caller). Kept here
   * so the caller can still own that path while the surface owns layout.
   */
  preludeContent?: React.ReactNode;
};

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { paddingHorizontal: 12, paddingVertical: 4, alignItems: 'flex-start' },
    bubble: {
      width: '92%',
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: colors.surface,
      gap: 10,
    },
    sectionsWrap: { gap: 10 },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginVertical: 2,
    },
  });
}

export const MobileActivitySurface = memo(function MobileActivitySurface({
  mode,
  viewModel,
  initialExpanded,
  testID,
  preludeContent,
}: MobileActivitySurfaceProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const reducedMotion = useReducedMotion();

  const defaultExpanded = initialExpanded ?? mode === 'active';
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const header = useMemo(() => deriveActivityHeader(viewModel), [viewModel]);

  const hasMission = Boolean(viewModel.mission);
  const hasPlan = viewModel.summary.taskCount > 0
    || Boolean(viewModel.currentTask)
    || Boolean(viewModel.snapshotCounts);
  const hasAssistants = viewModel.assistants.length > 0;
  const hasLog = viewModel.steps.length > 0;
  const canExpand = hasMission || hasPlan || hasAssistants || hasLog;

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  return (
    <View
      testID={testID ?? 'mobile-activity-surface'}
      style={s.container}
      accessibilityRole="summary"
      accessibilityLabel={header.headline}
    >
      <View style={s.bubble}>
        {preludeContent}
        <ActivityHeader
          state={header.state}
          headline={header.headline}
          subheadline={header.subheadline}
          elapsedLabel={header.elapsedLabel}
          progressLabel={header.progressLabel}
          isExpanded={isExpanded}
          canExpand={canExpand}
          onToggle={toggleExpanded}
        />
        {isExpanded && canExpand ? (
          <Animated.View
            entering={reducedMotion ? undefined : FadeInDown.duration(180)}
            exiting={reducedMotion ? undefined : FadeOutDown.duration(140)}
            style={s.sectionsWrap}
          >
            {hasMission && viewModel.mission ? (
              <>
                <View style={s.divider} />
                <ActivityGoalSection mission={viewModel.mission} />
              </>
            ) : null}
            {hasPlan ? (
              <>
                <View style={s.divider} />
                <ActivityPlanSection viewModel={viewModel} isExpanded />
              </>
            ) : null}
            {hasAssistants ? (
              <>
                <View style={s.divider} />
                <ActivityAssistantsSection assistants={viewModel.assistants} isExpanded />
              </>
            ) : null}
            {hasLog ? (
              <>
                <View style={s.divider} />
                <ActivityLogSection
                  steps={viewModel.steps}
                  owningSessionId={viewModel.owningSessionId}
                />
              </>
            ) : null}
          </Animated.View>
        ) : (
          <CollapsedPreview viewModel={viewModel} />
        )}
      </View>
    </View>
  );
});

const CollapsedPreview = memo(function CollapsedPreview({
  viewModel,
}: {
  viewModel: MobileActivityViewModel;
}) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  const hasPlan = viewModel.summary.taskCount > 0 || Boolean(viewModel.currentTask);
  const hasAssistants = viewModel.assistants.length > 0;

  if (!hasPlan && !hasAssistants) return null;

  return (
    <View style={s.sectionsWrap}>
      {hasPlan ? <ActivityPlanSection viewModel={viewModel} isExpanded={false} /> : null}
      {hasAssistants ? (
        <ActivityAssistantsSection assistants={viewModel.assistants} isExpanded={false} />
      ) : null}
    </View>
  );
});
