import { useState, useEffect, useCallback, useRef } from 'react';
import { Play, ArrowUpRight, Globe } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@renderer/components/ui/Dialog';
import { tracking } from '@renderer/src/tracking';
import type { VideoRecsCardData, VideoRecommendation } from '../../../core/services/communityVideoRecsTypes';
import styles from './CommunityVideoRecsCard.module.css';

/**
 * Format an ISO date string to "Mar 2026" style.
 */
function formatEventDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

/**
 * Build the speaker · city · date meta line.
 * Omits empty segments gracefully.
 */
function buildMetaLine(video: VideoRecommendation): string {
  const parts: string[] = [];
  if (video.speakerName) parts.push(video.speakerName);
  if (video.eventCity) parts.push(video.eventCity);
  if (video.eventDate) {
    const formatted = formatEventDate(video.eventDate);
    if (formatted) parts.push(formatted);
  }
  return parts.join(' · ');
}

/**
 * Validate that a URL is safe to open (https only).
 */
function isValidUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Video Item
// ─────────────────────────────────────────────────────────────

interface VideoItemProps {
  video: VideoRecommendation;
  index: number;
}

function VideoItem({ video, index }: VideoItemProps) {
  const metaLine = buildMetaLine(video);

  const clickUrl = video.eventUrl || video.url;
  const handleClick = useCallback(() => {
    if (isValidUrl(clickUrl)) {
      tracking.spark.communityVideoRecs.videoClicked(video.id, video.headline);
      window.appApi.openUrl(clickUrl);
    }
  }, [video.id, video.headline, clickUrl]);

  return (
    <button
      type="button"
      className={styles.videoItem}
      onClick={handleClick}
      aria-label={`Watch: ${video.headline}`}
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className={styles.playIcon}>
        <Play className={styles.playIconSvg} aria-hidden />
      </div>
      <div className={styles.videoContent}>
        <div className={styles.videoTitleRow}>
          <h4 className={styles.videoTitle}>{video.headline}</h4>
          <ArrowUpRight className={styles.externalIcon} aria-hidden />
        </div>
        {metaLine && <p className={styles.videoMeta}>{metaLine}</p>}
        {video.relevanceHint && (
          <p className={styles.relevanceHint}>{video.relevanceHint}</p>
        )}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────

/**
 * Community video recommendations card for The Spark.
 *
 * Self-contained: fetches its own data on mount, handles all visual states
 * (recommendations, suppressed, empty), and manages the dismiss/suppress flow.
 *
 * @see docs/plans/260404_spark_community_video_recommendations.md
 */
export function CommunityVideoRecsCard() {
  const [cardData, setCardData] = useState<VideoRecsCardData | null>(null);
  const [confirmDismissOpen, setConfirmDismissOpen] = useState(false);
  const dismissButtonRef = useRef<HTMLButtonElement>(null);

  // Fetch card data on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchCardData() {
      try {
        const data = await window.communityVideoRecsApi.getCardData({});
        if (!cancelled) {
          setCardData(data);
        }
      } catch {
        // Non-critical — if the fetch fails, just don't show the card
      }
    }

    void fetchCardData();
    return () => { cancelled = true; };
  }, []);

  // Retry when empty — startup bootstrap may not have completed yet.
  // The store read is instant (no LLM call), so retrying is cheap.
  // Only needed on first-ever launch; subsequent launches have persisted data.
  useEffect(() => {
    if (cardData?.type !== 'empty') return;

    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 3;

    const timer = setInterval(async () => {
      retryCount++;
      try {
        const data = await window.communityVideoRecsApi.getCardData({});
        if (!cancelled && data.type === 'recommendations' && data.recommendations.length > 0) {
          setCardData(data);
        }
      } catch { /* non-critical */ }
      if (retryCount >= maxRetries || cancelled) clearInterval(timer);
    }, 30_000);

    return () => { cancelled = true; clearInterval(timer); };
  }, [cardData?.type]);

  // Track when card renders with recommendations (ref guard to avoid double-fire)
  const hasTrackedShownRef = useRef(false);
  useEffect(() => {
    if (
      cardData &&
      cardData.type === 'recommendations' &&
      cardData.recommendations.length > 0 &&
      !hasTrackedShownRef.current
    ) {
      hasTrackedShownRef.current = true;
      tracking.spark.communityVideoRecs.shown();
    }
  }, [cardData]);

  const handleDismiss = useCallback(() => {
    setConfirmDismissOpen(true);
  }, []);

  const handleConfirmDismiss = useCallback(async () => {
    setConfirmDismissOpen(false);
    tracking.spark.communityVideoRecs.suppressed();
    try {
      await window.communityVideoRecsApi.suppress({ suppress: true });
      setCardData((prev) => prev ? { ...prev, type: 'suppressed' } : prev);
    } catch {
      // Non-critical — suppress failed, card will show again next time
    }
  }, []);

  // Nothing to show while loading or on error
  if (!cardData) return null;

  // Suppressed — user opted out
  if (cardData.type === 'suppressed') return null;

  // No recommendations available (automation hasn't run yet)
  if (cardData.type === 'empty' || cardData.recommendations.length === 0) return null;

  return (
    <>
      <section className={styles.card} data-testid="spark-community-video-recs-card">
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerIcon}>
            <Globe className={styles.headerIconSvg} aria-hidden />
          </div>
          <div className={styles.headerText}>
            <h3 className={styles.headerTitle}>
              From the <span className={styles.brandAccent}>#PracticalAI</span> community
            </h3>
            <p className={styles.headerSubtitle}>
              Talks picked for you from {cardData.recommendations[0]?.eventCity
                ? `${new Set(cardData.recommendations.map(v => v.eventCity).filter(Boolean)).size} cities`
                : 'meetups worldwide'}
            </p>
          </div>
        </div>

        {/* Video items */}
        <div className={styles.videoList}>
          {cardData.recommendations.map((video, index) => (
            <VideoItem key={video.id} video={video} index={index} />
          ))}
        </div>

        {/* Footer */}
        <div className={styles.footer}>
          <p className={styles.footerContext}>
            250+ meetups across 30 cities — real demos, real workflows
          </p>
          <button
            ref={dismissButtonRef}
            type="button"
            className={styles.dismissLink}
            onClick={handleDismiss}
          >
            Not for me
          </button>
        </div>
      </section>

      {/* Dismiss confirmation dialog */}
      <Dialog
        open={confirmDismissOpen}
        onOpenChange={(open) => {
          setConfirmDismissOpen(open);
          if (!open) {
            requestAnimationFrame(() => dismissButtonRef.current?.focus());
          }
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Stop showing video picks?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              You can change your mind later in Settings.
            </DialogDescription>
          </DialogBody>
          <DialogFooter className={styles.confirmFooter}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDismissOpen(false)}
            >
              Never mind
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirmDismiss}
            >
              Yes, I have enough tabs open
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
