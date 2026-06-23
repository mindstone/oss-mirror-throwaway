import { memo, useEffect, useState, useMemo } from 'react';
import { X, ChevronRight, Info } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import scoutCharacter from '@renderer/assets/characters/scout.png';
import { useSettings } from '@renderer/features/settings/SettingsProvider';
import { useUserFeatureProfile, calculateRelevanceScore } from '../hooks/useUserFeatureProfile';
import { 
  parseChangelogHighlights, 
  isNewerVersion,
  type ChangelogHighlight, 
  type ChangeCategory 
} from '../utils/changelogParser';
import { getAuthorAvatar } from '../utils/teamAvatars';
import styles from './WhatsNewWidget.module.css';

// Re-export types for consumers
export type { ChangelogHighlight, ChangeCategory };

interface WhatsNewWidgetProps {
  /** Callback to open the full WhatsNewDialog */
  onSeeAll: () => void;
  /** Callback when user wants to try a feature - starts guided conversation */
  onTryFeature?: (highlight: ChangelogHighlight) => void;
}

/* ─────────────────────────────────────────────────────────────
   HighlightCard - Extracted sub-component for highlight cards
   Fixes accessibility issue with nested interactive elements
   ───────────────────────────────────────────────────────────── */

interface HighlightCardProps {
  highlight: ChangelogHighlight;
  variant?: 'personalized' | 'feedback' | 'tools';
  isExiting?: boolean;
  onTryFeature: (highlight: ChangelogHighlight) => void;
}

const HighlightCard = ({ highlight, variant, isExiting, onTryFeature }: HighlightCardProps) => {
  const cardClassName = cn(
    styles.highlightCard,
    isExiting && styles.highlightCardExiting
  );
  
  const ariaLabel = `Try new feature: ${highlight.title}${
    variant === 'personalized' ? ' (recommended for you)' : ''
  }${highlight.author ? ` by ${highlight.author}` : ''}`;
  
  // Determine badge text based on variant
  const getBadgeText = () => {
    if (variant === 'personalized') return 'Update for you';
    return 'General update';
  };
  
  return (
    <div className={cardClassName}>
      <button 
        type="button"
        className={styles.cardMainAction}
        onClick={() => onTryFeature(highlight)}
        aria-label={ariaLabel}
      >
        <div className={styles.cardContent}>
          {/* Badge left-aligned above title */}
          <span className={cn(
            styles.cardBadge,
            variant === 'personalized' && styles.cardBadgeForYou
          )}>
            {getBadgeText()}
          </span>
          {/* Title on its own line */}
          <span className={styles.cardTitle}>
            <span className={styles.cardTitleText}>{highlight.title}</span>
            {highlight.detail && (
              <Tooltip
                content={highlight.detail}
                placement="top"
                maxWidth="360px"
                delayShow={300}
                clickToToggle
              >
                <span
                  className={styles.detailIcon}
                  onClick={(e) => e.stopPropagation()}
                  role="button"
                  tabIndex={0}
                  aria-label="More details"
                >
                  <Info size={12} />
                </span>
              </Tooltip>
            )}
          </span>
          {/* Description - fixed 2 lines max */}
          {highlight.description && (
            <span className={styles.cardDescription}>
              {highlight.description.length > 80 
                ? `${highlight.description.slice(0, 80)}...` 
                : highlight.description}
            </span>
          )}
          {/* Author attribution */}
          {highlight.author && (
            <div className={styles.authorAttribution}>
              <img 
                src={getAuthorAvatar(highlight.author)} 
                alt=""
                className={styles.authorAvatar}
                onError={(e) => {
                  // Hide image on error, initials will show via CSS
                  e.currentTarget.style.display = 'none';
                }}
              />
              <span className={styles.authorName}>Built by <strong>{highlight.author}</strong></span>
            </div>
          )}
        </div>
      </button>
      {/* Hover actions - appears on card hover like agent sidebar cards */}
      <div className={styles.hoverActions}>
        <button 
          type="button"
          className={styles.tryItButton}
          onClick={(e) => {
            e.stopPropagation();
            onTryFeature(highlight);
          }}
          aria-label={`Try ${highlight.title}`}
        >
          <span>Try it</span>
          <ChevronRight size={12} />
        </button>
      </div>
    </div>
  );
};

