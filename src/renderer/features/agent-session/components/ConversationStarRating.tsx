import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import styles from './ConversationStarRating.module.css';

type ConversationStarValue = 1 | 2 | 3 | 4 | 5;

type ConversationStarRatingProps = {
  value: number | null;
  onSelect: (rating: ConversationStarValue) => void;
  size?: 'sm' | 'md';
  testIdPrefix?: string;
};

const STAR_VALUES: readonly ConversationStarValue[] = [1, 2, 3, 4, 5];

function isValidRating(value: number | null): value is ConversationStarValue {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 5;
}

function getStarAriaLabel(value: ConversationStarValue): string {
  if (value === 1) return '1 star, Bad';
  if (value === 5) return '5 stars, Great';
  return `${value} stars`;
}

function clampRating(value: number): ConversationStarValue {
  if (value <= 1) return 1;
  if (value >= 5) return 5;
  return value as ConversationStarValue;
}

export function ConversationStarRating({
  value,
  onSelect,
  size = 'md',
  testIdPrefix = 'conversation-star-rating',
}: ConversationStarRatingProps) {
  const descriptionId = useId();
  const groupRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedRating = isValidRating(value) ? value : null;
  const [hoveredRating, setHoveredRating] = useState<ConversationStarValue | null>(null);
  const [focusedRating, setFocusedRating] = useState<ConversationStarValue>(selectedRating ?? 1);
  const [isFocusWithin, setIsFocusWithin] = useState(false);

  const displayedRating = useMemo(() => {
    if (hoveredRating !== null) return hoveredRating;
    if (isFocusWithin) return focusedRating;
    return selectedRating;
  }, [focusedRating, hoveredRating, isFocusWithin, selectedRating]);

  const tabStopRating = isFocusWithin ? focusedRating : (selectedRating ?? 1);

  const focusRating = useCallback((rating: ConversationStarValue) => {
    const nextButton = buttonRefs.current[rating - 1];
    nextButton?.focus();
  }, []);

  const handleMoveFocus = useCallback((target: ConversationStarValue) => {
    setHoveredRating(null);
    setFocusedRating(target);
    setIsFocusWithin(true);
    focusRating(target);
  }, [focusRating]);

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Rate this response"
      aria-describedby={descriptionId}
      className={`${styles.root} ${size === 'sm' ? styles.rootSm : styles.rootMd}`}
      data-testid={`${testIdPrefix}-group`}
    >
      {STAR_VALUES.map((rating) => {
        const isFilled = displayedRating !== null && rating <= displayedRating;
        return (
          <button
            key={rating}
            ref={(element) => {
              buttonRefs.current[rating - 1] = element;
            }}
            type="button"
            role="radio"
            aria-label={getStarAriaLabel(rating)}
            aria-checked={displayedRating === rating}
            tabIndex={tabStopRating === rating ? 0 : -1}
            className={styles.starButton}
            data-testid={`${testIdPrefix}-star-${rating}`}
            data-rating={rating}
            data-filled={isFilled ? 'true' : 'false'}
            onClick={() => {
              setFocusedRating(rating);
              setIsFocusWithin(true);
              onSelect(rating);
            }}
            onFocus={() => {
              setFocusedRating(rating);
              setIsFocusWithin(true);
            }}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget as Node | null;
              const stillWithinGroup = nextTarget ? groupRef.current?.contains(nextTarget) : false;
              if (stillWithinGroup) return;
              setIsFocusWithin(false);
              setFocusedRating(selectedRating ?? 1);
              setHoveredRating(null);
            }}
            onMouseEnter={() => setHoveredRating(rating)}
            onMouseLeave={() => setHoveredRating(null)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                event.preventDefault();
                handleMoveFocus(clampRating(focusedRating + 1));
                return;
              }

              if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                event.preventDefault();
                handleMoveFocus(clampRating(focusedRating - 1));
                return;
              }

              if (event.key === 'Home') {
                event.preventDefault();
                handleMoveFocus(1);
                return;
              }

              if (event.key === 'End') {
                event.preventDefault();
                handleMoveFocus(5);
                return;
              }

              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(focusedRating);
              }
            }}
          >
            <Star
              aria-hidden="true"
              className={`${styles.starIcon} ${isFilled ? styles.starFilled : styles.starEmpty}`}
            />
          </button>
        );
      })}
      <p id={descriptionId} className={styles.description}>
        Choose a rating. A short note is required before it is sent.
      </p>
    </div>
  );
}

ConversationStarRating.displayName = 'ConversationStarRating';
