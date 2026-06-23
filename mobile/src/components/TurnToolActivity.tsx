import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import {
  buildCompletedActivityViewModel,
  type CompletedStep,
  type MissionContext,
  type SessionToolEvent,
  type SubAgentItem,
  type TaskProgressItem,
} from '@rebel/cloud-client';
import { formatPrimaryMcpAppFallbackAsPlainText } from '@shared/utils/mcpAppFallbackText';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { hapticLight } from '../utils/haptics';
import { MobileActivitySurface } from './activity/MobileActivitySurface';

const typography = createTypography(true);

type PrimaryMcpAppEvent = SessionToolEvent & {
  mcpAppUiMeta: NonNullable<SessionToolEvent['mcpAppUiMeta']> & {
    presentation: 'primary';
  };
};

interface Props {
  turnId: string;
  events?: SessionToolEvent[];
  fallbackSteps?: CompletedStep[];
  missionContext?: MissionContext | null;
  taskProgress?: TaskProgressItem[];
  subAgentItems?: SubAgentItem[];
  hasMissionSet?: boolean;
  touchedTaskIds?: string[];
  /** Owning session id used by `mapImageRef` to resolve cloud asset URLs. */
  owningSessionId?: string;
}

function createPrimaryStyles(colors: ColorTokens) {
  return StyleSheet.create({
    primaryCard: {
      width: '100%',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      padding: 12,
      gap: 8,
      backgroundColor: colors.accentLight,
    },
    primaryTitle: {
      ...typography.bodySmall,
      color: colors.textPrimary,
      fontSize: 14,
      lineHeight: 19,
      fontWeight: '700',
    },
    primarySummary: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 18,
    },
    primaryTagline: {
      ...typography.caption,
      color: colors.textTertiary,
      fontSize: 12,
      lineHeight: 16,
    },
    fallbackBlock: { gap: 5 },
    fallbackLine: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 17,
    },
    fallbackLabel: {
      color: colors.textPrimary,
      fontWeight: '700',
    },
    fallbackBody: {
      ...typography.caption,
      color: colors.textSecondary,
      fontSize: 12,
      lineHeight: 17,
      paddingTop: 2,
    },
    copyButton: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 10,
      paddingVertical: 6,
      backgroundColor: colors.surface,
    },
    copyButtonText: {
      ...typography.caption,
      color: colors.textPrimary,
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '600',
    },
  });
}

function formatAddressList(value: string[] | undefined): string {
  return value && value.length > 0 ? value.join(', ') : '—';
}

function buildCopyText(event: PrimaryMcpAppEvent): string {
  const formatted = formatPrimaryMcpAppFallbackAsPlainText(event.mcpAppUiMeta);
  return typeof formatted === 'string' ? formatted : event.mcpAppUiMeta.viewSummary ?? '';
}

async function writeTextToClipboard(text: string): Promise<void> {
  const clipboard = (globalThis as {
    navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> | void } };
  }).navigator?.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
  }
}

