import { memo, type FC } from 'react';
import { Star, CheckCircle2 } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import styles from './ConversationCategoryIndicator.module.css';

type ConversationCategory = 'active' | 'favourites' | 'done';

interface ConversationCategoryIndicatorProps {
  isStarred: boolean;
  isActive: boolean;
  /** When true, the actions toolbar is visible — shifts indicator down to stay below the actions menu */
  toolbarVisible?: boolean;
}

/**
 * Derives the conversation category from starred/active state.
 * Matches the LIFT semantics from useSessionHistoryView:
 * - Starred → Starred (regardless of active state)
 * - Active (not starred) → Active
 * - Neither → Done
 */
function deriveCategory(isStarred: boolean, isActive: boolean): ConversationCategory {
  if (isStarred) return 'favourites';
  if (isActive) return 'active';
  return 'done';
}

/**
 * Subtle indicator showing which category (Starred/Active/Done)
 * the current conversation belongs to. Positioned below the conversation
 * actions menu (3-dots) in the top-right of the main view.
 *
 * Design decisions:
 * - Active is the default/expected state, so we don't show an indicator for it
 * - Starred shows a filled star icon (matches sidebar)
 * - Done shows a check icon with muted styling
 * - Intentionally subtle: small, muted colors, only visible on closer inspection
 */
export const ConversationCategoryIndicator: FC<ConversationCategoryIndicatorProps> = memo(
  ({ isStarred, isActive, toolbarVisible = false }) => {
    const category = deriveCategory(isStarred, isActive);
    const containerClass = `${styles.container} ${toolbarVisible ? styles.containerBelowToolbar : ''}`.trim();

    // Don't show indicator for Active - it's the default state
    if (category === 'active') {
      return null;
    }

    if (category === 'favourites') {
      return (
        <div className={containerClass}>
          <Tooltip content="Starred" placement="left">
            <div className={`${styles.indicator} ${styles.favourites}`}>
              <Star size={14} fill="currentColor" strokeWidth={0} aria-hidden />
              <span className={styles.srOnly}>Starred conversation</span>
            </div>
          </Tooltip>
        </div>
      );
    }

    // category === 'done' (internal value; displays as "Done")
    return (
      <div className={containerClass}>
        <Tooltip content="Done" placement="left">
          <div className={`${styles.indicator} ${styles.done}`}>
            <CheckCircle2 size={14} aria-hidden />
            <span className={styles.srOnly}>Done conversation</span>
          </div>
        </Tooltip>
      </div>
    );
  }
);

ConversationCategoryIndicator.displayName = 'ConversationCategoryIndicator';
