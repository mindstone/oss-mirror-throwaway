import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe, Play, Sparkles } from 'lucide-react';
import { useSettings } from '@renderer/features/settings';
import { tracking } from '@renderer/src/tracking';
import {
  TEXT_EMPTY_PROMPTS,
  VOICE_EMPTY_PROMPTS,
  getRandomItem,
} from '@shared/data/brandCopy';
import { useTutorialProgress } from '@renderer/features/tutorials/hooks/useTutorialProgress';
import { useTutorialsModalStore } from '@renderer/features/tutorials/store/tutorialsModalStore';
import {
  getContextualNextVideo,
  type ContextualVideoProfile,
} from '@renderer/features/tutorials/utils/contextualVideoSelection';
import {
  selectDiscoveryItem,
} from '@renderer/features/tutorials/utils/contextualDiscoverySelection';
import { useChangelogHighlights } from '@renderer/features/whats-new/hooks/useChangelogHighlights';
import type { ChangelogHighlight } from '@renderer/features/whats-new/utils/changelogParser';
import { useUserFeatureProfile } from '@renderer/features/whats-new/hooks/useUserFeatureProfile';
import { useCommunityVideoRec } from '@renderer/features/usecases/hooks/useCommunityVideoRec';
import type { PersonalizedUseCase } from '@shared/types';
import styles from './EmptyConversationState.module.css';

/** Maximum number of personalized use cases rendered as starter pills. */
const MAX_STARTERS = 3;

export interface EmptyConversationStateProps {
  /** True when the composer is in text mode, false for voice mode. */
  isTextMode: boolean;
  /** Called when the user clicks a conversation starter pill. */
  onSubmitPrompt: (prompt: string) => void;
  /** Current session id — used to reset per-session click-disable state. */
  currentSessionId: string;
  /**
   * Called when the user clicks a changelog-highlight discovery whisper.
   * Starts a fresh "What's New" session for the selected feature.
   * If not wired, changelog highlights are suppressed from the whisper slot.
   */
  onTryChangelog?: (highlight: ChangelogHighlight) => void;
}

/**
 * Delightful empty conversation state — three layers:
 *   1. Time-agnostic greeting (rotating prompt, stable per mount). Renders
 *      synchronously so there's always something to look at.
 *   2. Tutorial whisper — a contextual video suggestion for a feature the
 *      user hasn't discovered yet. Async-gated on settings + MCP profile.
 *   3. Conversation starters — up to 3 personalized use cases surfaced as
 *      clickable pills. Click routes through the existing message queue via
 *      the `onSubmitPrompt` prop.
 *
 * See `docs/plans/260418_empty_state_contextual_targeting_tip_styling.md`
 * for the full plan and decision rationale.
 */