/**
 * Sidebar widget that displays "What's New" highlights after an app update.
 * Similar in structure to the old OnboardingChecklistWidget (removed Feb 2026).
 * 
 * Visibility rules:
 * - Hides if user has already seen this version
 * - Hides during active onboarding (steps 1-4)
 * - Hides if onboarding not yet completed
 * - Hides if no changelog highlights available
 * 
 * @see docs/plans/finished/260106_changelog_whats_new_ux_enhancement.md
 */
export const WhatsNewWidget = memo(({ onSeeAll, onTryFeature }: WhatsNewWidgetProps) => {
  const { settings, saveSettingsWith } = useSettings();
  const appVersion = window.electronEnv?.appVersion;
  
  // State for fetched highlights (raw, unpersonalized)
  const [rawHighlights, setRawHighlights] = useState<ChangelogHighlight[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Determine visibility conditions BEFORE fetching to avoid unnecessary IPC calls
  const checklist = settings?.onboardingChecklist;
  const onboardingActive = checklist && 
    checklist.step !== 'complete' && 
    checklist.step !== 'dismissed';
  
  // Normalize version comparison (handle potential "v" prefix in appVersion)
  const normalizedAppVersion = appVersion?.replace(/^v/, '');
  
  // Use semver comparison to properly handle version edge cases (e.g., 0.3.10 vs 0.3.9)
  // User has "seen" if lastSeenVersion >= currentVersion (handles downgrades gracefully)
  const lastSeenVersion = settings?.lastSeenChangelogVersion;
  const alreadySeen = Boolean(
    lastSeenVersion && 
    normalizedAppVersion && 
    !isNewerVersion(normalizedAppVersion, lastSeenVersion)
  );
  
  // Calculate if widget should potentially be visible
  const shouldFetch = Boolean(
    settings?.onboardingCompleted &&
    !alreadySeen &&
    !onboardingActive &&
    normalizedAppVersion
  );
  
  // Only fetch user profile when widget will show (avoids unnecessary MCP IPC)
  const userProfile = useUserFeatureProfile(shouldFetch);
  
  // Only fetch changelog when the widget might actually be shown
  useEffect(() => {
    if (!shouldFetch) {
      setLoading(false);
      return;
    }
    
    const fetchChangelog = async () => {
      setLoading(true);
      setRawHighlights([]); // Clear previous highlights to avoid stale data
      try {
        const result = await window.miscApi.getChangelog();
        if (result.success && result.content) {
          const parsed = parseChangelogHighlights(result.content, normalizedAppVersion);
          setRawHighlights(parsed);
        }
      } catch {
        // Silently fail - widget just won't show
      } finally {
        setLoading(false);
      }
    };
    
    fetchChangelog();
  }, [shouldFetch, normalizedAppVersion]);
  
  // Get dismissed highlights for current version
  const dismissedHighlights = useMemo(() => {
    if (!normalizedAppVersion || !settings?.dismissedWhatsNewHighlights) {
      return new Set<string>();
    }
    return new Set(settings.dismissedWhatsNewHighlights[normalizedAppVersion] ?? []);
  }, [normalizedAppVersion, settings?.dismissedWhatsNewHighlights]);
  
  // Personalize highlights based on user profile
  // Sort by relevance score, mark top matches as "personalized"
  // Filter out dismissed highlights
  const highlights = useMemo(() => {
    if (rawHighlights.length === 0 || userProfile.loading) {
      return rawHighlights.filter(h => !dismissedHighlights.has(h.title));
    }
    
    // Calculate relevance scores
    const scored = rawHighlights
      .filter(h => !dismissedHighlights.has(h.title))
      .map((h) => ({
        ...h,
        relevanceScore: calculateRelevanceScore(h, userProfile),
      }));
    
    // Sort by relevance (highest first)
    scored.sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
    
    // Mark items with score > 65 as personalized (above base + some matches)
    const PERSONALIZATION_THRESHOLD = 65;
    return scored.map((h) => ({
      ...h,
      isPersonalized: (h.relevanceScore ?? 0) >= PERSONALIZATION_THRESHOLD,
    }));
  }, [rawHighlights, userProfile, dismissedHighlights]);
  
  // Track items that are animating out (must be before early return)
  const [exitingItems, setExitingItems] = useState<Set<string>>(new Set());
  
  // Don't show if conditions not met or no highlights
  if (!shouldFetch || loading || highlights.length === 0) return null;
  
  const handleDismiss = () => {
    void saveSettingsWith((draft) => ({
      ...draft,
      lastSeenChangelogVersion: normalizedAppVersion ?? null
    }));
  };
  
  const handleSeeAll = () => {
    // Don't mark as seen - user must explicitly dismiss with X button
    onSeeAll();
  };
  
  // Group highlights by category for rendering with section headers
  const forYou = highlights.filter(h => h.isPersonalized);
  const nonPersonalized = highlights.filter(h => !h.isPersonalized);
  
  // Show max 3 items total, prioritizing "Update for you" items
  // "Update for you" items can take all 3 slots if available
  const maxTotal = 3;
  let remaining = maxTotal;
  
  // Take up to 3 from "For You" (prioritize personalized)
  const displayForYou = forYou.slice(0, Math.min(forYou.length, remaining));
  remaining -= displayForYou.length;
  
  // Fill remaining slots with non-personalized items
  const displayGeneral = nonPersonalized.slice(0, remaining);
  
  const totalDisplayed = displayForYou.length + displayGeneral.length;
  const moreCount = highlights.length - totalDisplayed;
  
  // Handle clicking on a highlight card - pass full highlight for guided conversation
  // Trigger exit animation, then dismiss the item and navigate
  const handleTryFeature = (highlight: ChangelogHighlight) => {
    // Start exit animation
    setExitingItems(prev => new Set(prev).add(highlight.title));
    
    // After animation completes, persist dismissal and trigger navigation
    setTimeout(() => {
      // Persist the dismissal
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
      
      // Now trigger the navigation/feature callback
      if (onTryFeature) {
        onTryFeature(highlight);
      }
    }, 300); // Match animation duration (280ms + buffer)
  };
  
  return (
    <div className={styles.widget} data-testid="whats-new-widget">
      {/* Header with icon, title, version, and dismiss button */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <img 
            src={scoutCharacter} 
            alt="" 
            className={styles.headerCharacter}
          />
          <span className={styles.title}>What's New</span>
          <span className={styles.versionBadge}>v{normalizedAppVersion}</span>
        </div>
        <button
          type="button"
          className={styles.dismissButton}
          onClick={handleDismiss}
          aria-label="Dismiss What's New"
          title="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
      
      {/* Community-driven subcopy */}
      <p className={styles.subcopy}>These changes have been shaped by you.</p>
      
      {/* Highlight cards - all displayed without section headers */}
      <div className={styles.content}>
        <div className={styles.highlightCards}>
          {/* Personalized highlights first with "Update for you" badge */}
          {displayForYou.map((highlight, index) => (
            <HighlightCard
              key={`foryou-${index}-${highlight.title}`}
              highlight={highlight}
              variant="personalized"
              isExiting={exitingItems.has(highlight.title)}
              onTryFeature={handleTryFeature}
            />
          ))}
          
          {/* General/non-personalized items */}
          {displayGeneral.map((highlight, index) => (
            <HighlightCard
              key={`general-${index}-${highlight.title}`}
              highlight={highlight}
              isExiting={exitingItems.has(highlight.title)}
              onTryFeature={handleTryFeature}
            />
          ))}
        </div>
        
        {/* Footer - cleaner "View all changes" pattern */}
        {moreCount > 0 && (
          <button
            type="button"
            className={styles.seeAllButton}
            onClick={handleSeeAll}
            aria-label={`View all ${highlights.length} changes`}
          >
            <span className={styles.seeAllText}>View all {highlights.length} changes</span>
            <ChevronRight size={12} className={styles.seeAllChevron} />
          </button>
        )}
      </div>
    </div>
  );
});

WhatsNewWidget.displayName = 'WhatsNewWidget';
