import { useState, useEffect, useCallback, useRef } from 'react';
import { MapPin, ArrowRight, Users, Mic, Pizza } from 'lucide-react';
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
import type { CommunityEventCardData } from '../../../core/services/communityEventsTypes';
import styles from './CommunityEventCard.module.css';

const ORGANIZER_INTEREST_URL = 'https://community-admin.mindstone.ai/interest';

function openExternalUrl(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Format minutes into a human-friendly duration.
 * Examples: 45 → "45 minutes", 90 → "1.5 hours", 180 → "3 hours"
 */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

// ─────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────

interface NearbyEventCardProps {
  data: CommunityEventCardData;
}

function NearbyEventCard({ data }: NearbyEventCardProps) {
  const nearbyEvent = data.nearbyEvent;
  const [confirmDismissOpen, setConfirmDismissOpen] = useState(false);
  const [imageError, setImageError] = useState(false);
  const dismissButtonRef = useRef<HTMLButtonElement>(null);

  const event = nearbyEvent?.event;
  const distanceLabel = nearbyEvent?.distanceLabel ?? '';
  const daysUntil = nearbyEvent?.daysUntil ?? 0;
  const spotsLeft = nearbyEvent?.spotsLeft ?? null;
  const registered = nearbyEvent?.registered ?? 0;
  const speakerCta = data.speakerCta;

  const eventId = event?.id ?? '';
  const slug = event?.slug ?? '';
  const handleAttend = useCallback(() => {
    tracking.spark.communityEvent.clicked(eventId);
    openExternalUrl(`https://community.mindstone.com/events/${slug}`);
  }, [eventId, slug]);

  const handleDismiss = useCallback(() => {
    tracking.spark.communityEvent.dismissed(eventId);
    setConfirmDismissOpen(true);
  }, [eventId]);

  const handleConfirmDismiss = useCallback(async () => {
    setConfirmDismissOpen(false);
    tracking.spark.communityEvent.suppressed();
    try {
      await window.communityEventsApi.suppress({ suppress: true });
    } catch {
      // Non-critical — suppress failed, card will show again next time
    }
  }, []);

  const handleSpeakerCta = useCallback(() => {
    tracking.spark.communityEvent.speakerCtaClicked(speakerCta?.isPersonalized ?? false);
    openExternalUrl(ORGANIZER_INTEREST_URL);
  }, [speakerCta?.isPersonalized]);

  const handleImageError = useCallback(() => {
    setImageError(true);
  }, []);

  return (
    <>
      {/* Hidden img for error detection (CSS background-image doesn't fire onerror) */}
      {event?.imageUrl && !imageError && (
        <img
          src={event.imageUrl}
          alt=""
          onError={handleImageError}
          style={{ display: 'none' }}
          aria-hidden
        />
      )}

      {/* Full-bleed image card — falls back to solid gradient when image fails */}
      <div
        className={`${styles.imageCard}${imageError ? ` ${styles.imageCardFallback}` : ''}`}
        style={!imageError && event?.imageUrl ? { backgroundImage: `url(${event.imageUrl})` } : undefined}
      >
        <div className={styles.imageOverlay}>
          {/* Distance badge */}
          <span className={styles.distanceBadge}>
            <MapPin className={styles.distanceBadgeIcon} aria-hidden />
            {distanceLabel}
          </span>

          {/* Event details */}
          <p className={styles.eventMeta}>
            {event?.locationShort} — in {daysUntil} {daysUntil === 1 ? 'day' : 'days'}
          </p>
          <h3 className={styles.eventName}>{event?.name}</h3>
          <p className={styles.socialProof}>
            <span>{registered} people going</span>
            {spotsLeft !== null && spotsLeft <= 20 && (
              <>
                <span>·</span>
                <span className={styles.spotsLeft}>{spotsLeft} spots left</span>
              </>
            )}
          </p>

          {/* Action row */}
          <div className={styles.actionRow}>
            <Button
              size="sm"
              className={styles.ctaButton}
              onClick={handleAttend}
            >
              Grab your spot
            </Button>
            <button
              ref={dismissButtonRef}
              type="button"
              className={styles.dismissLink}
              onClick={handleDismiss}
            >
              Not for me
            </button>
          </div>
        </div>
      </div>

      {/* Speaker CTA section */}
      {speakerCta && (
        <div className={styles.speakerCta}>
          <p className={styles.speakerCtaText}>
            {speakerCta.isPersonalized
              ? `"${speakerCta.reasoning} — ${formatMinutes(speakerCta.totalMinutes)} of work. The audience would love it."`
              : 'Got a workflow you\'re proud of? The stage is yours.'}
          </p>
          <button
            type="button"
            className={styles.speakerCtaLink}
            onClick={handleSpeakerCta}
          >
            Want to present?
            <ArrowRight className={styles.speakerCtaArrow} aria-hidden />
          </button>
        </div>
      )}

      {/* Dismiss confirmation dialog */}
      <Dialog
        open={confirmDismissOpen}
        onOpenChange={(open) => {
          setConfirmDismissOpen(open);
          // Return focus to dismiss button when dialog closes
          if (!open) {
            requestAnimationFrame(() => dismissButtonRef.current?.focus());
          }
        }}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Stop showing events near you?</DialogTitle>
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
              Yes, I&apos;m antisocial
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NoEventCard({ data }: { data: CommunityEventCardData }) {
  const handleOrganizerCta = useCallback(() => {
    tracking.spark.communityEvent.organizerCtaClicked();
    openExternalUrl(data.organizerUrl);
  }, [data.organizerUrl]);

  return (
    <div className={styles.noEventCard}>
      <h3 className={styles.noEventTitle}>
        The AI-curious people near you haven&apos;t met each other yet.
      </h3>
      <p className={styles.noEventBody}>
        Mindstone events are practical, demo-driven evenings where people share
        real workflows — what they learned building with AI, how they use it
        to be more productive, and where the future of work is heading.
      </p>

      <ul className={styles.noEventPerks}>
        <li className={styles.noEventPerk}>
          <MapPin className={styles.noEventPerkIcon} aria-hidden />
          <span>We help find a venue</span>
        </li>
        <li className={styles.noEventPerk}>
          <Users className={styles.noEventPerkIcon} aria-hidden />
          <span>We promote it to the local community</span>
        </li>
        <li className={styles.noEventPerk}>
          <Mic className={styles.noEventPerkIcon} aria-hidden />
          <span>Three demo slots, ready to fill</span>
        </li>
        <li className={styles.noEventPerk}>
          <Pizza className={styles.noEventPerkIcon} aria-hidden />
          <span>Pizza &amp; drinks on us</span>
        </li>
      </ul>

      <Button
        size="sm"
        variant="outline"
        className={styles.noEventButton}
        onClick={handleOrganizerCta}
      >
        Bring one to your city
        <ArrowRight className={styles.noEventArrow} aria-hidden />
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────

/**
 * Community event card for The Spark.
 *
 * Self-contained: fetches its own data on mount, handles all visual states
 * (nearby event, no event, suppressed), and manages dismiss/suppress flows.
 *
 * @see docs/plans/260402_spark_community_events_nearby.md
 */
export function CommunityEventCard() {
  const [cardData, setCardData] = useState<CommunityEventCardData | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchCardData() {
      try {
        const data = await window.communityEventsApi.getCardData({});
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

  // Track when card data loads and type is trackable
  const trackedTypeRef = useRef<string | null>(null);
  useEffect(() => {
    if (cardData && cardData.type !== 'suppressed' && trackedTypeRef.current !== cardData.type) {
      trackedTypeRef.current = cardData.type;
      tracking.spark.communityEvent.shown(cardData.type);
    }
  }, [cardData]);

  // Nothing to show while loading or on error
  if (!cardData) return null;

  // Suppressed — user opted out
  if (cardData.type === 'suppressed') return null;

  return (
    <section className={styles.section} data-testid="spark-community-event-card">
      {cardData.type === 'nearby-event' && cardData.nearbyEvent && (
        <NearbyEventCard data={cardData} />
      )}
      {cardData.type === 'no-event' && (
        <NoEventCard data={cardData} />
      )}
    </section>
  );
}
