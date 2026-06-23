import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Globe, Play, Sparkles, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useSettings } from '@renderer/features/settings';
import { tracking } from '@renderer/src/tracking';
import { useTutorialProgress } from '../hooks/useTutorialProgress';
import { useTutorialsModalStore } from '../store/tutorialsModalStore';
import {
  selectDiscoveryItem,
  type DiscoveryItem,
} from '../utils/contextualDiscoverySelection';
import { useChangelogHighlights } from '@renderer/features/whats-new/hooks/useChangelogHighlights';
import { useCommunityVideoRec } from '@renderer/features/usecases/hooks/useCommunityVideoRec';
import type { ChangelogHighlight } from '@renderer/features/whats-new/utils/changelogParser';
import type { TutorialVideo } from '@shared/config/tutorialVideos';
import type { VideoRecommendation } from '@core/services/communityVideoRecsTypes';
import styles from './TutorialNudge.module.css';

type ActiveDiscoveryItem =
  | { kind: 'community-video'; video: VideoRecommendation }
  | { kind: 'tutorial'; video: TutorialVideo }
  | { kind: 'changelog'; highlight: ChangelogHighlight };

const REVEAL_DELAY_MS = 500;
// Session throttle: tracks which sessions have shown a nudge. Once a session ID
// is in this Set, the nudge won't reappear for that session even across remounts.
// Grows unboundedly but entries are small strings; acceptable for renderer lifetime.
const shownSessionIds = new Set<string>();

export interface TutorialNudgeProps {
  isThinking: boolean;
  sessionId: string;
  /**
   * Called when the user clicks a changelog-highlight discovery nudge.
   * Starts a fresh "What's New" session for the selected feature.
   * If not wired, changelog highlights are suppressed from the nudge so the
   * component never renders a dead button.
   */
  onTryChangelog?: (highlight: ChangelogHighlight) => void;
}

/**
 * Visibility arguments for `shouldShowTutorialNudge`. Named after the original
 * "tutorial nudge" concept but now covers the unified discovery slot (tutorial
 * OR changelog highlight). The `hasVideo` field name is preserved for
 * backwards-compatible test helper usage — it now indicates "any discovery
 * item is available", not specifically a tutorial video.
 */
export interface TutorialNudgeVisibilityArgs {
  isThinking: boolean;
  settingsLoading: boolean;
  /** True when any discovery item (tutorial OR changelog) is available. */
  hasVideo: boolean;
  canShowForSession: boolean;
  dismissedThisSession: boolean;
  revealReady: boolean;
}

export function shouldShowTutorialNudge({
  isThinking,
  settingsLoading,
  hasVideo,
  canShowForSession,
  dismissedThisSession,
  revealReady,
}: TutorialNudgeVisibilityArgs): boolean {
  return (
    isThinking &&
    revealReady &&
    !settingsLoading &&
    hasVideo &&
    canShowForSession &&
    !dismissedThisSession
  );
}