function PrimaryMcpAppPlaceholder({
  event,
  styles,
  colors,
}: {
  event: PrimaryMcpAppEvent;
  styles: ReturnType<typeof createPrimaryStyles>;
  colors: ColorTokens;
}) {
  const fallback = event.mcpAppUiMeta.structuredFallback;
  const copyLabel = fallback?.kind === 'email-draft' ? 'Copy draft' : 'Copy details';
  const handleCopy = useCallback(() => {
    hapticLight();
    void writeTextToClipboard(buildCopyText(event));
  }, [event]);

  return (
    <View testID="primary-mcp-app-placeholder" style={styles.primaryCard}>
      <Text style={styles.primaryTitle}>
        {event.mcpAppUiMeta.viewRoleLabel ?? 'Interactive view ready'}
      </Text>
      {event.mcpAppUiMeta.viewSummary ? (
        <Text style={styles.primarySummary}>{event.mcpAppUiMeta.viewSummary}</Text>
      ) : null}

      {fallback?.kind === 'email-draft' ? (
        <View style={styles.fallbackBlock}>
          <Text style={styles.fallbackLine}>
            <Text style={styles.fallbackLabel}>To: </Text>
            {formatAddressList(fallback.payload.to)}
          </Text>
          <Text style={styles.fallbackLine}>
            <Text style={styles.fallbackLabel}>Cc: </Text>
            {formatAddressList(fallback.payload.cc)}
          </Text>
          <Text style={styles.fallbackLine}>
            <Text style={styles.fallbackLabel}>Bcc: </Text>
            {formatAddressList(fallback.payload.bcc)}
          </Text>
          <Text style={styles.fallbackLine}>
            <Text style={styles.fallbackLabel}>Subject: </Text>
            {fallback.payload.subject}
          </Text>
          <Text style={styles.fallbackBody}>{fallback.payload.body}</Text>
        </View>
      ) : fallback?.kind === 'plain' ? (
        <Text style={styles.fallbackBody}>{fallback.payload.markdown}</Text>
      ) : fallback?.kind === 'calendar-pick' ? (
        <View style={styles.fallbackBlock}>
          {fallback.payload.title ? (
            <Text style={styles.fallbackLine}>{fallback.payload.title}</Text>
          ) : null}
          {fallback.payload.options.map((option, index) => (
            <Text key={`${option.id ?? option.label}-${index}`} style={styles.fallbackLine}>
              • {option.label}{option.start ? ` — ${option.start}` : ''}
            </Text>
          ))}
        </View>
      ) : fallback?.kind === 'document-outline' ? (
        <View style={styles.fallbackBlock}>
          {fallback.payload.title ? (
            <Text style={styles.fallbackLine}>{fallback.payload.title}</Text>
          ) : null}
          {fallback.payload.sections.map((section, index) => (
            <Text key={`${section.heading}-${index}`} style={styles.fallbackLine}>
              • {section.heading}
              {section.bullets && section.bullets.length > 0
                ? ` — ${section.bullets.join('; ')}`
                : ''}
            </Text>
          ))}
        </View>
      ) : null}

      <Text style={styles.primaryTagline}>
        {"You can read it here. Edit and send from your computer when you're ready."}
      </Text>

      {fallback ? (
        <TouchableOpacity
          style={styles.copyButton}
          activeOpacity={0.75}
          onPress={handleCopy}
          accessibilityRole="button"
        >
          <Feather name="copy" size={12} color={colors.textTertiary} />
          <Text style={styles.copyButtonText}>{copyLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export const TurnToolActivity = memo(function TurnToolActivity({
  turnId,
  events,
  fallbackSteps,
  missionContext,
  taskProgress,
  subAgentItems,
  hasMissionSet,
  touchedTaskIds,
  owningSessionId,
}: Props) {
  const colors = useColors();
  const primaryStyles = useMemo(() => createPrimaryStyles(colors), [colors]);

  const allPrimaryMcpAppEvents = useMemo<PrimaryMcpAppEvent[]>(() => {
    return (events ?? []).filter((event): event is PrimaryMcpAppEvent =>
      event.mcpAppUiMeta?.presentation === 'primary');
  }, [events]);

  const viewModel = useMemo(
    () => buildCompletedActivityViewModel({
      events,
      fallbackSteps,
      missionContext,
      taskProgress,
      subAgentItems,
      hasMissionSet,
      touchedTaskIds,
      owningSessionId,
    }),
    [
      events,
      fallbackSteps,
      missionContext,
      taskProgress,
      subAgentItems,
      hasMissionSet,
      touchedTaskIds,
      owningSessionId,
    ],
  );

  const hasAnyContent = viewModel.steps.length > 0
    || viewModel.summary.taskCount > 0
    || viewModel.assistants.length > 0
    || Boolean(viewModel.mission)
    || allPrimaryMcpAppEvents.length > 0;

  if (!hasAnyContent) return null;

  const preludeContent = allPrimaryMcpAppEvents.length > 0 ? (
    <View>
      {allPrimaryMcpAppEvents.map((event, index) => (
        <PrimaryMcpAppPlaceholder
          key={event.toolUseId ?? `${event.timestamp}-primary-${index}`}
          event={event}
          styles={primaryStyles}
          colors={colors}
        />
      ))}
    </View>
  ) : undefined;

  return (
    <MobileActivitySurface
      mode="completed"
      viewModel={viewModel}
      testID={`turn-tool-activity-${turnId}`}
      preludeContent={preludeContent}
    />
  );
});
