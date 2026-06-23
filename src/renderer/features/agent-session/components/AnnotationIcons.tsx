/**
 * AnnotationIcons
 *
 * Renders positioned comment icons at the end of each annotation highlight.
 * Uses position: absolute within the scroll container so icons scroll naturally.
 * Clicking an icon opens the annotation for editing.
 */

import { memo } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquareText } from 'lucide-react';
import type { AnnotationPosition } from '../hooks/useAnnotationHighlights';
import styles from './AnnotationIcons.module.css';

interface AnnotationIconsProps {
  positions: AnnotationPosition[];
  scrollContainer: HTMLElement | null;
  onClickAnnotation: (annotationId: string, rect: DOMRect) => void;
}

const AnnotationIconsComponent = ({
  positions,
  scrollContainer,
  onClickAnnotation,
}: AnnotationIconsProps) => {
  if (positions.length === 0 || !scrollContainer) return null;

  const containerRect = scrollContainer.getBoundingClientRect();

  const icons = (
    <div className={styles.container}>
      {positions.map((pos) => {
        // Convert viewport-relative coords to scroll-container-relative coords
        const top = pos.rect.top - containerRect.top + scrollContainer.scrollTop;
        const left = pos.rect.right - containerRect.left + scrollContainer.scrollLeft;

        return (
          <button
            key={pos.annotationId}
            className={styles.icon}
            style={{ top, left }}
            onClick={() => onClickAnnotation(pos.annotationId, pos.rect)}
            aria-label="View annotation"
          >
            <MessageSquareText size={14} />
          </button>
        );
      })}
    </div>
  );

  // Render into the scroll container so icons scroll with content
  return createPortal(icons, scrollContainer);
};

AnnotationIconsComponent.displayName = 'AnnotationIcons';

export const AnnotationIcons = memo(AnnotationIconsComponent);