export const TutorialNudge = memo(({ isThinking, sessionId, onTryChangelog }: TutorialNudgeProps) => {
  const { settings, saveSettingsWith } = useSettings();
  const { getNextUnwatched } = useTutorialProgress();
  const nextVideo = getNextUnwatched();
  const { highlights: changelogHighlights, loading: changelogLoading } = useChangelogHighlights();
  const { video: communityVideo, loading: communityVideoLoading } = useCommunityVideoRec();

  // Suppress changelog when no click handler is wired — we never want to show
  // a dead button. Tutorial-only behaviour is the safe degraded state.
  //
  // Gate on !changelogLoading so the choice is made once all data has settled
  // — prevents the item from flipping mid-render if changelog data arrives
  // after the tutorial candidate is already computed.
  const changelogCandidate = onTryChangelog && !changelogLoading
    ? changelogHighlights[0] ?? null
    : null;

  const discoveryItem: DiscoveryItem | null = useMemo(
    () => changelogLoading
      ? (nextVideo ? { type: 'tutorial' as const, video: nextVideo } : null)
      : selectDiscoveryItem({
          sessionId,
          surface: 'nudge',
          tutorialCandidate: nextVideo ?? null,
          changelogCandidate,
        }),
    [sessionId, nextVideo, changelogCandidate, changelogLoading],
  );

  // Community video third-tier fallback — only when both tutorial and changelog
  // are exhausted. Keep this at the component level (not in selectDiscoveryItem)
  // because community videos don't participate in the per-session alternation.
  const communityVideoFallback = !discoveryItem && !communityVideoLoading ? communityVideo : null;

  // Single discriminated view-model for the active item. Computed once so
  // both the analytics effect and the JSX branch off the same value, and so
  // TypeScript narrows naturally without non-null assertions throughout.
  const activeItem = useMemo<ActiveDiscoveryItem | null>(() => {
    if (communityVideoFallback && !discoveryItem) {
      return { kind: 'community-video', video: communityVideoFallback };
    }
    if (discoveryItem?.type === 'tutorial') {
      return { kind: 'tutorial', video: discoveryItem.video };
    }
    if (discoveryItem?.type === 'changelog') {
      return { kind: 'changelog', highlight: discoveryItem.highlight };
    }
    return null;
  }, [discoveryItem, communityVideoFallback]);

  const [canShowForSession, setCanShowForSession] = useState(() => !shownSessionIds.has(sessionId));
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const [revealReady, setRevealReady] = useState(false);

  const settingsLoading = settings == null;

  useEffect(() => {
    setCanShowForSession(!shownSessionIds.has(sessionId));
    setDismissedThisSession(false);
    setRevealReady(false);
  }, [sessionId]);

  useEffect(() => {
    if (!isThinking) {
      setRevealReady(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setRevealReady(true);
    }, REVEAL_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isThinking, sessionId]);

  const shouldRenderNudge = shouldShowTutorialNudge({
    isThinking,
    revealReady,
    settingsLoading,
    hasVideo: activeItem !== null,
    canShowForSession,
    dismissedThisSession,
  });

  // Session throttle + analytics: mark session as shown and fire tracking once.
  // Keep existing tutorial-specific analytics alongside the new discovery
  // events to avoid regressing historical dashboards.
  const trackedItemKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!shouldRenderNudge || !activeItem) return;
    shownSessionIds.add(sessionId);
    const key = activeItem.kind === 'community-video'
      ? `community-video:${activeItem.video.id}`
      : activeItem.kind === 'tutorial'
        ? `tutorial:${activeItem.video.id}`
        : `changelog:${activeItem.highlight.title}`;
    if (trackedItemKeyRef.current !== key) {
      trackedItemKeyRef.current = key;
      switch (activeItem.kind) {
        case 'community-video':
          tracking.discovery.nudgeShown(
            'community-video',
            activeItem.video.id,
            activeItem.video.headline,
          );
          break;
        case 'tutorial':
          tracking.tutorials.nudgeShown(activeItem.video.id, activeItem.video.title);
          tracking.discovery.nudgeShown(
            'tutorial',
            activeItem.video.id,
            activeItem.video.title,
          );
          break;
        case 'changelog':
          tracking.discovery.nudgeShown(
            'changelog',
            activeItem.highlight.title,
            activeItem.highlight.title,
          );
          break;
      }
    }
  }, [sessionId, shouldRenderNudge, activeItem]);

  // If this component stays mounted across turns, block repeat display in same session.
  useEffect(() => {
    if (isThinking) return;
    if (!shownSessionIds.has(sessionId)) return;
    setCanShowForSession(false);
  }, [isThinking, sessionId]);

  const handleCommunityVideoClick = useCallback(() => {
    if (!communityVideoFallback) return;
    const clickUrl = communityVideoFallback.eventUrl || communityVideoFallback.url;
    try {
      if (new URL(clickUrl).protocol !== 'https:') return;
    } catch { return; }
    tracking.discovery.nudgeClicked(
      'community-video',
      communityVideoFallback.id,
      communityVideoFallback.headline,
    );
    window.appApi.openUrl(clickUrl);
    shownSessionIds.add(sessionId);
    setCanShowForSession(false);
  }, [communityVideoFallback, sessionId]);

  const handleOpenDiscoveryItem = () => {
    if (!activeItem) return;
    switch (activeItem.kind) {
      case 'community-video':
        handleCommunityVideoClick();
        return;
      case 'tutorial': {
        const { video } = activeItem;
        tracking.tutorials.nudgeClicked(video.id, video.title);
        tracking.discovery.nudgeClicked('tutorial', video.id, video.title);
        useTutorialsModalStore.getState().open(video);
        break;
      }
      case 'changelog': {
        const { highlight } = activeItem;
        tracking.discovery.nudgeClicked('changelog', highlight.title, highlight.title);

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
        break;
      }
    }
    shownSessionIds.add(sessionId);
    setCanShowForSession(false);
  };

  const handleDismiss = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (activeItem) {
      switch (activeItem.kind) {
        case 'community-video':
          tracking.discovery.nudgeDismissed(
            'community-video',
            activeItem.video.id,
            activeItem.video.headline,
          );
          break;
        case 'tutorial':
          tracking.tutorials.nudgeDismissed(activeItem.video.id, activeItem.video.title);
          tracking.discovery.nudgeDismissed(
            'tutorial',
            activeItem.video.id,
            activeItem.video.title,
          );
          break;
        case 'changelog':
          tracking.discovery.nudgeDismissed(
            'changelog',
            activeItem.highlight.title,
            activeItem.highlight.title,
          );
          break;
      }
    }
    shownSessionIds.add(sessionId);
    setDismissedThisSession(true);
    setCanShowForSession(false);
  };

  if (!shouldRenderNudge || !activeItem) {
    return null;
  }

  const ariaLabel =
    activeItem.kind === 'community-video'
      ? `Watch talk: ${activeItem.video.headline}`
      : activeItem.kind === 'tutorial'
        ? `Open tutorial: ${activeItem.video.title}`
        : `Try new feature: ${activeItem.highlight.title}`;
  const dismissLabel =
    activeItem.kind === 'community-video'
      ? 'Dismiss video suggestion'
      : activeItem.kind === 'tutorial'
        ? 'Dismiss tutorial suggestion'
        : 'Dismiss feature suggestion';

  return (
    <div className={styles.nudge} data-testid="tutorial-nudge">
      <button
        type="button"
        className={styles.playArea}
        onClick={handleOpenDiscoveryItem}
        data-testid="tutorial-nudge-play"
        data-discovery-type={activeItem.kind}
        aria-label={ariaLabel}
      >
        <span
          className={cn(
            styles.playIcon,
            (activeItem.kind === 'changelog' || activeItem.kind === 'community-video') && styles.sparklesIcon,
          )}
          aria-hidden
        >
          {activeItem.kind === 'community-video' ? (
            <Globe size={12} className={styles.playIconGlyph} />
          ) : activeItem.kind === 'tutorial' ? (
            <Play size={12} className={styles.playIconGlyph} />
          ) : (
            <Sparkles size={12} className={styles.playIconGlyph} />
          )}
        </span>

        <span className={styles.textStack}>
          {activeItem.kind === 'community-video' ? (
            <>
              <span className={styles.topRow}>
                <span
                  className={styles.changelogLabel}
                  title={activeItem.video.headline}
                >
                  {activeItem.video.headline}
                </span>
                <span className={styles.communityBadge}>Community</span>
              </span>
              <span className={styles.title}>
                {[activeItem.video.speakerName, activeItem.video.eventCity].filter(Boolean).join(' · ')}
              </span>
            </>
          ) : activeItem.kind === 'tutorial' ? (
            <>
              <span className={styles.topRow}>
                <span className={styles.quip} title={activeItem.video.quip}>
                  &quot;{activeItem.video.quip}&quot;
                </span>
                <span className={styles.duration}>· {activeItem.video.duration}</span>
              </span>
              <span className={styles.title} title={activeItem.video.title}>
                {activeItem.video.title}
              </span>
            </>
          ) : (
            <>
              <span className={styles.topRow}>
                <span
                  className={styles.changelogLabel}
                  title={activeItem.highlight.title}
                >
                  {activeItem.highlight.title}
                </span>
                <span className={styles.newBadge}>New</span>
              </span>
              {activeItem.highlight.description && (
                <span
                  className={styles.title}
                  title={activeItem.highlight.description}
                >
                  {activeItem.highlight.description}
                </span>
              )}
            </>
          )}
        </span>
      </button>

      <button
        type="button"
        className={styles.dismissButton}
        onClick={handleDismiss}
        data-testid="tutorial-nudge-dismiss"
        aria-label={dismissLabel}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
});

TutorialNudge.displayName = 'TutorialNudge';
