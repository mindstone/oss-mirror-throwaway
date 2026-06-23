import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { cn } from '@renderer/lib/utils';
import type { FacetOption } from '../hooks/useFilterFacets';
import { normalizeFacetValue } from '../utils/facets';
import styles from './LibraryLensBar.module.css';

type LibraryFilterPopoverProps = {
  facets: readonly FacetOption[];
  activeFacetValue: string;
  filterLabel: string;
  onFacetChange: (id: string) => void;
  disabled?: boolean;
};

function getNextIndex(index: number, count: number, direction: 'previous' | 'next'): number {
  if (count <= 0) return 0;
  if (direction === 'next') {
    return (index + 1) % count;
  }
  return (index - 1 + count) % count;
}

function getFacetTestId(id: string): string {
  return `library-facet-chip-${id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export function LibraryFilterPopover({
  facets,
  activeFacetValue,
  filterLabel,
  onFacetChange,
  disabled = false,
}: LibraryFilterPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const hasVisibleFacets = facets.length > 1;
  const isDisabled = disabled || !hasVisibleFacets;
  const normalizedActiveFacet = normalizeFacetValue(activeFacetValue) ?? 'all';

  const activeFacet = useMemo(
    () => facets.find((facet) => normalizeFacetValue(facet.id) === normalizedActiveFacet) ?? null,
    [facets, normalizedActiveFacet],
  );

  const triggerIsActive = normalizedActiveFacet !== 'all' && activeFacet != null;
  const triggerLabel = triggerIsActive ? activeFacet.label : 'Filter';
  const tooltipLabel = triggerIsActive ? `Filter by: ${activeFacet.label}` : 'Filter results';

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-end',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context, { enabled: !isDisabled });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  const focusChipAtIndex = useCallback((index: number) => {
    chipRefs.current[index]?.focus();
  }, []);

  const handleChipKeyDown = useCallback((index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusChipAtIndex(getNextIndex(index, facets.length, 'next'));
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusChipAtIndex(getNextIndex(index, facets.length, 'previous'));
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      focusChipAtIndex(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      focusChipAtIndex(facets.length - 1);
    }
  }, [facets.length, focusChipAtIndex]);

  const handleFacetSelect = useCallback((id: string) => {
    onFacetChange(id);
    setIsOpen(false);
  }, [onFacetChange]);

  useEffect(() => {
    if (!isOpen) return;
    const activeIndex = facets.findIndex((facet) => normalizeFacetValue(facet.id) === normalizedActiveFacet);
    const initialIndex = activeIndex >= 0 ? activeIndex : 0;
    const rafId = window.requestAnimationFrame(() => {
      focusChipAtIndex(initialIndex);
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [facets, focusChipAtIndex, isOpen, normalizedActiveFacet]);

  useEffect(() => {
    if (!isDisabled || !isOpen) return;
    setIsOpen(false);
  }, [isDisabled, isOpen]);

  if (!hasVisibleFacets) {
    return null;
  }

  return (
    <>
      <Tooltip content={tooltipLabel} placement="bottom" disabled={isOpen}>
        <Button
          ref={refs.setReference}
          type="button"
          variant="ghost"
          size="sm"
          className={cn(styles.filterTrigger, triggerIsActive && styles.filterTriggerActive)}
          aria-label={tooltipLabel}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          disabled={isDisabled}
          data-testid="library-filter-trigger"
          {...getReferenceProps()}
        >
          <SlidersHorizontal size={14} aria-hidden />
          <span className={styles.filterTriggerLabel}>{triggerLabel}</span>
          <ChevronDown
            size={14}
            aria-hidden
            className={cn(styles.filterTriggerChevron, isOpen && styles.filterTriggerChevronOpen)}
          />
        </Button>
      </Tooltip>
      {isOpen ? (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={styles.filterPopover}
            data-testid="library-filter-popover"
            {...getFloatingProps()}
          >
            <p className={styles.filterPopoverHeader}>Filter by {filterLabel}</p>
            <div className={styles.filterPopoverChips} role="radiogroup" aria-label={`Filter by ${filterLabel}`}>
              {facets.map((facet, index) => {
                const isActive = normalizeFacetValue(facet.id) === normalizedActiveFacet;
                return (
                  <Button
                    key={facet.id}
                    ref={(node) => {
                      chipRefs.current[index] = node;
                    }}
                    type="button"
                    variant="ghost"
                    size="sm"
                    role="radio"
                    aria-checked={isActive}
                    tabIndex={isActive ? 0 : -1}
                    className={cn(styles.segmentedChip, isActive && styles.segmentedChipActive)}
                    data-testid={getFacetTestId(facet.id)}
                    title={facet.tooltip}
                    onClick={() => handleFacetSelect(facet.id)}
                    onKeyDown={(event) => handleChipKeyDown(index, event)}
                  >
                    <span>{facet.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
}
