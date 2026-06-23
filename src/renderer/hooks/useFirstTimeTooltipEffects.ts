/**
 * useFirstTimeTooltipEffects — orchestrates all first-time tooltip triggers.
 *
 * Extracted from App.tsx per architectural guidelines: feature-specific logic
 * belongs in dedicated hooks, not in the orchestration file.
 *
 * Each tooltip fires exactly once per user via `useFirstTimeTooltip` persistence.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFirstTimeTooltip } from './useFirstTimeTooltip';
import type { AppSettings, AgentEvent } from '@shared/types';
import type { FlowSurface } from '@renderer/features/flow-panels/FlowPanelsProvider';

type SaveSettingsWith = (
  updater?: (draft: AppSettings) => AppSettings,
  options?: { keepOpen?: boolean }
) => Promise<void>;

interface UseFirstTimeTooltipEffectsOptions {
  settings: AppSettings | null;
  saveSettingsWith: SaveSettingsWith;
  showToast: (opts: {
    title: string;
    description?: string;
    duration?: number;
    action?: { label: string; onClick: () => void };
  }) => void;
  openSettingsDialog: (tab: string) => void;
  setActiveSurface: (surface: FlowSurface) => void;

  // Trigger data sources
  memoryUpdateStatusByTurn: Record<string, { status: string; entityUpdates?: unknown[] }>;
  pendingApprovalCount: number;
  deniedOperationsCount: number;
  stagedToolCallsCount: number;
  memoryApprovalRequestsCount: number;
  eventsByTurn: Record<string, AgentEvent[]>;
  hasCompletedRuns: boolean;
  settingsOpen: boolean;
  settingsActiveTab: string | undefined;
}

interface UseFirstTimeTooltipEffectsResult {
  showMentionTooltip: () => void;
}

export function useFirstTimeTooltipEffects({
  settings,
  saveSettingsWith,
  showToast,
  openSettingsDialog,
  setActiveSurface,
  memoryUpdateStatusByTurn,
  pendingApprovalCount,
  deniedOperationsCount,
  stagedToolCallsCount,
  memoryApprovalRequestsCount,
  eventsByTurn,
  hasCompletedRuns,
  settingsOpen,
  settingsActiveTab,
}: UseFirstTimeTooltipEffectsOptions): UseFirstTimeTooltipEffectsResult {
  const tooltipHookOptions = useMemo(
    () => ({ settings, saveSettingsWith }),
    [saveSettingsWith, settings]
  );

  const { shouldShow: shouldShowMemoryTooltip, markShown: markMemoryTooltipShown } =
    useFirstTimeTooltip('memoryFirstSave', tooltipHookOptions);
  const { shouldShow: shouldShowPermissionTooltip, markShown: markPermissionTooltipShown } =
    useFirstTimeTooltip('permissionFirstPrompt', tooltipHookOptions);
  const { shouldShow: shouldShowSkillTooltip, markShown: markSkillTooltipShown } =
    useFirstTimeTooltip('skillFirstUse', tooltipHookOptions);
  const { shouldShow: shouldShowMentionTooltip, markShown: markMentionTooltipShown } =
    useFirstTimeTooltip('mentionFirstUse', tooltipHookOptions);
  const { shouldShow: shouldShowAutomationTooltip, markShown: markAutomationTooltipShown } =
    useFirstTimeTooltip('automationFirstRun', tooltipHookOptions);
  const { shouldShow: shouldShowSpacesTooltip, markShown: markSpacesTooltipShown } =
    useFirstTimeTooltip('spacesFirstUse', tooltipHookOptions);

  // --- Memory tooltip ---
  useEffect(() => {
    if (!shouldShowMemoryTooltip) return;
    const hasSuccessfulMemorySave = Object.values(memoryUpdateStatusByTurn).some(
      (status) => status.status === 'success' && (status.entityUpdates?.length ?? 0) > 0
    );
    if (!hasSuccessfulMemorySave) return;
    showToast({
      title: 'I just saved some context',
      description: "Memory is useful context from your chats. I save it in the most relevant space with the right privacy level (private or shared), and you can adjust this in Settings > Safety.",
      duration: 8000,
      action: {
        label: 'Open Safety',
        onClick: () => openSettingsDialog('safety'),
      },
    });
    markMemoryTooltipShown();
  }, [
    markMemoryTooltipShown,
    memoryUpdateStatusByTurn,
    openSettingsDialog,
    shouldShowMemoryTooltip,
    showToast,
  ]);

  // --- Permission tooltip ---
  useEffect(() => {
    if (!shouldShowPermissionTooltip) return;
    const hasApprovalPrompt =
      pendingApprovalCount > 0 ||
      deniedOperationsCount > 0 ||
      stagedToolCallsCount > 0 ||
      memoryApprovalRequestsCount > 0;
    if (!hasApprovalPrompt) return;
    showToast({
      title: "You're in control",
      description: 'Permissions are safety checks before sensitive actions. I pause so you can review what will happen, and you can tune this in Settings > Safety.',
      duration: 8000,
      action: {
        label: 'Open Safety',
        onClick: () => openSettingsDialog('safety'),
      },
    });
    markPermissionTooltipShown();
  }, [
    deniedOperationsCount,
    markPermissionTooltipShown,
    memoryApprovalRequestsCount,
    openSettingsDialog,
    pendingApprovalCount,
    shouldShowPermissionTooltip,
    showToast,
    stagedToolCallsCount,
  ]);

  // --- Skill tooltip ---
  const processedTooltipToolEventsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!shouldShowSkillTooltip) return;

    for (const [turnId, turnEvents] of Object.entries(eventsByTurn)) {
      for (let index = 0; index < turnEvents.length; index += 1) {
        const event = turnEvents[index];
        if (event.type !== 'tool' || event.stage !== 'end') continue;
        const detailText = typeof event.detail === 'string' ? event.detail : '';
        const eventKey = `${turnId}:${index}:${event.timestamp}:${event.toolName}`;
        if (processedTooltipToolEventsRef.current.has(eventKey)) continue;
        processedTooltipToolEventsRef.current.add(eventKey);

        if (
          shouldShowSkillTooltip &&
          /(^|[\\/])skills([\\/]|$)|skill\.md/i.test(detailText)
        ) {
          showToast({
            title: "That's a skill in action",
            description: 'A skill is a reusable workflow: a saved set of steps for repeat tasks. You can use personal, team, or company skills from the Library.',
            duration: 8000,
            action: {
              label: 'Open Library',
              onClick: () => setActiveSurface('library'),
            },
          });
          markSkillTooltipShown();
          processedTooltipToolEventsRef.current.clear();
          return;
        }
      }
    }
  }, [
    eventsByTurn,
    markSkillTooltipShown,
    setActiveSurface,
    shouldShowSkillTooltip,
    showToast,
  ]);

  // --- Automation tooltip ---
  useEffect(() => {
    if (!shouldShowAutomationTooltip || !hasCompletedRuns) return;
    showToast({
      title: 'Your first automation ran',
      description: 'Automations are scheduled tasks that run in the background. Review results in Home, manage schedules in Automations, and tune approval strictness in Safety settings.',
      duration: 6000,
      action: {
        label: 'Open Automations',
        onClick: () => setActiveSurface('automations'),
      },
    });
    markAutomationTooltipShown();
  }, [
    hasCompletedRuns,
    markAutomationTooltipShown,
    setActiveSurface,
    shouldShowAutomationTooltip,
    showToast,
  ]);

  // --- Spaces tooltip ---
  useEffect(() => {
    if (!shouldShowSpacesTooltip) return;
    if (!settingsOpen || settingsActiveTab !== 'spaces') return;
    // Brief delay guards against rapid tab switching triggering the toast unexpectedly
    const timer = setTimeout(() => {
      showToast({
        title: 'Spaces keep work organised',
        description: 'Spaces are separate contexts for personal, team, or project work. They keep memory, skills, and files organised so Rebel uses the right context.',
        duration: 7000,
        action: {
          label: 'Open Spaces',
          onClick: () => openSettingsDialog('spaces'),
        },
      });
      markSpacesTooltipShown();
    }, 500);
    return () => clearTimeout(timer);
  }, [
    markSpacesTooltipShown,
    openSettingsDialog,
    settingsActiveTab,
    settingsOpen,
    shouldShowSpacesTooltip,
    showToast,
  ]);

  // --- Mention tooltip (returned as callback for Composer) ---
  const showMentionTooltip = useCallback(() => {
    if (!shouldShowMentionTooltip) return;
    showToast({
      title: 'Reference anything with @',
      description: 'You can chat normally without mentions. Use @ when you want me to use a specific file, skill, or past conversation.',
      duration: 6000,
    });
    markMentionTooltipShown();
  }, [markMentionTooltipShown, shouldShowMentionTooltip, showToast]);

  return { showMentionTooltip };
}