function EmptyConversationStateComponent({
  isTextMode,
  onSubmitPrompt,
  currentSessionId,
  onTryChangelog,
}: EmptyConversationStateProps) {
  const { settings, saveSettingsWith } = useSettings();
  const { watchedVideos } = useTutorialProgress();
  const featureProfile = useUserFeatureProfile(true);
  const { highlights: changelogHighlights, loading: changelogLoading } = useChangelogHighlights();
  const { video: communityVideo, loading: communityVideoLoading } = useCommunityVideoRec();

  // Layer 1 — stable-per-mount greeting. Renders synchronously.
  const [greeting] = useState(() => ({
    text: getRandomItem(TEXT_EMPTY_PROMPTS),
    voice: getRandomItem(VOICE_EMPTY_PROMPTS),
  }));
  const greetingText = isTextMode ? greeting.text : greeting.voice;

  // One-click disable keyed by sessionId — prevents double-submit if the user
  // clicks a starter twice in quick succession. Resets on session change.
  const [clickedStarterForSession, setClickedStarterForSession] = useState<
    string | null
  >(null);
  useEffect(() => {
    setClickedStarterForSession(null);
  }, [currentSessionId]);

  const starterDisabled = clickedStarterForSession === currentSessionId;

  // Fire the shown analytics once per mount.
  const shownTrackedRef = useRef(false);
  useEffect(() => {
    if (shownTrackedRef.current) return;
    shownTrackedRef.current = true;
    tracking.emptyState.shown();
  }, []);

  // ── Layer 2: Tutorial whisper ──────────────────────────────────────
  // Narrow the feature-profile shape down to the ContextualVideoProfile the
  // pure selection function consumes. `loading` forces catalog-order fallback
  // while the MCP lookup is in flight (see contextualVideoSelection.ts).
  const videoProfile = useMemo<ContextualVideoProfile>(
    () => ({
      voiceConfigured: featureProfile.features.voiceConfigured,
      hasConnections: featureProfile.mcp.hasConnections,
      hasAutomations: featureProfile.features.hasAutomations,
      hasSpaces: featureProfile.features.hasSpaces,
      meetingBotConfigured: featureProfile.features.meetingBotConfigured,
      privacyModeUsed: featureProfile.features.privacyModeUsed,
      loading: featureProfile.loading,
    }),
    [
      featureProfile.features.voiceConfigured,
      featureProfile.features.hasAutomations,
      featureProfile.features.hasSpaces,
      featureProfile.features.meetingBotConfigured,
      featureProfile.features.privacyModeUsed,
      featureProfile.mcp.hasConnections,
      featureProfile.loading,
    ],
  );

  // Only compute the contextual pick once settings AND the feature profile
  // are ready. Gating on both prevents the whisper from briefly showing a
  // catalog-order video that swaps to a contextual one when MCP resolves.
  const settingsLoaded = settings != null;
  const profileReady = settingsLoaded && !featureProfile.loading;
  const nextVideo = useMemo(
    () =>
      profileReady
        ? getContextualNextVideo(videoProfile, watchedVideos)
        : null,
    [profileReady, videoProfile, watchedVideos],
  );

  // Unified discovery item selection — picks either the tutorial candidate
  // above or the best changelog highlight, alternating per-session so neither
  // content type dominates. If `onTryChangelog` is not wired, changelog
  // candidates are suppressed to avoid rendering a dead whisper.
  //
  // Gate on both profileReady AND !changelogLoading so the choice is made
  // once all data has settled — prevents the item from flipping mid-render
  // if changelog data arrives after the profile.
  const changelogCandidate = onTryChangelog ? changelogHighlights[0] ?? null : null;
  const dataReady = profileReady && !changelogLoading;
  const discoveryItem = useMemo(
    () =>
      dataReady
        ? selectDiscoveryItem({
            sessionId: currentSessionId,
            surface: 'empty-state',
            tutorialCandidate: nextVideo,
            changelogCandidate,
          })
        : null,
    [dataReady, currentSessionId, nextVideo, changelogCandidate],
  );

  // Community video third-tier fallback — shown only when both tutorial and
  // changelog discovery items are exhausted. Component-level fallback keeps
  // the shared selectDiscoveryItem function focused on alternation.
  const communityVideoFallback = !discoveryItem && !communityVideoLoading ? communityVideo : null;

  // Fire whisper-shown analytics once per unique item surfaced.
  // For tutorials, we ALSO preserve the existing
  // `tracking.tutorials.emptyStateWhisperShown` event to avoid regressing
  // historical dashboards. Discovery events are additive.
  const trackedWhisperKeyRef = useRef<string | null>(null);
  useEffect(() => {
    let key: string;
    if (discoveryItem?.type === 'tutorial') {
      key = `tutorial:${discoveryItem.video.id}`;
    } else if (discoveryItem?.type === 'changelog') {
      key = `changelog:${discoveryItem.highlight.title}`;
    } else if (communityVideoFallback) {
      key = `community-video:${communityVideoFallback.id}`;
    } else {
      return;
    }
    if (trackedWhisperKeyRef.current === key) return;
    trackedWhisperKeyRef.current = key;
    if (discoveryItem?.type === 'tutorial') {
      tracking.tutorials.emptyStateWhisperShown(
        discoveryItem.video.id,
        discoveryItem.video.title,
      );
      tracking.discovery.whisperShown(
        'tutorial',
        discoveryItem.video.id,
        discoveryItem.video.title,
      );
    } else if (discoveryItem?.type === 'changelog') {
      tracking.discovery.whisperShown(
        'changelog',
        discoveryItem.highlight.title,
        discoveryItem.highlight.title,
      );
    } else if (communityVideoFallback) {
      tracking.discovery.whisperShown(
        'community-video',
        communityVideoFallback.id,
        communityVideoFallback.headline,
      );
    }
  }, [discoveryItem, communityVideoFallback]);

  const handleWhisperClick = useCallback(() => {
    if (!discoveryItem) return;
    if (discoveryItem.type === 'tutorial') {
      const { video } = discoveryItem;
      tracking.tutorials.emptyStateWhisperClicked(video.id, video.title);
      tracking.tutorials.modalOpened('empty_state_whisper');
      tracking.discovery.whisperClicked('tutorial', video.id, video.title);
      useTutorialsModalStore.getState().open(video);
      return;
    }
    // Changelog variant
    const { highlight } = discoveryItem;
    tracking.discovery.whisperClicked('changelog', highlight.title, highlight.title);

    // Mark as dismissed so the same highlight doesn't reappear.
    const normalizedAppVersion = window.electronEnv?.appVersion?.replace(/^v/, '');
    if (normalizedAppVersion) {
      void saveSettingsWith((draft) => {
        const current = draft.dismissedWhatsNewHighlights ?? {};
        const versionDismissed = current[normalizedAppVersion] ?? [];
        if (!versionDismissed.includes(highlight.title)) {
          return {
            ...draft,
            dismissedWhatsNewHighlights: {
              ...current,
              [normalizedAppVersion]: [...versionDismissed, highlight.title],
            },
          };
        }
        return draft;
      });
    }

    onTryChangelog?.(highlight);
  }, [discoveryItem, onTryChangelog, saveSettingsWith]);

  const handleCommunityVideoClick = useCallback(() => {
    if (!communityVideoFallback) return;
    const clickUrl = communityVideoFallback.eventUrl || communityVideoFallback.url;
    try {
      if (new URL(clickUrl).protocol !== 'https:') return;
    } catch { return; }
    tracking.discovery.whisperClicked(
      'community-video',
      communityVideoFallback.id,
      communityVideoFallback.headline,
    );
    window.appApi.openUrl(clickUrl);
  }, [communityVideoFallback]);

  // ── Layer 3: Conversation starters ─────────────────────────────────
  const starters: PersonalizedUseCase[] = useMemo(
    () => (settings?.personalizedUseCases ?? []).slice(0, MAX_STARTERS),
    [settings?.personalizedUseCases],
  );

  const handleStarterClick = useCallback(
    (useCase: PersonalizedUseCase) => {
      if (starterDisabled) return;
      setClickedStarterForSession(currentSessionId);
      tracking.emptyState.starterClicked(useCase.id, useCase.title);
      onSubmitPrompt(useCase.prompt);
    },
    [currentSessionId, onSubmitPrompt, starterDisabled],
  );

  return (
    <div className={styles.container} data-testid="empty-conversation-state">
      <p className={styles.greeting}>{greetingText}</p>

      {discoveryItem?.type === 'tutorial' && (
        <button
          type="button"
          className={styles.whisper}
          onClick={handleWhisperClick}
          aria-label={`Watch tutorial: ${discoveryItem.video.title}`}
          data-testid="empty-state-whisper"
          data-discovery-type="tutorial"
        >
          <span className={styles.whisperIcon} aria-hidden>
            <Play
              size={12}
              className={styles.whisperIconGlyph}
              aria-hidden
            />
          </span>
          <span className={styles.whisperQuip}>&quot;{discoveryItem.video.quip}&quot;</span>
          <span className={styles.whisperDuration}>· {discoveryItem.video.duration}</span>
        </button>
      )}

      {discoveryItem?.type === 'changelog' && (
        <button
          type="button"
          className={styles.whisper}
          onClick={handleWhisperClick}
          aria-label={`Try new feature: ${discoveryItem.highlight.title}`}
          data-testid="empty-state-whisper"
          data-discovery-type="changelog"
        >
          <span className={styles.whisperIcon} aria-hidden>
            <Sparkles size={12} aria-hidden />
          </span>
          <span
            className={styles.whisperTitleText}
            title={discoveryItem.highlight.title}
          >
            {discoveryItem.highlight.title}
          </span>
          <span className={styles.whisperDuration}>· Try it</span>
        </button>
      )}

      {communityVideoFallback && !discoveryItem && (
        <button
          type="button"
          className={styles.whisper}
          onClick={handleCommunityVideoClick}
          aria-label={`Watch talk: ${communityVideoFallback.headline}`}
          data-testid="empty-state-whisper"
          data-discovery-type="community-video"
        >
          <span className={styles.whisperIcon} aria-hidden>
            <Globe size={12} aria-hidden />
          </span>
          <span
            className={styles.whisperTitleText}
            title={communityVideoFallback.headline}
          >
            {[communityVideoFallback.speakerName, communityVideoFallback.eventCity].filter(Boolean).join(' · ')}
          </span>
          <span className={styles.whisperDuration}>· Watch talk</span>
        </button>
      )}

      {starters.length > 0 && (
        <div
          className={styles.starters}
          data-testid="empty-state-starters"
        >
          {starters.map((useCase) => (
            <button
              key={useCase.id}
              type="button"
              className={styles.starter}
              onClick={() => handleStarterClick(useCase)}
              disabled={starterDisabled}
              aria-label={`Start: ${useCase.title}`}
              data-testid={`empty-state-starter-${useCase.id}`}
            >
              {useCase.icon && (
                <span className={styles.starterIcon} aria-hidden>
                  {useCase.icon}
                </span>
              )}
              <span className={styles.starterTitle}>{useCase.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const EmptyConversationState = memo(EmptyConversationStateComponent);
EmptyConversationState.displayName = 'EmptyConversationState';
